"""Parse /proc/diskstats and map mounts via df."""

from __future__ import annotations

import logging
import re
import shlex
import subprocess
import time
from typing import Any

from app.services import adb

logger = logging.getLogger(__name__)

FIXED_DEVICES = ("mmcblk0", "zram0")
DEFAULT_DEVICES = FIXED_DEVICES  # backward-compatible alias
TARGET_MOUNTS = (
    "/",
    "/metadata",
    "/system_ext",
    "/vendor",
    "/product",
    "/cache",
    "/data",
)
# Linux /proc/diskstats sector size is always 512 bytes for these counters.
SECTOR_BYTES = 512

_DF_HEADER_RE = re.compile(r"^Filesystem\b", re.I)


def parse_diskstats(text: str) -> dict[str, dict[str, int]]:
    """Parse /proc/diskstats into name -> counter map."""
    out: dict[str, dict[str, int]] = {}
    for line in (text or "").splitlines():
        parts = line.split()
        if len(parts) < 14:
            continue
        name = parts[2]
        try:
            out[name] = {
                "reads_completed": int(parts[3]),
                "sectors_read": int(parts[5]),
                "writes_completed": int(parts[7]),
                "sectors_written": int(parts[9]),
            }
        except ValueError:
            continue
    return out


def parse_df(text: str) -> dict[str, str]:
    """Parse `df` output into mount -> filesystem path."""
    mounts: dict[str, str] = {}
    lines = [ln for ln in (text or "").splitlines() if ln.strip()]
    if not lines:
        return mounts

    start = 1 if _DF_HEADER_RE.match(lines[0]) else 0
    for line in lines[start:]:
        parts = line.split()
        if len(parts) < 2:
            continue
        # df wraps long lines rarely; expect: fs ... mount
        fs = parts[0]
        mount = parts[-1]
        if not mount.startswith("/"):
            continue
        mounts[mount] = fs
    return mounts


def _diskstats_name_from_path(path: str) -> str | None:
    """Convert a /dev/... path into a /proc/diskstats device name."""
    raw = (path or "").strip()
    if not raw.startswith("/dev/"):
        return None
    name = raw[len("/dev/") :]
    if name.startswith("block/"):
        name = name[len("block/") :]
    # Drop mapper/ / disk/ prefixes if present; keep dm-X / mmcblkXpY.
    if "/" in name:
        # by-name/userdata → last component (often not in diskstats until resolved).
        name = name.rsplit("/", 1)[-1]
    name = name.strip()
    return name or None


def _resolve_block_path(fs_path: str) -> str:
    """Resolve symlinks under /dev so by-name paths become dm-X / mmcblkXpY."""
    path = (fs_path or "").strip()
    if not path.startswith("/dev/"):
        return path
    try:
        result = adb.run_shell(f"readlink -f -- {shlex.quote(path)}", timeout=5.0)
        resolved = (result.stdout or "").strip()
        if resolved.startswith("/dev/"):
            return resolved
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.debug("readlink failed for %s: %s", path, exc)
    return path


def mount_key(mount: str) -> str:
    if mount == "/":
        return "mnt-root"
    cleaned = mount.strip("/").replace("/", "-")
    return f"mnt-{cleaned}"


def resolve_tracks(
    mounts: list[str] | None = None,
    fixed_devices: list[str] | None = None,
) -> dict[str, Any]:
    """Discover diskstats device names for fixed disks and target mounts via df."""
    wanted_mounts = [
        m for m in (mounts or list(TARGET_MOUNTS)) if isinstance(m, str) and m.startswith("/")
    ]
    if not wanted_mounts:
        wanted_mounts = list(TARGET_MOUNTS)
    fixed = [
        d.strip()
        for d in (fixed_devices or list(FIXED_DEVICES))
        if isinstance(d, str) and d.strip()
    ]
    if not fixed:
        fixed = list(FIXED_DEVICES)

    status = adb.get_status()
    if not status["available"]:
        return {"ok": False, "error": "no adb device online"}

    try:
        df_result = adb.run_shell("df", timeout=10.0)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": str(exc)}

    df_raw = df_result.stdout or ""
    if df_result.returncode != 0 and not df_raw.strip():
        err = (df_result.stderr or "df failed").strip()
        return {"ok": False, "error": err}

    mount_fs = parse_df(df_raw)

    try:
        ds_result = adb.run_shell("cat /proc/diskstats", timeout=8.0)
        disk_names = set(parse_diskstats(ds_result.stdout or "").keys())
    except (OSError, subprocess.TimeoutExpired):
        disk_names = set()

    tracks: list[dict[str, Any]] = []
    for dev in fixed:
        tracks.append(
            {
                "key": dev,
                "label": dev,
                "device": dev,
                "kind": "device",
                "default_on": True,
                "present_in_diskstats": (not disk_names) or (dev in disk_names),
            }
        )

    unresolved: list[dict[str, Any]] = []
    for mount in wanted_mounts:
        fs = mount_fs.get(mount)
        if not fs:
            unresolved.append({"mount": mount, "reason": "not in df"})
            continue
        resolved_path = _resolve_block_path(fs)
        device = _diskstats_name_from_path(resolved_path)
        if not device:
            unresolved.append(
                {
                    "mount": mount,
                    "filesystem": fs,
                    "resolved": resolved_path,
                    "reason": "not a block device",
                }
            )
            continue
        if disk_names and device not in disk_names:
            unresolved.append(
                {
                    "mount": mount,
                    "filesystem": fs,
                    "resolved": resolved_path,
                    "device": device,
                    "reason": "device not in /proc/diskstats",
                }
            )
            continue
        tracks.append(
            {
                "key": mount_key(mount),
                "label": mount,
                "device": device,
                "mount": mount,
                "filesystem": fs,
                "resolved": resolved_path,
                "kind": "mount",
                "default_on": mount in ("/", "/data"),
                "present_in_diskstats": True,
            }
        )

    return {
        "ok": True,
        "tracks": tracks,
        "unresolved": unresolved,
        "target_mounts": wanted_mounts,
        "fixed_devices": fixed,
    }


def sample(devices: list[str] | None = None) -> dict[str, Any]:
    """Fetch /proc/diskstats and return counters for selected devices."""
    wanted = [d.strip() for d in (devices or list(FIXED_DEVICES)) if d and d.strip()]
    if not wanted:
        wanted = list(FIXED_DEVICES)

    # Preserve order, drop duplicates.
    seen: set[str] = set()
    ordered: list[str] = []
    for name in wanted:
        if name in seen:
            continue
        seen.add(name)
        ordered.append(name)

    status = adb.get_status()
    if not status["available"]:
        return {"ok": False, "error": "no adb device online"}

    try:
        result = adb.run_shell("cat /proc/diskstats", timeout=8.0)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": str(exc)}

    raw = result.stdout or ""
    if result.returncode != 0 and not raw.strip():
        err = (result.stderr or "cat /proc/diskstats failed").strip()
        return {"ok": False, "error": err}

    all_devs = parse_diskstats(raw)
    selected: dict[str, dict[str, int]] = {}
    missing: list[str] = []
    for name in ordered:
        row = all_devs.get(name)
        if row is None:
            missing.append(name)
            continue
        selected[name] = row

    if not selected:
        return {
            "ok": False,
            "error": f"未找到设备: {', '.join(ordered)}",
            "found": sorted(all_devs.keys()),
            "missing": missing,
        }

    return {
        "ok": True,
        "ts_ms": int(time.time() * 1000),
        "sector_bytes": SECTOR_BYTES,
        "devices": selected,
        "missing": missing,
        "found": sorted(all_devs.keys()),
    }
