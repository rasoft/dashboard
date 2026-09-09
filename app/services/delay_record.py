"""Server-side HDMI delay ring: JPEG frames at the capture (source) fps."""

from __future__ import annotations

import logging
import queue
import threading
import time
from collections import deque
from typing import Any, Callable, Optional

import cv2
import numpy as np

from app.services import delay_export

logger = logging.getLogger(__name__)

MAX_MS = 30000
MAX_FRAMES = 1800
JPEG_QUALITY = 68
QUEUE_SIZE = 8


def _yuv420_to_jpeg(yuv: bytes, width: int, height: int) -> bytes | None:
    expected = width * height * 3 // 2
    if len(yuv) < expected or width < 2 or height < 2:
        return None
    try:
        i420 = np.frombuffer(yuv, dtype=np.uint8, count=expected).reshape(
            (height * 3 // 2, width)
        )
        bgr = cv2.cvtColor(i420, cv2.COLOR_YUV2BGR_I420)
        ok, encoded = cv2.imencode(
            ".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY]
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("delay jpeg encode failed: %s", exc)
        return None
    if not ok:
        return None
    data = encoded.tobytes()
    return data if len(data) >= 32 else None


class DelayRing:
    def __init__(self, emit: Optional[Callable[..., Any]] = None) -> None:
        self._emit = emit
        self._lock = threading.Lock()
        self._recording = False
        self._queue: queue.Queue[tuple[float, bytes, int, int]] = queue.Queue(
            maxsize=QUEUE_SIZE
        )
        self._frames: deque[tuple[float, bytes, int, int]] = deque()
        self._thread: Optional[threading.Thread] = None
        self._last_emit = 0.0
        self._width = 0
        self._height = 0

    @property
    def recording(self) -> bool:
        return self._recording

    def set_emitter(self, emit: Optional[Callable[..., Any]]) -> None:
        self._emit = emit

    def start(self) -> dict[str, Any]:
        with self._lock:
            if self._recording:
                return self.status()
            self._frames.clear()
            self._recording = True
            self._last_emit = 0.0
        self._drain_queue()
        self._thread = threading.Thread(
            target=self._run, name="hdmi-delay-jpeg", daemon=True
        )
        self._thread.start()
        logger.info("HDMI delay recording started")
        return self.status()

    def stop(self) -> dict[str, Any]:
        with self._lock:
            self._recording = False
        thread = self._thread
        self._thread = None
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)
        status = self.status()
        logger.info(
            "HDMI delay recording stopped (%s frames, %.0f ms)",
            status.get("frameCount"),
            status.get("bufferMs"),
        )
        return status

    def offer(self, yuv: bytes | bytearray | memoryview, width: int, height: int) -> None:
        if not self._recording:
            return
        payload = bytes(yuv)
        item = (time.monotonic(), payload, width, height)
        try:
            self._queue.put_nowait(item)
        except queue.Full:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self._queue.put_nowait(item)
            except queue.Full:
                pass

    def status(self) -> dict[str, Any]:
        with self._lock:
            frames = list(self._frames)
            recording = self._recording
            width = self._width
            height = self._height
        count = len(frames)
        duration = int((frames[-1][0] - frames[0][0]) * 1000) if count > 1 else 0
        fps = ((count - 1) * 1000.0 / duration) if duration > 200 else 0.0
        if frames:
            width = frames[-1][2]
            height = frames[-1][3]
        return {
            "ok": True,
            "recording": recording,
            "bufferMs": duration,
            "frameCount": count,
            "fps": round(fps, 2),
            "maxMs": MAX_MS,
            "width": width,
            "height": height,
        }

    def pack(self) -> bytes | None:
        with self._lock:
            frames = list(self._frames)
        if not frames:
            return None
        t0 = frames[0][0]
        width = frames[-1][2]
        height = frames[-1][3]
        packed = [
            (max(0, int((t - t0) * 1000.0)), jpeg) for t, jpeg, _w, _h in frames
        ]
        return delay_export.pack_clip(packed, width, height)

    def _drain_queue(self) -> None:
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                return

    def _append(self, t: float, jpeg: bytes, width: int, height: int) -> None:
        with self._lock:
            self._width = width
            self._height = height
            self._frames.append((t, jpeg, width, height))
            cutoff = t - (MAX_MS / 1000.0)
            while self._frames and self._frames[0][0] < cutoff:
                self._frames.popleft()
            while len(self._frames) > MAX_FRAMES:
                self._frames.popleft()
        now = time.monotonic()
        if now - self._last_emit < 0.2:
            return
        self._last_emit = now
        self._emit_progress()

    def _emit_progress(self) -> None:
        emit = self._emit
        if not emit:
            return
        try:
            emit("hdmi:delay-progress", self.status())
        except Exception:  # noqa: BLE001
            logger.warning("delay progress emit failed", exc_info=True)

    def _run(self) -> None:
        while True:
            try:
                t, yuv, width, height = self._queue.get(timeout=0.05)
            except queue.Empty:
                if not self._recording:
                    break
                continue
            jpeg = _yuv420_to_jpeg(yuv, width, height)
            if not jpeg:
                continue
            self._append(t, jpeg, width, height)
        self._emit_progress()
