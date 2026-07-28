"""Discover MACROSILICON / USB3 HDMI capture devices (V4L2 + ALSA)."""

from __future__ import annotations

import glob
import logging
import os
import re
import subprocess
from typing import Any

from flask import current_app

logger = logging.getLogger(__name__)


def _read_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def _name_matches(name: str, filters: tuple[str, ...]) -> bool:
    upper = name.upper()
    return any(f.upper() in upper for f in filters)


def _v4l2_list_devices() -> str:
    try:
        result = subprocess.run(
            ["v4l2-ctl", "--list-devices"],
            capture_output=True,
            text=True,
            timeout=5.0,
            check=False,
        )
        return result.stdout or ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def list_video_devices() -> list[dict[str, Any]]:
    filters = tuple(current_app.config.get("CAPTURE_NAME_FILTERS", ()))
    devices: list[dict[str, Any]] = []

    # Prefer v4l2-ctl grouping when available
    output = _v4l2_list_devices()
    if output:
        blocks = re.split(r"\n(?=\S)", output.strip())
        for block in blocks:
            lines = [ln.rstrip() for ln in block.splitlines() if ln.strip()]
            if not lines:
                continue
            name = lines[0].rstrip(":")
            nodes = []
            for ln in lines[1:]:
                m = re.search(r"(/dev/video\d+)", ln)
                if m:
                    nodes.append(m.group(1))
            if not nodes:
                continue
            matched = _name_matches(name, filters) if filters else True
            devices.append(
                {
                    "name": name,
                    "device": nodes[0],
                    "nodes": nodes,
                    "matched": matched,
                }
            )
        matched = [d for d in devices if d["matched"]]
        if matched:
            return matched
        if devices:
            return devices

    # Fallback: sysfs
    for path in sorted(glob.glob("/sys/class/video4linux/video*")):
        index = os.path.basename(path)
        name = _read_text(os.path.join(path, "name")) or index
        device = f"/dev/{index}"
        if not os.path.exists(device):
            continue
        matched = _name_matches(name, filters) if filters else True
        devices.append(
            {
                "name": name,
                "device": device,
                "nodes": [device],
                "matched": matched,
            }
        )

    matched = [d for d in devices if d["matched"]]
    return matched or devices


def list_alsa_capture() -> list[dict[str, Any]]:
    filters = tuple(current_app.config.get("CAPTURE_NAME_FILTERS", ()))
    devices: list[dict[str, Any]] = []
    try:
        result = subprocess.run(
            ["arecord", "-l"],
            capture_output=True,
            text=True,
            timeout=5.0,
            check=False,
        )
        output = result.stdout or ""
    except (OSError, subprocess.TimeoutExpired):
        return devices

    # card 1: USB [USB Audio], device 0: USB Audio [USB Audio]
    pattern = re.compile(
        r"card\s+(\d+):\s+([^\[]+)\[([^\]]+)\],\s+device\s+(\d+):\s+([^\[]+)\[([^\]]+)\]",
        re.IGNORECASE,
    )
    for match in pattern.finditer(output):
        card, card_id, card_name, device, dev_id, dev_name = match.groups()
        label = f"{card_name.strip()} {dev_name.strip()}"
        alsa = f"hw:{card},{device}"
        plughw = f"plughw:{card},{device}"
        matched = _name_matches(label, filters) or _name_matches(card_name, filters)
        # HDMI capture cards often show as USB Audio near MACROSILICON
        if not matched and ("USB" in label.upper() or "AUDIO" in label.upper()):
            matched = True if not filters else matched
        devices.append(
            {
                "name": label.strip(),
                "card": int(card),
                "device": int(device),
                "alsa": alsa,
                "plughw": plughw,
                "matched": matched,
            }
        )

    matched = [d for d in devices if d["matched"]]
    # Prefer matched; if none matched specifically, return all USB-like
    return matched or devices


def get_capture_status() -> dict[str, Any]:
    videos = list_video_devices()
    audios = list_alsa_capture()
    primary_video = videos[0] if videos else None
    primary_audio = audios[0] if audios else None
    return {
        "available": primary_video is not None,
        "video": primary_video,
        "audio": primary_audio,
        "videos": videos,
        "audios": audios,
    }


def discover_serial_ports() -> list[dict[str, str]]:
    """Reserved for future serial panel; FTDI discovery only."""
    ports: list[dict[str, str]] = []
    by_id = "/dev/serial/by-id"
    if not os.path.isdir(by_id):
        return ports
    for entry in sorted(os.listdir(by_id)):
        full = os.path.join(by_id, entry)
        try:
            target = os.path.realpath(full)
        except OSError:
            target = full
        ports.append({"id": entry, "path": target, "by_id": full})
    return ports
