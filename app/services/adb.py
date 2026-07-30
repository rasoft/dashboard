"""ADB helpers for remote key events and device status."""

from __future__ import annotations

import logging
import subprocess
from typing import Any

from flask import current_app

logger = logging.getLogger(__name__)

# Logical key -> Android KEYCODE or special action
KEY_MAP: dict[str, int | dict[str, str]] = {
    "DPAD_UP": 19,
    "DPAD_DOWN": 20,
    "DPAD_LEFT": 21,
    "DPAD_RIGHT": 22,
    "DPAD_CENTER": 23,
    "BACK": 4,
    "HOME": 3,
    "SETTINGS": 176,
    "ASSISTANT": 231,
    "VOLUME_UP": 24,
    "VOLUME_DOWN": 25,
    "MUTE": 164,
    "POWER": 26,
    "CHANNEL_UP": 166,
    "CHANNEL_DOWN": 167,
    "TV_INPUT": 178,
    "BOOKMARK": 174,
    "LIVE": 170,
    "NETFLIX": {
        "type": "intent",
        "cmd": "am start -a android.intent.action.VIEW -d https://www.netflix.com/title",
    },
    "YOUTUBE": {
        "type": "intent",
        "cmd": "am start -a android.intent.action.VIEW -d https://www.youtube.com",
    },
    "PRIME": {
        "type": "intent",
        "cmd": "am start -a android.intent.action.VIEW -d https://app.primevideo.com",
    },
    "DISNEY": {
        "type": "intent",
        "cmd": "am start -a android.intent.action.VIEW -d https://www.disneyplus.com",
    },
}


def _adb_base() -> list[str]:
    adb = current_app.config.get("ADB_PATH", "adb")
    serial = current_app.config.get("ADB_SERIAL") or ""
    cmd = [adb]
    if serial:
        cmd.extend(["-s", serial])
    return cmd


def _run(args: list[str], timeout: float = 8.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def run_adb(args: list[str], timeout: float = 8.0) -> subprocess.CompletedProcess[str]:
    """Run an adb subcommand with configured path/serial."""
    return _run(_adb_base() + list(args), timeout=timeout)


def run_shell(command: str, timeout: float = 8.0) -> subprocess.CompletedProcess[str]:
    """Run `adb shell <command>` (command as a single shell string)."""
    return _run(_adb_base() + ["shell", command], timeout=timeout)


def list_devices() -> list[dict[str, str]]:
    adb = current_app.config.get("ADB_PATH", "adb")
    try:
        result = _run([adb, "devices", "-l"], timeout=5.0)
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.warning("adb devices failed: %s", exc)
        return []

    devices: list[dict[str, str]] = []
    for line in result.stdout.splitlines()[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        serial, state = parts[0], parts[1]
        devices.append({"serial": serial, "state": state})
    return devices


def get_status() -> dict[str, Any]:
    devices = list_devices()
    preferred = current_app.config.get("ADB_SERIAL") or ""
    online = [d for d in devices if d["state"] == "device"]

    selected = None
    if preferred:
        for d in online:
            if d["serial"] == preferred:
                selected = d
                break
    if selected is None and online:
        selected = online[0]

    return {
        "available": selected is not None,
        "selected": selected,
        "devices": devices,
    }


def send_key(key: str) -> dict[str, Any]:
    key = (key or "").upper().strip()
    if key not in KEY_MAP:
        return {"ok": False, "error": f"unknown key: {key}"}

    status = get_status()
    if not status["available"]:
        return {"ok": False, "error": "no adb device online"}

    mapping = KEY_MAP[key]
    base = _adb_base()

    try:
        if isinstance(mapping, dict) and mapping.get("type") == "intent":
            result = _run(base + ["shell"] + mapping["cmd"].split(), timeout=10.0)
        else:
            result = _run(base + ["shell", "input", "keyevent", str(mapping)], timeout=8.0)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": str(exc)}

    if result.returncode != 0:
        err = (result.stderr or result.stdout or "adb command failed").strip()
        return {"ok": False, "error": err}

    return {"ok": True, "key": key}


def escape_input_text(text: str) -> str:
    """Escape a string for `adb shell input text`."""
    # `input text` treats space as %s; backslash escapes specials for the Android shell.
    escaped: list[str] = []
    for ch in text:
        if ch == " ":
            escaped.append("%s")
        elif ch == "%":
            escaped.append("\\%")
        elif ch == "\\":
            escaped.append("\\\\")
        elif ch in "'\"&<>|(){};$`":
            escaped.append("\\" + ch)
        else:
            escaped.append(ch)
    return "".join(escaped)


def send_text(text: str) -> dict[str, Any]:
    """Send text via `adb shell input text …`."""
    raw = text if isinstance(text, str) else ""
    if raw == "":
        return {"ok": False, "error": "empty text"}

    status = get_status()
    if not status["available"]:
        return {"ok": False, "error": "no adb device online"}

    payload = escape_input_text(raw)
    base = _adb_base()
    try:
        result = _run(base + ["shell", "input", "text", payload], timeout=10.0)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": str(exc)}

    if result.returncode != 0:
        err = (result.stderr or result.stdout or "adb input text failed").strip()
        return {"ok": False, "error": err}

    return {"ok": True, "text": raw, "escaped": payload}
