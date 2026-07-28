"""Socket.IO signaling for HDMI WebRTC."""

from __future__ import annotations

import logging

from flask import current_app, request
from flask_socketio import emit

from app import socketio
from app.services import capture
from app.services.webrtc import webrtc_manager

logger = logging.getLogger(__name__)


def _emit_to(event: str, data, to: str | None = None) -> None:
    socketio.emit(event, data, to=to)


webrtc_manager.set_emitter(_emit_to)


@socketio.on("connect")
def on_connect():
    webrtc_manager.start_loop()
    emit("connected", {"sid": request.sid})


@socketio.on("disconnect")
def on_disconnect():
    if webrtc_manager.active_sid == request.sid:
        webrtc_manager.stop(request.sid)


@socketio.on("hdmi:offer")
def on_hdmi_offer(data):
    data = data or {}
    sid = request.sid

    if webrtc_manager.is_busy(sid):
        emit("hdmi:error", {"error": "another HDMI session is already active"})
        return

    status = capture.get_capture_status()
    if not status.get("available") or not status.get("video"):
        emit("hdmi:error", {"error": "HDMI capture device not found"})
        return

    width = int(data.get("width") or current_app.config["DEFAULT_WIDTH"])
    height = int(data.get("height") or current_app.config["DEFAULT_HEIGHT"])
    fps = int(data.get("fps") or current_app.config["DEFAULT_FPS"])
    audio = bool(data.get("audio", True))
    allowed = set(current_app.config["ALLOWED_RESOLUTIONS"])
    if (width, height) not in allowed:
        emit("hdmi:error", {"error": "unsupported resolution"})
        return

    video_device = status["video"]["device"]
    audio_device = None
    if audio and status.get("audio"):
        audio_device = status["audio"]["alsa"]

    sdp = data.get("sdp")
    type_ = data.get("type", "offer")
    if not sdp:
        emit("hdmi:error", {"error": "missing sdp"})
        return

    result = webrtc_manager.handle_offer(
        sid=sid,
        sdp=sdp,
        type_=type_,
        video_device=video_device,
        width=width,
        height=height,
        fps=fps,
        audio=audio,
        audio_device=audio_device,
    )

    if not result.get("ok"):
        emit("hdmi:error", {"error": result.get("error", "offer failed")})
        return

    emit("hdmi:answer", {"sdp": result["sdp"], "type": result["type"]})


@socketio.on("hdmi:ice")
def on_hdmi_ice(data):
    data = data or {}
    result = webrtc_manager.add_ice(request.sid, data)
    if not result.get("ok"):
        emit("hdmi:error", {"error": result.get("error", "ice failed")})


@socketio.on("hdmi:stop")
def on_hdmi_stop(_data=None):
    webrtc_manager.stop(request.sid)
    emit("hdmi:state", {"state": "closed"})
