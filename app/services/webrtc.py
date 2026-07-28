"""WebRTC HDMI capture via aiortc + ffmpeg V4L2 pipe."""

from __future__ import annotations

import asyncio
import fractions
import logging
import os
import subprocess
import threading
import time
from typing import Any, Callable, Optional

import numpy as np
from aiortc import AudioStreamTrack, RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from aiortc.mediastreams import MediaStreamError
from aiortc.sdp import candidate_from_sdp
from av import AudioFrame, VideoFrame

logger = logging.getLogger(__name__)


class FFmpegV4L2Track(VideoStreamTrack):
    """Capture frames from a V4L2 device through an ffmpeg rawvideo pipe.

    USB HDMI capture cards often dequeue empty/corrupt buffers that break
    OpenCV/PyAV MediaPlayer; ffmpeg tolerates them and keeps streaming.
    """

    def __init__(self, device: str, width: int, height: int, fps: int = 30):
        super().__init__()
        self.device = device
        self.width = width
        self.height = height
        self.fps = max(1, int(fps))
        self._frame_bytes = width * height * 3
        self._proc: Optional[subprocess.Popen[bytes]] = None
        self._stderr_thread: Optional[threading.Thread] = None
        self._stopped = False
        self._start_lock = threading.Lock()

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
                "-f",
                "v4l2",
                "-input_format",
                "mjpeg",
                "-video_size",
                f"{self.width}x{self.height}",
                "-framerate",
                str(self.fps),
                "-i",
                self.device,
                "-an",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-vsync",
                "0",
                "pipe:1",
            ]
            logger.info("starting capture: %s", " ".join(cmd))
            self._proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=self._frame_bytes * 2,
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
                    f"ffmpeg stdout closed (exit={code}) while reading {self.device}"
                )
            buf.extend(chunk)
        return bytes(buf)

    async def recv(self) -> VideoFrame:
        if self._stopped:
            raise MediaStreamError("Track ended")

        pts, time_base = await self.next_timestamp()
        loop = asyncio.get_running_loop()
        try:
            data = await loop.run_in_executor(None, self._read_exact)
            img = np.frombuffer(data, dtype=np.uint8).reshape(
                (self.height, self.width, 3)
            )
        except MediaStreamError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("frame read failed: %s", exc)
            img = np.zeros((self.height, self.width, 3), dtype=np.uint8)

        frame = VideoFrame.from_ndarray(img, format="rgb24")
        frame.pts = pts
        frame.time_base = time_base
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
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=self._frame_bytes * 8,
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


class WebRTCManager:
    """Single-session WebRTC manager with thread-safe asyncio bridge."""

    def __init__(self) -> None:
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._pc: Optional[RTCPeerConnection] = None
        self._video_track: Optional[FFmpegV4L2Track] = None
        self._audio_track: Optional[FFmpegAlsaTrack] = None
        self._active_sid: Optional[str] = None
        self._reserving_sid: Optional[str] = None
        self._pending_ice: list[dict[str, Any]] = []
        self._early_ice: dict[str, list[dict[str, Any]]] = {}
        self._remote_ready = False
        self._lock = threading.Lock()
        self._emit: Optional[Callable[..., Any]] = None
        self._started = threading.Event()

    def set_emitter(self, emit: Callable[..., Any]) -> None:
        self._emit = emit

    def start_loop(self) -> None:
        if self._thread and self._thread.is_alive():
            return

        def _runner() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._loop = loop
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
    def active_sid(self) -> Optional[str]:
        return self._active_sid

    def is_busy(self, sid: str) -> bool:
        with self._lock:
            if self._reserving_sid and self._reserving_sid != sid:
                return True
            return self._active_sid is not None and self._active_sid != sid

    def handle_offer(
        self,
        sid: str,
        sdp: str,
        type_: str,
        video_device: str,
        width: int,
        height: int,
        fps: int,
        audio: bool,
        audio_device: Optional[str],
    ) -> dict[str, Any]:
        if not video_device or not os.path.exists(video_device):
            return {"ok": False, "error": f"video device missing: {video_device}"}

        with self._lock:
            if self._active_sid and self._active_sid != sid:
                return {"ok": False, "error": "another HDMI session is already active"}
            if self._reserving_sid and self._reserving_sid != sid:
                return {"ok": False, "error": "another HDMI session is already active"}
            # Reserve sid so early ICE from this client is queued, not rejected.
            self._reserving_sid = sid
            self.start_loop()

        try:
            return self._submit(
                self._create_answer(
                    sid, sdp, type_, video_device, width, height, fps, audio, audio_device
                )
            )
        finally:
            with self._lock:
                if self._reserving_sid == sid:
                    self._reserving_sid = None

    def add_ice(self, sid: str, candidate: dict[str, Any]) -> dict[str, Any]:
        """Accept ICE even before answer is ready; queue until remote description is set."""
        with self._lock:
            owned = self._active_sid == sid or self._reserving_sid == sid
            if not owned:
                # Offer may still be in flight on the wire — queue by sid.
                self._early_ice.setdefault(sid, []).append(candidate)
                logger.info("queued early ICE for sid=%s (no session yet)", sid)
                return {"ok": True, "queued": True}
            if self._active_sid != sid:
                # Reserved but PeerConnection not created yet.
                self._early_ice.setdefault(sid, []).append(candidate)
                return {"ok": True, "queued": True}
        return self._submit(self._add_ice(candidate))

    def stop(self, sid: Optional[str] = None) -> dict[str, Any]:
        with self._lock:
            if sid and self._active_sid and sid != self._active_sid:
                self._early_ice.pop(sid, None)
                return {"ok": False, "error": "session mismatch"}
            if sid:
                self._early_ice.pop(sid, None)
            if not self._loop:
                self._active_sid = None
                self._reserving_sid = None
                return {"ok": True}
        return self._submit(self._close(clear_sid=sid))

    async def _create_answer(
        self,
        sid: str,
        sdp: str,
        type_: str,
        video_device: str,
        width: int,
        height: int,
        fps: int,
        audio: bool,
        audio_device: Optional[str],
    ) -> dict[str, Any]:
        # Preserve ICE that arrived before/during offer processing.
        early = self._early_ice.pop(sid, [])
        await self._close(clear_sid=None)

        pc = RTCPeerConnection()
        self._pc = pc
        self._active_sid = sid
        self._pending_ice = list(early)
        self._remote_ready = False

        @pc.on("connectionstatechange")
        async def on_state_change() -> None:
            state = pc.connectionState
            logger.info("WebRTC connection state: %s", state)
            if self._emit and self._active_sid:
                try:
                    self._emit("hdmi:state", {"state": state}, to=self._active_sid)
                except Exception:  # noqa: BLE001
                    pass
            if state in ("failed", "closed"):
                await self._close(clear_sid=sid)

        try:
            video_track = FFmpegV4L2Track(video_device, width, height, fps)
            self._video_track = video_track
            pc.addTrack(video_track)

            if audio and audio_device:
                try:
                    audio_track = FFmpegAlsaTrack(audio_device)
                    self._audio_track = audio_track
                    pc.addTrack(audio_track)
                    logger.info("audio track added for %s", audio_device)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("failed to start audio track (%s): %s", audio_device, exc)
                    self._audio_track = None

            offer = RTCSessionDescription(sdp=sdp, type=type_)
            await pc.setRemoteDescription(offer)
            self._remote_ready = True

            # Flush any ICE queued before remote description was ready.
            more_early = self._early_ice.pop(sid, [])
            pending = list(self._pending_ice) + more_early
            self._pending_ice.clear()
            for cand in pending:
                await self._add_ice(cand)

            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)

            for _ in range(50):
                if pc.iceGatheringState == "complete":
                    break
                await asyncio.sleep(0.05)

            return {
                "ok": True,
                "sdp": pc.localDescription.sdp,
                "type": pc.localDescription.type,
            }
        except Exception as exc:  # noqa: BLE001
            logger.exception("failed to create WebRTC answer")
            await self._close(clear_sid=sid)
            return {"ok": False, "error": str(exc)}

    async def _add_ice(self, candidate: dict[str, Any]) -> dict[str, Any]:
        if not self._pc:
            return {"ok": True, "queued": True}
        try:
            cand_str = candidate.get("candidate") or ""
            if not cand_str:
                return {"ok": True}
            if not self._remote_ready:
                self._pending_ice.append(candidate)
                return {"ok": True, "queued": True}
            if cand_str.startswith("candidate:"):
                cand_str = cand_str[len("candidate:") :]
            ice = candidate_from_sdp(cand_str)
            ice.sdpMid = candidate.get("sdpMid")
            ice.sdpMLineIndex = candidate.get("sdpMLineIndex")
            await self._pc.addIceCandidate(ice)
            return {"ok": True}
        except Exception as exc:  # noqa: BLE001
            logger.warning("addIceCandidate failed: %s", exc)
            # Non-fatal: bad candidates should not tear down the session.
            return {"ok": True, "warning": str(exc)}

    async def _close(self, clear_sid: Optional[str] = None) -> dict[str, Any]:
        self._remote_ready = False
        self._pending_ice.clear()
        if clear_sid:
            self._early_ice.pop(clear_sid, None)

        if self._video_track is not None:
            try:
                self._video_track.stop()
            except Exception:  # noqa: BLE001
                pass
            self._video_track = None

        if self._audio_track is not None:
            try:
                self._audio_track.stop()
            except Exception:  # noqa: BLE001
                pass
            self._audio_track = None

        if self._pc is not None:
            try:
                await self._pc.close()
            except Exception:  # noqa: BLE001
                pass
            self._pc = None

        self._active_sid = None
        return {"ok": True}


webrtc_manager = WebRTCManager()
