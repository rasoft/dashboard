import os


def _split_urls(value: str) -> list[str]:
    return [part.strip() for part in (value or "").split(",") if part.strip()]


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", "dashboard-dev-secret")
    HOST = os.environ.get("DASHBOARD_HOST", "0.0.0.0")
    PORT = int(os.environ.get("DASHBOARD_PORT", "5000"))

    ADB_PATH = os.environ.get("ADB_PATH", "adb")
    ADB_SERIAL = os.environ.get("ADB_SERIAL", "")

    CAPTURE_NAME_FILTERS = ("MACROSILICON", "USB3 Video", "USB Video")
    DEFAULT_WIDTH = 1920
    DEFAULT_HEIGHT = 1080
    DEFAULT_FPS = 30
    ALLOWED_RESOLUTIONS = ((1280, 720), (1920, 1080))

    # WebRTC ICE: STUN lets WAN clients reach the DMZ/public host; TURN is optional fallback.
    WEBRTC_STUN_URLS = _split_urls(
        os.environ.get("WEBRTC_STUN_URLS", "stun:stun.l.google.com:19302")
    )
    WEBRTC_TURN_URLS = _split_urls(os.environ.get("WEBRTC_TURN_URLS", ""))
    WEBRTC_TURN_USERNAME = os.environ.get("WEBRTC_TURN_USERNAME", "")
    WEBRTC_TURN_CREDENTIAL = os.environ.get("WEBRTC_TURN_CREDENTIAL", "")

    # Restrict aiortc/aioice host ICE UDP sockets to this inclusive range so
    # firewalls can allowlist a finite UDP window. Set either side to 0 to disable.
    WEBRTC_UDP_PORT_MIN = int(os.environ.get("WEBRTC_UDP_PORT_MIN", "40000"))
    WEBRTC_UDP_PORT_MAX = int(os.environ.get("WEBRTC_UDP_PORT_MAX", "40199"))

    # Clients often reach Dashboard via a DNAT/VIP (e.g. 192.168.111.79 → 192.168.166.66).
    # ICE host candidates still advertise the NIC IP. When WEBRTC_ANNOUNCE_IP is empty,
    # each session rewrites candidates to the HTTP/Socket.IO request Host (same URL the
    # browser used). Set WEBRTC_ANNOUNCE_IP to force a fixed address. WEBRTC_ANNOUNCE_REPLACE
    # limits which local IPs are rewritten (comma-separated); empty = all host candidates.
    WEBRTC_ANNOUNCE_IP = os.environ.get("WEBRTC_ANNOUNCE_IP", "").strip()
    WEBRTC_ANNOUNCE_REPLACE = _split_urls(os.environ.get("WEBRTC_ANNOUNCE_REPLACE", ""))
