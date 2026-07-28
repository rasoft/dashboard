from flask import Blueprint, current_app, jsonify, request

from app.services import adb, bandwidth, capture
from app.services.webrtc import webrtc_manager

api_bp = Blueprint("api", __name__)


@api_bp.get("/status")
def status():
    return jsonify(
        {
            "adb": adb.get_status(),
            "hdmi": capture.get_capture_status(),
            "serial": {"ports": capture.discover_serial_ports()},
            "hdmi_session": {"active": webrtc_manager.active_sid is not None},
        }
    )


@api_bp.get("/adb/status")
def adb_status():
    return jsonify(adb.get_status())


@api_bp.post("/remote/key")
def remote_key():
    data = request.get_json(silent=True) or {}
    key = data.get("key", "")
    result = adb.send_key(key)
    status = 200 if result.get("ok") else 400
    return jsonify(result), status


@api_bp.get("/hdmi/devices")
def hdmi_devices():
    return jsonify(capture.get_capture_status())


@api_bp.get("/hdmi/bandwidth")
def hdmi_bandwidth():
    width = int(request.args.get("width", current_app.config["DEFAULT_WIDTH"]))
    height = int(request.args.get("height", current_app.config["DEFAULT_HEIGHT"]))
    fps = int(request.args.get("fps", current_app.config["DEFAULT_FPS"]))
    audio = request.args.get("audio", "1") not in ("0", "false", "False")

    allowed = set(current_app.config["ALLOWED_RESOLUTIONS"])
    if (width, height) not in allowed:
        return jsonify({"ok": False, "error": "unsupported resolution"}), 400

    estimate = bandwidth.estimate_bandwidth(width, height, fps, audio)
    estimate["ok"] = True
    return jsonify(estimate)


@api_bp.get("/serial/ports")
def serial_ports():
    return jsonify({"ports": capture.discover_serial_ports()})
