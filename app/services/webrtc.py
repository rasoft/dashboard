"""WebRTC HDMI capture via aiortc + ffmpeg V4L2 pipe."""

from __future__ import annotations

import asyncio
import fractions
import ipaddress
import logging
import os
import random
import socket
import subprocess
import threading
import time
from typing import Any, Callable, Optional, Sequence

from aiortc import (
    AudioStreamTrack,
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
    VideoStreamTrack,
)
from aiortc.mediastreams import (
    VIDEO_CLOCK_RATE,
    VIDEO_TIME_BASE,
    MediaStreamError,
    MediaStreamTrack,
)
from aiortc.sdp import SessionDescription, candidate_from_sdp, candidate_to_sdp
from av import AudioFrame, VideoFrame
from av.frame import Frame

from app.config import Config
from app.services.delay_record import DelayRing

logger = logging.getLogger(__name__)


def _tune_aiortc_latency() -> None:
    """Raise encoder bitrate caps so 1080p60 is not stuck at ~0.5–1.5 Mbps."""
    try:
        from aiortc.codecs import vpx

        vpx.MIN_BITRATE = 500_000
        vpx.DEFAULT_BITRATE = 6_000_000
        vpx.MAX_BITRATE = 12_000_000
    except Exception as exc:  # noqa: BLE001
        logger.warning("could not raise VP8 bitrate cap: %s", exc)
    try:
        from aiortc.codecs import h264

        h264.MIN_BITRATE = 500_000
        h264.DEFAULT_BITRATE = 6_000_000
        h264.MAX_BITRATE = 12_000_000
    except Exception as exc:  # noqa: BLE001
        logger.warning("could not raise H264 bitrate cap: %s", exc)


_tune_aiortc_latency()

_udp_port_range_applied = False
_udp_port_range_lock = threading.Lock()
_udp_bind_depth = 0
_udp_bind_orig_create = None
_udp_bind_min = 0
_udp_bind_max = 0


def udp_port_range() -> Optional[tuple[int, int]]:
    """Return configured inclusive UDP port range, or None if unrestricted."""
    lo = int(Config.WEBRTC_UDP_PORT_MIN)
    hi = int(Config.WEBRTC_UDP_PORT_MAX)
    if lo <= 0 or hi <= 0:
        return None
    if hi < lo:
        logger.warning(
            "invalid WEBRTC_UDP_PORT range %s-%s; ignoring", lo, hi
        )
        return None
    return lo, hi


def apply_udp_port_range() -> Optional[tuple[int, int]]:
    """Monkey-patch aioice so host ICE sockets bind within WEBRTC_UDP_PORT_*.

    aiortc/aioice normally bind UDP port 0 (OS ephemeral). Restricting the
    range lets operators allowlist a finite UDP window on firewalls.
    """
    global _udp_port_range_applied
    port_range = udp_port_range()
    if port_range is None:
        return None

    with _udp_port_range_lock:
        if _udp_port_range_applied:
            return port_range
        _install_aioice_port_range(port_range[0], port_range[1])
        _udp_port_range_applied = True
        logger.info(
            "WebRTC ICE UDP port range restricted to %s-%s",
            port_range[0],
            port_range[1],
        )
        return port_range


def _install_aioice_port_range(min_port: int, max_port: int) -> None:
    """Patch aioice host-candidate binding to use [min_port, max_port]."""
    global _udp_bind_min, _udp_bind_max
    import aioice.ice as ice_mod

    _udp_bind_min = min_port
    _udp_bind_max = max_port
    original = ice_mod.Connection.get_component_candidates

    async def _bind_in_range(
        loop: asyncio.AbstractEventLoop,
        protocol_factory,
        address: str,
    ):
        ports = list(range(_udp_bind_min, _udp_bind_max + 1))
        random.shuffle(ports)
        last_exc: Optional[OSError] = None
        for port in ports:
            try:
                return await loop.create_datagram_endpoint(
                    protocol_factory, local_addr=(address, port)
                )
            except OSError as exc:
                last_exc = exc
                continue
        raise OSError(
            f"No free UDP port in {_udp_bind_min}-{_udp_bind_max} for {address}"
        ) from last_exc

    async def get_component_candidates(  # type: ignore[no-untyped-def]
        self, component: int, addresses: list[str], timeout: int = 5
    ):
        global _udp_bind_depth, _udp_bind_orig_create
        loop = asyncio.get_running_loop()

        # Re-entrant: nested/overlapping gathers on the same loop share one patch.
        if _udp_bind_depth == 0:
            _udp_bind_orig_create = loop.create_datagram_endpoint

            async def create_datagram_endpoint(
                protocol_factory, local_addr=None, **kwargs
            ):
                if (
                    local_addr is not None
                    and len(local_addr) >= 2
                    and local_addr[1] == 0
                ):
                    return await _bind_in_range(
                        loop, protocol_factory, local_addr[0]
                    )
                assert _udp_bind_orig_create is not None
                return await _udp_bind_orig_create(
                    protocol_factory, local_addr=local_addr, **kwargs
                )

            loop.create_datagram_endpoint = create_datagram_endpoint  # type: ignore[method-assign]

        _udp_bind_depth += 1
        try:
            return await original(self, component, addresses, timeout=timeout)
        finally:
            _udp_bind_depth -= 1
            if _udp_bind_depth == 0 and _udp_bind_orig_create is not None:
                loop.create_datagram_endpoint = _udp_bind_orig_create  # type: ignore[method-assign]
                _udp_bind_orig_create = None

    ice_mod.Connection.get_component_candidates = get_component_candidates


def build_ice_servers() -> list[RTCIceServer]:
    """ICE servers for aiortc (STUN required for WAN/DMZ; TURN optional)."""
    servers: list[RTCIceServer] = []
    if Config.WEBRTC_STUN_URLS:
        servers.append(RTCIceServer(urls=Config.WEBRTC_STUN_URLS))
    if Config.WEBRTC_TURN_URLS:
        servers.append(
            RTCIceServer(
                urls=Config.WEBRTC_TURN_URLS,
                username=Config.WEBRTC_TURN_USERNAME or None,
                credential=Config.WEBRTC_TURN_CREDENTIAL or None,
            )
        )
    return servers


def ice_servers_for_client() -> list[dict[str, Any]]:
    """Browser RTCPeerConnection iceServers JSON."""
    out: list[dict[str, Any]] = []
    if Config.WEBRTC_STUN_URLS:
        out.append({"urls": Config.WEBRTC_STUN_URLS})
    if Config.WEBRTC_TURN_URLS:
        entry: dict[str, Any] = {"urls": Config.WEBRTC_TURN_URLS}
        if Config.WEBRTC_TURN_USERNAME:
            entry["username"] = Config.WEBRTC_TURN_USERNAME
        if Config.WEBRTC_TURN_CREDENTIAL:
            entry["credential"] = Config.WEBRTC_TURN_CREDENTIAL
        out.append(entry)
    return out


def ice_network_info() -> dict[str, Any]:
    """Expose ICE/UDP binding hints for operators and the ice-servers API."""
    port_range = udp_port_range()
    explicit = Config.WEBRTC_ANNOUNCE_IP or None
    info: dict[str, Any] = {
        "udpPortMin": port_range[0] if port_range else None,
        "udpPortMax": port_range[1] if port_range else None,
        "udpPortRangeEnabled": port_range is not None,
        "announceIp": explicit,
        "announceIpMode": "env" if explicit else "request-host",
        "announceReplace": list(Config.WEBRTC_ANNOUNCE_REPLACE) or None,
    }
    return info


def parse_request_host(host_header: str) -> str:
    """Extract hostname/IP from an HTTP Host header (strip port)."""
    host = (host_header or "").strip()
    if not host:
        return ""
    if host.startswith("["):
        end = host.find("]")
        if end != -1:
            return host[1:end]
    # hostname:port or IPv4:port — exactly one colon
    if host.count(":") == 1:
        return host.rsplit(":", 1)[0]
    return host


def resolve_announce_ip(request_host: str = "") -> str:
    """Prefer WEBRTC_ANNOUNCE_IP; otherwise use the browser-facing request Host."""
    explicit = (Config.WEBRTC_ANNOUNCE_IP or "").strip()
    if explicit:
        return explicit

    host = parse_request_host(request_host)
    if not host:
        return ""

    try:
        ipaddress.ip_address(host)
        return host
    except ValueError:
        pass

    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_DGRAM)
        for family, _type, _proto, _canon, sockaddr in infos:
            if family == socket.AF_INET and sockaddr:
                return str(sockaddr[0])
        if infos and infos[0][4]:
            return str(infos[0][4][0])
    except OSError as exc:
        logger.warning("cannot resolve Host %r for ICE announce: %s", host, exc)
    return ""


def _should_rewrite_ip(
    ip: str, announce: str, replace: Sequence[str] | None = None
) -> bool:
    if not announce or not ip or ip == announce:
        return False
    replace_list = list(replace) if replace is not None else list(Config.WEBRTC_ANNOUNCE_REPLACE)
    if replace_list:
        return ip in replace_list
    return True


def rewrite_ice_candidate_sdp(
    cand_sdp: str,
    announce_ip: str = "",
    replace: Sequence[str] | None = None,
) -> str:
    """Rewrite a candidate SDP body for announce IP."""
    announce = (announce_ip or Config.WEBRTC_ANNOUNCE_IP or "").strip()
    if not announce or not cand_sdp:
        return cand_sdp
    body = cand_sdp
    if body.startswith("candidate:"):
        body = body[len("candidate:") :]
    try:
        cand = candidate_from_sdp(body)
    except Exception:  # noqa: BLE001
        return cand_sdp
    changed = False
    if cand.type == "host" and _should_rewrite_ip(cand.ip, announce, replace):
        cand.ip = announce
        changed = True
    if cand.relatedAddress and _should_rewrite_ip(
        cand.relatedAddress, announce, replace
    ):
        cand.relatedAddress = announce
        changed = True
    if not changed:
        return cand_sdp
    out = candidate_to_sdp(cand)
    if cand_sdp.startswith("candidate:"):
        return "candidate:" + out
    return out


def rewrite_sdp_announce_ip(
    sdp: str,
    announce_ip: str = "",
    replace: Sequence[str] | None = None,
) -> str:
    """Rewrite host ICE candidates / c= lines to the announce IP when set."""
    announce = (announce_ip or Config.WEBRTC_ANNOUNCE_IP or "").strip()
    if not announce or not sdp:
        return sdp

    lines_out: list[str] = []
    for line in sdp.splitlines():
        if line.startswith("a=candidate:"):
            body = line[len("a=") :]
            raw = body[len("candidate:") :] if body.startswith("candidate:") else body
            try:
                cand = candidate_from_sdp(raw)
            except Exception:  # noqa: BLE001
                lines_out.append(line)
                continue
            if cand.type == "host":
                if _should_rewrite_ip(cand.ip, announce, replace):
                    cand.ip = announce
                elif cand.ip != announce:
                    # Drop host candidates on other NICs (docker0/virbr0, etc.).
                    continue
            if cand.relatedAddress and _should_rewrite_ip(
                cand.relatedAddress, announce, replace
            ):
                cand.relatedAddress = announce
            lines_out.append("a=candidate:" + candidate_to_sdp(cand))
            continue
        if line.startswith("c=IN IP4 "):
            parts = line.split()
            if len(parts) >= 3 and _should_rewrite_ip(parts[-1], announce, replace):
                parts[-1] = announce
                line = " ".join(parts)
        lines_out.append(line)

    ending = "\r\n" if sdp.endswith("\r\n") else "\n" if sdp.endswith("\n") else ""
    joined = "\r\n".join(lines_out) if "\r\n" in sdp else "\n".join(lines_out)
    return joined + ending


def _local_ice_trickle_messages(
    pc: RTCPeerConnection,
    announce_ip: str = "",
) -> list[dict[str, Any]]:
    """Build Socket.IO hdmi:ice payloads (including end-of-candidates)."""
    if not pc.localDescription or not pc.localDescription.sdp:
        return []

    msgs: list[dict[str, Any]] = []
    sdp = rewrite_sdp_announce_ip(pc.localDescription.sdp, announce_ip=announce_ip)
    desc = SessionDescription.parse(sdp)
    seen: set[tuple[str, str, int]] = set()
    for mline_index, media in enumerate(desc.media):
        mid = media.rtp.muxId if media.rtp and media.rtp.muxId else str(mline_index)
        for cand in media.ice_candidates:
            key = (cand.ip, cand.type, cand.port)
            if key in seen:
                continue
            seen.add(key)
            msgs.append(
                {
                    "candidate": "candidate:" + candidate_to_sdp(cand),
                    "sdpMid": mid,
                    "sdpMLineIndex": mline_index,
                }
            )
        msgs.append(
            {
                "candidate": "",
                "sdpMid": mid,
                "sdpMLineIndex": mline_index,
            }
        )
    return msgs


class FFmpegV4L2Track(VideoStreamTrack):
    """Capture frames from a V4L2 device through an ffmpeg rawvideo pipe.

    USB HDMI capture cards often dequeue empty/corrupt buffers that break
    OpenCV/PyAV MediaPlayer; ffmpeg tolerates them and keeps streaming.
    """

    def __init__(self, device: str, width: int, height: int, capture_fps: int = 60, live_fps: int = 30, delay_ring: Optional[DelayRing] = None):
        super().__init__()
        self.device = device
        self.width = width
        self.height = height
        self.capture_fps = max(1, int(capture_fps))
        self.fps = max(1, int(live_fps))
        self._delay_ring = delay_ring
        self._y_size = width * height
        self._uv_size = (width // 2) * (height // 2)
        self._frame_bytes = self._y_size + 2 * self._uv_size
        self._proc: Optional[subprocess.Popen[bytes]] = None
        self._stderr_thread: Optional[threading.Thread] = None
        self._reader_thread: Optional[threading.Thread] = None
        self._stopped = False
        self._start_lock = threading.Lock()
        self._frame_lock = threading.Lock()
        self._bufs = [bytearray(self._frame_bytes) for _ in range(3)]
        self._latest_idx = 0
        self._busy_idx = -1
        self._have_frame = threading.Event()
        self._frame_index = 0
        self._blank = bytearray(self._frame_bytes)

    def _spawn(self) -> None:
        with self._start_lock:
            if self._proc is not None or self._stopped:
                return
            cmd = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "warning",
                "-fflags",
                "nobuffer",
                "-flags",
                "low_delay",
                "-probesize",
                "32",
                "-analyzeduration",
                "0",
                "-avioflags",
                "direct",
                "-f",
                "v4l2",
                "-input_format",
                "mjpeg",
                "-video_size",
                f"{self.width}x{self.height}",
                "-framerate",
                str(self.capture_fps),
                "-thread_queue_size",
                "1",
                "-rtbufsize",
                "2M",
                "-i",
                self.device,
                "-an",
                "-flush_packets",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "yuv420p",
                "-vsync",
                "0",
                "pipe:1",
            ]
            logger.info("starting capture: %s", " ".join(cmd))
            self._proc = subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
                start_new_session=True,
            )

            def _drain_stderr() -> None:
                assert self._proc is not None and self._proc.stderr is not None
                for line in iter(self._proc.stderr.readline, b""):
                    text = line.decode("utf-8", errors="ignore").strip()
                    if text:
                        logger.warning("ffmpeg: %s", text)

            self._stderr_thread = threading.Thread(
                target=_drain_stderr, name="ffmpeg-stderr", daemon=True
            )
            self._stderr_thread.start()
            self._reader_thread = threading.Thread(
                target=self._reader_loop, name="ffmpeg-v4l2-reader", daemon=True
            )
            self._reader_thread.start()

    def _read_into(self, buf: bytearray) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        view = memoryview(buf)
        filled = 0
        while filled < self._frame_bytes:
            if self._stopped:
                raise MediaStreamError("Track ended")
            chunk = self._proc.stdout.read(self._frame_bytes - filled)
            if not chunk:
                code = self._proc.poll()
                raise MediaStreamError(
                    f"ffmpeg stdout closed (exit={code}) while reading {self.device}"
                )
            view[filled : filled + len(chunk)] = chunk
            filled += len(chunk)

    def _reader_loop(self) -> None:
        write = 1
        try:
            while not self._stopped:
                with self._frame_lock:
                    for i in range(3):
                        if i != self._latest_idx and i != self._busy_idx:
                            write = i
                            break
                self._read_into(self._bufs[write])
                with self._frame_lock:
                    self._latest_idx = write
                self._have_frame.set()
                ring = self._delay_ring
                if ring is not None and ring.recording:
                    ring.offer(self._bufs[write], self.width, self.height)
        except MediaStreamError:
            logger.info("capture reader ended for %s", self.device)
        except Exception as exc:  # noqa: BLE001
            logger.warning("capture reader failed: %s", exc)

    def _make_frame(
        self, buf: bytearray, pts: int, time_base: fractions.Fraction
    ) -> VideoFrame:
        y = self._y_size
        uv = self._uv_size
        frame = VideoFrame(width=self.width, height=self.height, format="yuv420p")
        view = memoryview(buf)
        frame.planes[0].update(view[0:y])
        frame.planes[1].update(view[y : y + uv])
        frame.planes[2].update(view[y + uv : y + 2 * uv])
        frame.pts = pts
        frame.time_base = time_base
        return frame

    def _grab_frame(self, pts: int, time_base: fractions.Fraction) -> VideoFrame:
        if not self._have_frame.wait(timeout=2.0):
            return self._make_frame(self._blank, pts, time_base)
        with self._frame_lock:
            idx = self._latest_idx
            self._busy_idx = idx
        try:
            return self._make_frame(self._bufs[idx], pts, time_base)
        finally:
            with self._frame_lock:
                if self._busy_idx == idx:
                    self._busy_idx = -1

    async def next_timestamp(self) -> tuple[int, fractions.Fraction]:
        if self.readyState != "live":
            raise MediaStreamError
        ptime = 1.0 / self.fps
        now = time.time()
        if not hasattr(self, "_timestamp"):
            self._start = now
            self._timestamp = 0
            self._frame_index = 0
            return self._timestamp, VIDEO_TIME_BASE

        self._frame_index += 1
        target = self._start + self._frame_index * ptime
        wait = target - time.time()
        if wait > 0:
            await asyncio.sleep(wait)
        elif wait < -ptime:
            # Late: keep PTS monotonic and realign the wall clock so the
            # next recv sleeps a full tick instead of bursting or jumping PTS.
            self._start = time.time() - self._frame_index * ptime

        self._timestamp = int(self._frame_index * ptime * VIDEO_CLOCK_RATE)
        return self._timestamp, VIDEO_TIME_BASE

    async def recv(self) -> VideoFrame:
        if self._stopped:
            raise MediaStreamError("Track ended")

        loop = asyncio.get_running_loop()
        if self._proc is None:
            await loop.run_in_executor(None, self._spawn)
        pts, time_base = await self.next_timestamp()
        try:
            return await loop.run_in_executor(
                None, self._grab_frame, pts, time_base
            )
        except MediaStreamError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("frame read failed: %s", exc)
            return self._make_frame(self._blank, pts, time_base)

    def stop(self) -> None:
        self._stopped = True
        self._have_frame.set()
        proc = self._proc
        self._proc = None
        if proc is not None:
            try:
                if proc.stdout:
                    proc.stdout.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except Exception:  # noqa: BLE001
                try:
                    proc.kill()
                except Exception:  # noqa: BLE001
                    pass
        reader = self._reader_thread
        self._reader_thread = None
        if reader is not None and reader.is_alive():
            reader.join(timeout=1.0)
        try:
            super().stop()
        except Exception:  # noqa: BLE001
            pass


class FFmpegAlsaTrack(AudioStreamTrack):
    """Capture HDMI/USB audio via ffmpeg ALSA (avoids broken PyAV bundled alsa.conf)."""

    def __init__(self, device: str, sample_rate: int = 48000, channels: int = 2):
        super().__init__()
        self.device = device
        self.sample_rate = sample_rate
        self.channels = channels
        self._samples_per_frame = int(sample_rate * 0.02)  # 20 ms packets
        self._frame_bytes = self._samples_per_frame * channels * 2
        self._proc: Optional[subprocess.Popen[bytes]] = None
        self._stderr_thread: Optional[threading.Thread] = None
        self._stopped = False
        self._start_lock = threading.Lock()
        self._start: Optional[float] = None
        self._timestamp = 0

    def _spawn(self) -> None:
        with self._start_lock:
            if self._proc is not None or self._stopped:
                return
            # Prefer plughw for resampling/format conversion when given hw:X,Y
            alsa_dev = self.device
            if alsa_dev.startswith("hw:"):
                alsa_dev = "plug" + alsa_dev
            cmd = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "warning",
                "-fflags",
                "nobuffer",
                "-f",
                "alsa",
                "-ac",
                str(self.channels),
                "-ar",
                str(self.sample_rate),
                "-i",
                alsa_dev,
                "-f",
                "s16le",
                "-acodec",
                "pcm_s16le",
                "-ac",
                str(self.channels),
                "-ar",
                str(self.sample_rate),
                "pipe:1",
            ]
            logger.info("starting audio capture: %s", " ".join(cmd))
            self._proc = subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=self._frame_bytes * 8,
                start_new_session=True,
            )

            def _drain_stderr() -> None:
                assert self._proc is not None and self._proc.stderr is not None
                for line in iter(self._proc.stderr.readline, b""):
                    text = line.decode("utf-8", errors="ignore").strip()
                    if text:
                        logger.warning("ffmpeg-audio: %s", text)

            self._stderr_thread = threading.Thread(
                target=_drain_stderr, name="ffmpeg-alsa-stderr", daemon=True
            )
            self._stderr_thread.start()

    def _read_exact(self) -> bytes:
        self._spawn()
        assert self._proc is not None and self._proc.stdout is not None
        buf = bytearray()
        while len(buf) < self._frame_bytes:
            if self._stopped:
                raise MediaStreamError("Track ended")
            chunk = self._proc.stdout.read(self._frame_bytes - len(buf))
            if not chunk:
                code = self._proc.poll()
                raise MediaStreamError(
                    f"ffmpeg audio stdout closed (exit={code}) device={self.device}"
                )
            buf.extend(chunk)
        return bytes(buf)

    async def recv(self) -> AudioFrame:
        if self._stopped or self.readyState != "live":
            raise MediaStreamError("Track ended")

        if self._start is None:
            self._start = time.time()
            self._timestamp = 0
        else:
            self._timestamp += self._samples_per_frame
            wait = self._start + (self._timestamp / self.sample_rate) - time.time()
            if wait > 0:
                await asyncio.sleep(wait)

        loop = asyncio.get_running_loop()
        try:
            data = await loop.run_in_executor(None, self._read_exact)
        except MediaStreamError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("audio read failed: %s", exc)
            data = b"\x00" * self._frame_bytes

        layout = "stereo" if self.channels == 2 else "mono"
        frame = AudioFrame(format="s16", layout=layout, samples=self._samples_per_frame)
        frame.planes[0].update(data)
        frame.sample_rate = self.sample_rate
        frame.pts = self._timestamp
        frame.time_base = fractions.Fraction(1, self.sample_rate)
        return frame

    def stop(self) -> None:
        self._stopped = True
        proc = self._proc
        self._proc = None
        if proc is not None:
            try:
                if proc.stdout:
                    proc.stdout.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except Exception:  # noqa: BLE001
                try:
                    proc.kill()
                except Exception:  # noqa: BLE001
                    pass
        try:
            super().stop()
        except Exception:  # noqa: BLE001
            pass


def _clone_frame(frame: Frame) -> Frame:
    """Deep-copy a PyAV frame so each encoder owns independent buffers."""
    if isinstance(frame, VideoFrame):
        out = VideoFrame(
            width=frame.width, height=frame.height, format=frame.format.name
        )
        for i, plane in enumerate(frame.planes):
            out.planes[i].update(plane)
        if frame.pts is not None:
            out.pts = frame.pts
        try:
            if frame.time_base is not None:
                out.time_base = frame.time_base
        except Exception:  # noqa: BLE001
            pass
        return out
    if isinstance(frame, AudioFrame):
        out = AudioFrame(
            format=frame.format.name,
            layout=frame.layout.name,
            samples=frame.samples,
        )
        for i, plane in enumerate(frame.planes):
            out.planes[i].update(bytes(plane))
        out.sample_rate = frame.sample_rate
        if frame.pts is not None:
            out.pts = frame.pts
        try:
            if frame.time_base is not None:
                out.time_base = frame.time_base
        except Exception:  # noqa: BLE001
            pass
        return out
    return frame


class _CloneRelayTrack(MediaStreamTrack):
    """Per-subscriber track fed by CloningMediaRelay."""

    def __init__(self, relay: "CloningMediaRelay", source: MediaStreamTrack) -> None:
        super().__init__()
        self.kind = source.kind
        self._relay = relay
        self._source: Optional[MediaStreamTrack] = source
        # Small queue; drop-oldest keeps live latency low under multi-encode load.
        self._queue: asyncio.Queue[Optional[Frame]] = asyncio.Queue(maxsize=1)

    async def recv(self) -> Frame:
        if self.readyState != "live":
            raise MediaStreamError
        self._relay._start(self)
        frame = await self._queue.get()
        if frame is None:
            self.stop()
            raise MediaStreamError
        return frame

    def stop(self) -> None:
        super().stop()
        if self._relay is not None:
            self._relay._stop(self)
            self._relay = None
            self._source = None

    def _push(self, frame: Optional[Frame]) -> None:
        if self.readyState != "live":
            return
        if self._queue.full():
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            self._queue.put_nowait(frame)
        except asyncio.QueueFull:
            pass


class CloningMediaRelay:
    """Fan-out one source track to many consumers with per-consumer frame copies.

    aiortc's MediaRelay shares the same Frame object across consumers; concurrent
    VP8/Opus encoders then race on native buffers and can segfault. This relay
    clones each frame before enqueueing.
    """

    def __init__(self) -> None:
        self._proxies: dict[MediaStreamTrack, set[_CloneRelayTrack]] = {}
        self._tasks: dict[MediaStreamTrack, asyncio.Future[None]] = {}

    def subscribe(self, track: MediaStreamTrack) -> MediaStreamTrack:
        proxy = _CloneRelayTrack(self, track)
        if track not in self._proxies:
            self._proxies[track] = set()
        return proxy

    def _start(self, proxy: _CloneRelayTrack) -> None:
        track = proxy._source
        if track is None:
            return
        if track not in self._proxies:
            self._proxies[track] = set()
        if proxy not in self._proxies[track]:
            self._proxies[track].add(proxy)
        if track not in self._tasks:
            self._tasks[track] = asyncio.ensure_future(self._run_track(track))

    def _stop(self, proxy: _CloneRelayTrack) -> None:
        track = proxy._source
        if track is None or track not in self._proxies:
            return
        self._proxies[track].discard(proxy)

    async def _run_track(self, track: MediaStreamTrack) -> None:
        logger.info("CloningMediaRelay reading source kind=%s", track.kind)
        while True:
            try:
                frame = await track.recv()
            except MediaStreamError:
                frame = None

            proxies = list(self._proxies.get(track, ()))
            if frame is None:
                for proxy in proxies:
                    proxy._push(None)
                break

            for proxy in proxies:
                try:
                    proxy._push(_clone_frame(frame))
                except Exception as exc:  # noqa: BLE001
                    logger.warning("clone/push failed: %s", exc)

        self._proxies.pop(track, None)
        self._tasks.pop(track, None)
        logger.info("CloningMediaRelay stopped source kind=%s", track.kind)


class PeerSession:
    """One browser subscriber's PeerConnection and ICE queues."""

    __slots__ = ("sid", "pc", "pending_ice", "remote_ready", "closing")

    def __init__(self, sid: str, pc: RTCPeerConnection) -> None:
        self.sid = sid
        self.pc = pc
        self.pending_ice: list[dict[str, Any]] = []
        self.remote_ready = False
        self.closing = False


class WebRTCManager:
    """Multi-subscriber WebRTC: one capture pipeline, many PeerConnections."""

    def __init__(self) -> None:
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._sessions: dict[str, PeerSession] = {}
        self._video_track: Optional[FFmpegV4L2Track] = None
        self._audio_track: Optional[FFmpegAlsaTrack] = None
        self._video_relay: Optional[CloningMediaRelay] = None
        self._audio_relay: Optional[CloningMediaRelay] = None
        self._capture_cfg: Optional[dict[str, Any]] = None
        self._early_ice: dict[str, list[dict[str, Any]]] = {}
        self._lock = threading.Lock()
        self._async_lock: Optional[asyncio.Lock] = None
        self._emit: Optional[Callable[..., Any]] = None
        self._started = threading.Event()
        self._delay_ring = DelayRing()
        self._delay_pack: Optional[bytes] = None

    def set_emitter(self, emit: Callable[..., Any]) -> None:
        self._emit = emit
        self._delay_ring.set_emitter(emit)

    def start_loop(self) -> None:
        if self._thread and self._thread.is_alive():
            return

        apply_udp_port_range()

        def _runner() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._loop = loop
            self._async_lock = asyncio.Lock()
            self._started.set()
            loop.run_forever()

        self._thread = threading.Thread(target=_runner, name="webrtc-loop", daemon=True)
        self._thread.start()
        self._started.wait(timeout=5.0)

    def _submit(self, coro, timeout: float = 45.0):
        if not self._loop:
            raise RuntimeError("WebRTC event loop not started")
        fut = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return fut.result(timeout=timeout)

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._sessions)

    @property
    def active_sid(self) -> Optional[str]:
        """Compatibility: any connected subscriber sid, or None."""
        with self._lock:
            if not self._sessions:
                return None
            return next(iter(self._sessions))

    def has_session(self, sid: str) -> bool:
        with self._lock:
            return sid in self._sessions

    def is_busy(self, sid: str) -> bool:
        """Multi-subscriber mode never blocks additional browsers."""
        return False

    def handle_offer(
        self,
        sid: str,
        sdp: str,
        type_: str,
        video_device: str,
        width: int,
        height: int,
        capture_fps: int,
        live_fps: int,
        audio: bool,
        audio_device: Optional[str],
        request_host: str = "",
    ) -> dict[str, Any]:
        if not video_device or not os.path.exists(video_device):
            return {"ok": False, "error": f"video device missing: {video_device}"}

        self.start_loop()
        announce_ip = resolve_announce_ip(request_host)
        # Queue early ICE for this sid while offer is processed.
        with self._lock:
            self._early_ice.setdefault(sid, [])

        return self._submit(
            self._create_answer(
                sid,
                sdp,
                type_,
                video_device,
                width,
                height,
                capture_fps,
                live_fps,
                audio,
                audio_device,
                announce_ip,
            )
        )

    def add_ice(self, sid: str, candidate: dict[str, Any]) -> dict[str, Any]:
        """Accept ICE even before answer is ready; queue until remote description is set."""
        with self._lock:
            if sid not in self._sessions:
                self._early_ice.setdefault(sid, []).append(candidate)
                logger.info("queued early ICE for sid=%s (no session yet)", sid)
                return {"ok": True, "queued": True}
        return self._submit(self._add_ice(sid, candidate))

    def stop(self, sid: Optional[str] = None) -> dict[str, Any]:
        with self._lock:
            if sid:
                self._early_ice.pop(sid, None)
            if not self._loop:
                return {"ok": True}
        if sid:
            return self._submit(self._close_session(sid))
        return self._submit(self._close_all())

    def delay_start(self) -> dict[str, Any]:
        if self._video_track is None:
            return {"ok": False, "error": "请先开始 HDMI 采集", "recording": False}
        self._delay_pack = None
        status = self._delay_ring.start()
        status["ok"] = True
        return status

    def delay_stop(self) -> dict[str, Any]:
        status = self._delay_ring.stop()
        self._delay_pack = self._delay_ring.pack()
        status["ok"] = True
        status["recording"] = False
        status["hasClip"] = bool(self._delay_pack)
        return status

    def delay_pack(self) -> Optional[bytes]:
        return self._delay_pack

    async def _ensure_capture(
        self,
        video_device: str,
        width: int,
        height: int,
        capture_fps: int,
        live_fps: int,
        audio: bool,
        audio_device: Optional[str],
    ) -> None:
        if self._video_track is None:
            video_track = FFmpegV4L2Track(
                video_device,
                width,
                height,
                capture_fps=capture_fps,
                live_fps=live_fps,
                delay_ring=self._delay_ring,
            )
            self._video_track = video_track
            self._video_relay = CloningMediaRelay()
            self._capture_cfg = {
                "video_device": video_device,
                "width": width,
                "height": height,
                "capture_fps": capture_fps,
                "live_fps": live_fps,
            }
            logger.info(
                "shared HDMI capture started %sx%s source=%sfps live=%sfps on %s",
                width,
                height,
                capture_fps,
                live_fps,
                video_device,
            )
        else:
            cfg = self._capture_cfg or {}
            if (cfg.get("width"), cfg.get("height"), cfg.get("capture_fps")) != (
                width,
                height,
                capture_fps,
            ):
                logger.info(
                    "subscriber requested %sx%s@%s; reusing active capture %sx%s source=%s live=%s",
                    width,
                    height,
                    capture_fps,
                    cfg.get("width"),
                    cfg.get("height"),
                    cfg.get("capture_fps"),
                    cfg.get("live_fps"),
                )

        if audio and audio_device and self._audio_track is None:
            try:
                self._audio_track = FFmpegAlsaTrack(audio_device)
                self._audio_relay = CloningMediaRelay()
                logger.info("shared audio capture started on %s", audio_device)
            except Exception as exc:  # noqa: BLE001
                logger.warning("failed to start audio track (%s): %s", audio_device, exc)
                self._audio_track = None
                self._audio_relay = None

    async def _stop_capture_if_idle(self) -> None:
        with self._lock:
            idle = len(self._sessions) == 0
        if not idle:
            return

        if self._delay_ring.recording:
            self._delay_pack = None
            self._delay_ring.stop()

        if self._video_track is not None:
            try:
                self._video_track.stop()
            except Exception:  # noqa: BLE001
                pass
            self._video_track = None
            self._video_relay = None

        if self._audio_track is not None:
            try:
                self._audio_track.stop()
            except Exception:  # noqa: BLE001
                pass
            self._audio_track = None
            self._audio_relay = None

        self._capture_cfg = None
        logger.info("shared HDMI capture stopped (no subscribers)")

    async def _create_answer(
        self,
        sid: str,
        sdp: str,
        type_: str,
        video_device: str,
        width: int,
        height: int,
        capture_fps: int,
        live_fps: int,
        audio: bool,
        audio_device: Optional[str],
        announce_ip: str = "",
    ) -> dict[str, Any]:
        assert self._async_lock is not None
        async with self._async_lock:
            # Re-offer from same browser: replace previous PC for this sid.
            if sid in self._sessions:
                await self._close_session(sid, stop_capture=False)

            early = self._early_ice.pop(sid, [])

            try:
                await self._ensure_capture(
                    video_device,
                    width,
                    height,
                    capture_fps,
                    live_fps,
                    audio,
                    audio_device,
                )
                assert self._video_track is not None and self._video_relay is not None

                apply_udp_port_range()
                ice_servers = build_ice_servers()
                pc = RTCPeerConnection(
                    RTCConfiguration(iceServers=ice_servers) if ice_servers else None
                )
                if ice_servers:
                    logger.info(
                        "PeerConnection ICE servers: %s",
                        [s.urls for s in ice_servers],
                    )
                port_range = udp_port_range()
                if port_range:
                    logger.info(
                        "PeerConnection ICE UDP ports: %s-%s",
                        port_range[0],
                        port_range[1],
                    )
                session = PeerSession(sid, pc)
                session.pending_ice = list(early)
                with self._lock:
                    self._sessions[sid] = session

                # Independent frame copies per subscriber (avoids native encoder races).
                pc.addTrack(self._video_relay.subscribe(self._video_track))
                if audio and self._audio_track is not None and self._audio_relay is not None:
                    pc.addTrack(self._audio_relay.subscribe(self._audio_track))
                    logger.info("audio track attached for sid=%s", sid)

                @pc.on("connectionstatechange")
                async def on_state_change() -> None:
                    state = pc.connectionState
                    logger.info("WebRTC sid=%s state=%s", sid, state)
                    if self._emit:
                        try:
                            self._emit("hdmi:state", {"state": state}, to=sid)
                        except Exception:  # noqa: BLE001
                            pass
                    if state in ("failed", "closed"):
                        await self._close_session(sid)

                offer = RTCSessionDescription(sdp=sdp, type=type_)
                await pc.setRemoteDescription(offer)
                session.remote_ready = True

                more_early = self._early_ice.pop(sid, [])
                pending = list(session.pending_ice) + more_early
                session.pending_ice.clear()
                for cand in pending:
                    await self._add_ice(sid, cand)

                answer = await pc.createAnswer()
                # setLocalDescription awaits full ICE gather in aiortc; candidates
                # are embedded in the answer SDP. We also trickle them over
                # Socket.IO so the browser can apply them via the trickle path.
                await pc.setLocalDescription(answer)
                answer_sdp = rewrite_sdp_announce_ip(
                    pc.localDescription.sdp, announce_ip=announce_ip
                )
                ice_candidates = _local_ice_trickle_messages(
                    pc, announce_ip=announce_ip
                )
                if announce_ip:
                    logger.info(
                        "ICE announce IP rewrite -> %s (source=%s, replace=%s)",
                        announce_ip,
                        "env" if Config.WEBRTC_ANNOUNCE_IP else "request-host",
                        Config.WEBRTC_ANNOUNCE_REPLACE or "*",
                    )

                logger.info(
                    "HDMI subscriber sid=%s joined (%d total), trickle ICE=%d",
                    sid,
                    self.subscriber_count,
                    len(ice_candidates),
                )
                return {
                    "ok": True,
                    "sdp": answer_sdp,
                    "type": pc.localDescription.type,
                    "subscribers": self.subscriber_count,
                    "iceCandidates": ice_candidates,
                    "captureFps": capture_fps,
                    "liveFps": live_fps,
                }
            except Exception as exc:  # noqa: BLE001
                logger.exception("failed to create WebRTC answer for sid=%s", sid)
                await self._close_session(sid)
                return {"ok": False, "error": str(exc)}

    async def _add_ice(self, sid: str, candidate: dict[str, Any]) -> dict[str, Any]:
        session = self._sessions.get(sid)
        if not session:
            self._early_ice.setdefault(sid, []).append(candidate)
            return {"ok": True, "queued": True}
        try:
            cand_str = candidate.get("candidate") or ""
            if not cand_str:
                return {"ok": True}
            if not session.remote_ready:
                session.pending_ice.append(candidate)
                return {"ok": True, "queued": True}
            if cand_str.startswith("candidate:"):
                cand_str = cand_str[len("candidate:") :]
            ice = candidate_from_sdp(cand_str)
            ice.sdpMid = candidate.get("sdpMid")
            ice.sdpMLineIndex = candidate.get("sdpMLineIndex")
            await session.pc.addIceCandidate(ice)
            return {"ok": True}
        except Exception as exc:  # noqa: BLE001
            logger.warning("addIceCandidate failed sid=%s: %s", sid, exc)
            return {"ok": True, "warning": str(exc)}

    async def _close_session(self, sid: str, stop_capture: bool = True) -> dict[str, Any]:
        self._early_ice.pop(sid, None)
        session = self._sessions.get(sid)
        if session is None:
            if stop_capture:
                await self._stop_capture_if_idle()
            return {"ok": True}
        if session.closing:
            return {"ok": True}
        session.closing = True

        with self._lock:
            self._sessions.pop(sid, None)

        try:
            await session.pc.close()
        except Exception:  # noqa: BLE001
            pass

        if stop_capture:
            await self._stop_capture_if_idle()

        logger.info("HDMI subscriber sid=%s left (%d remain)", sid, self.subscriber_count)
        return {"ok": True}

    async def _close_all(self) -> dict[str, Any]:
        sids = list(self._sessions.keys())
        for sid in sids:
            await self._close_session(sid, stop_capture=False)
        await self._stop_capture_if_idle()
        return {"ok": True}


webrtc_manager = WebRTCManager()
