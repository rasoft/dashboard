from flask import Blueprint, current_app, jsonify, request

from app.services import adb, bandwidth, capture, ddr_bw, hwc_layers, sf_events
from app.services.webrtc import webrtc_manager

api_bp = Blueprint("api", __name__)


@api_bp.get("/status")
def status():
    return jsonify(
        {
            "adb": adb.get_status(),
            "hdmi": capture.get_capture_status(),
            "serial": {"ports": capture.discover_serial_ports()},
            "hdmi_session": {
                "active": webrtc_manager.subscriber_count > 0,
                "subscribers": webrtc_manager.subscriber_count,
            },
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


@api_bp.get("/hdmi/ice-servers")
def hdmi_ice_servers():
    from app.services.webrtc import (
        ice_network_info,
        ice_servers_for_client,
        resolve_announce_ip,
    )

    info = ice_network_info()
    # Reflect what this HTTP client would get as announce IP.
    info["announceIpResolved"] = resolve_announce_ip(request.host) or None
    return jsonify(
        {
            "ok": True,
            "iceServers": ice_servers_for_client(),
            **info,
        }
    )


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


@api_bp.post("/ddr/enable")
def ddr_enable():
    result = ddr_bw.enable_monitor()
    status = 200 if result.get("ok") else 400
    return jsonify(result), status


@api_bp.get("/ddr/sample")
def ddr_sample():
    raw_targets = request.args.get("targets") or request.args.get("target") or ""
    if raw_targets.strip():
        targets = [t.strip() for t in raw_targets.split(",") if t.strip()]
    else:
        targets = list(ddr_bw.DEFAULT_TARGETS)
    result = ddr_bw.sample(targets=targets)
    status = 200 if result.get("ok") else 400
    return jsonify(result), status


@api_bp.get("/hwc/layers")
def hwc_layers_sample():
    result = hwc_layers.sample()
    status = 200 if result.get("ok") else 400
    return jsonify(result), status


@api_bp.get("/sf/events")
def sf_events_sample():
    result = sf_events.sample()
    status = 200 if result.get("ok") else 400
    return jsonify(result), status
