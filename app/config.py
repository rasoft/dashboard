import os


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
