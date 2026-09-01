"""Encode a packed JPEG frame sequence (HDMI delay clip) to MP4 via ffmpeg."""

from __future__ import annotations

import logging
import os
import struct
import subprocess
import tempfile

logger = logging.getLogger(__name__)

MAGIC = b"HDLY"
VERSION = 1
MAX_FRAMES = 1800
MAX_FRAME_BYTES = 8 * 1024 * 1024
MAX_WIDTH = 1920
MAX_HEIGHT = 1080


class PackError(ValueError):
    pass


def _parse_pack(data: bytes) -> tuple[list[tuple[int, bytes]], int, int]:
    if len(data) < 20:
        raise PackError("数据太短")
    if data[:4] != MAGIC:
        raise PackError("无法识别的录制数据")
    version, count, width, height = struct.unpack_from("<IIII", data, 4)
    if version != VERSION:
        raise PackError("不支持的录制格式版本")
    if count < 1 or count > MAX_FRAMES:
        raise PackError("帧数量无效")
    if width < 2 or height < 2 or width > MAX_WIDTH or height > MAX_HEIGHT:
        raise PackError("分辨率无效")

    offset = 20
    frames: list[tuple[int, bytes]] = []
    for _ in range(count):
        if offset + 8 > len(data):
            raise PackError("录制数据不完整")
        t_ms, size = struct.unpack_from("<II", data, offset)
        offset += 8
        if size < 32 or size > MAX_FRAME_BYTES:
            raise PackError("帧数据大小无效")
        if offset + size > len(data):
            raise PackError("录制数据不完整")
        jpeg = data[offset : offset + size]
        offset += size
        if jpeg[:2] != b"\xff\xd8":
            raise PackError("帧不是 JPEG")
        frames.append((t_ms, jpeg))
    if not frames:
        raise PackError("没有可导出的帧")
    return frames, width, height


def _fps_for(frames: list[tuple[int, bytes]]) -> float:
    if len(frames) < 2:
        return 1.0
    duration_ms = max(1, frames[-1][0] - frames[0][0])
    fps = (len(frames) - 1) * 1000.0 / duration_ms
    return min(60.0, max(1.0, fps))


def export_mp4(data: bytes) -> tuple[bytes, None] | tuple[None, str]:
    try:
        frames, _width, _height = _parse_pack(data)
    except PackError as err:
        return None, str(err)

    fps = _fps_for(frames)
    with tempfile.TemporaryDirectory(prefix="hdmi-delay-") as tmp:
        for i, (_t, jpeg) in enumerate(frames):
            path = os.path.join(tmp, f"frame_{i:05d}.jpg")
            with open(path, "wb") as fh:
                fh.write(jpeg)

        out_path = os.path.join(tmp, "out.mp4")
        pattern = os.path.join(tmp, "frame_%05d.jpg")
        cmd = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-framerate",
            f"{fps:.4f}",
            "-i",
            pattern,
            "-vf",
            "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            out_path,
        ]
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                timeout=180,
                check=False,
            )
        except FileNotFoundError:
            return None, "未找到 ffmpeg，请先安装"
        except subprocess.TimeoutExpired:
            return None, "导出超时"

        if proc.returncode != 0 or not os.path.isfile(out_path):
            err = (proc.stderr or b"").decode("utf-8", errors="replace").strip()
            logger.warning("delay export ffmpeg failed: %s", err or proc.returncode)
            return None, err or "ffmpeg 导出失败"

        with open(out_path, "rb") as fh:
            video = fh.read()
        if len(video) < 32:
            return None, "导出的视频为空"
        return video, None
