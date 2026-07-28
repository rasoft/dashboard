import atexit
import logging
import os
import signal
import subprocess
import sys

from app import create_app, socketio
from app.config import Config

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)

app = create_app()


def restore_terminal() -> None:
    """Fix missing echo / cooked mode after Ctrl+C interrupts child processes."""
    if not sys.stdin.isatty():
        return
    try:
        subprocess.run(
            ["stty", "sane"],
            stdin=sys.stdin,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        pass


def shutdown_media() -> None:
    try:
        from app.services.webrtc import webrtc_manager

        webrtc_manager.stop()
    except Exception:  # noqa: BLE001
        pass


def _handle_signal(signum, _frame) -> None:
    logging.info("received signal %s, shutting down", signum)
    shutdown_media()
    restore_terminal()
    # Use os._exit after cleanup to avoid double-faulting hangers in threads.
    raise SystemExit(0)


if __name__ == "__main__":
    atexit.register(restore_terminal)
    atexit.register(shutdown_media)
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    try:
        socketio.run(
            app,
            host=Config.HOST,
            port=Config.PORT,
            allow_unsafe_werkzeug=True,
        )
    finally:
        shutdown_media()
        restore_terminal()
