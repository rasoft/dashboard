"""DDR memory bandwidth monitor via ADB debugfs."""

from __future__ import annotations

import logging
import re
import subprocess
from typing import Any

from app.services import adb

logger = logging.getLogger(__name__)

TARGET_NAME = "cpu_a55_main"
DEFAULT_TARGETS = (
    "cpu_a55_main",
    "gpu",
    "vpu",
    "audio",
    "vdec_4k",
    "vdec_2k_jpeg",
    "emmc_sd",
    "usb_pcie",
    "phy_eth_dac",
)
ENABLE_PATH = "/sys/kernel/debug/ddr/monitor/enable"
STATUS_PATH = "/sys/kernel/debug/ddr/monitor/status_raw"

_FREQ_RE = re.compile(r"DDR\s+Frequency:\s*(\d+)\s*Hz", re.IGNORECASE)
# Prefer matching by client name, then the 7 numeric columns that follow.
# Works with or without a leading monitor id (mnt0/mnt3/...), and with \r.
_NUMS = r"(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)"


def _shell(command: str, timeout: float = 8.0) -> subprocess.CompletedProcess[str]:
    return adb.run_shell(command, timeout=timeout)


def enable_monitor() -> dict[str, Any]:
    """Prepare debugfs DDR monitor on the connected Android board."""
    status = adb.get_status()
    if not status["available"]:
        return {"ok": False, "error": "no adb device online"}

    steps: list[dict[str, Any]] = []

    # adb root (may already be root)
    try:
        root = adb.run_adb(["root"], timeout=12.0)
        steps.append(
            {
                "step": "adb root",
                "returncode": root.returncode,
                "stdout": (root.stdout or "").strip()[:200],
                "stderr": (root.stderr or "").strip()[:200],
            }
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": f"adb root failed: {exc}", "steps": steps}

    # Wait briefly for adbd to restart after root
    try:
        adb.run_adb(["wait-for-device"], timeout=15.0)
    except (OSError, subprocess.TimeoutExpired):
        pass

    commands = [
        ("mount debugfs", "mount debugfs /sys/kernel/debug -t debugfs"),
        ("enable monitor", f"echo 1 > {ENABLE_PATH}"),
    ]
    for name, cmd in commands:
        try:
            result = _shell(cmd, timeout=8.0)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return {"ok": False, "error": f"{name} failed: {exc}", "steps": steps}
        steps.append(
            {
                "step": name,
                "returncode": result.returncode,
                "stdout": (result.stdout or "").strip()[:200],
                "stderr": (result.stderr or "").strip()[:200],
            }
        )
        # Mount may fail if already mounted; enabling must succeed.
        if name == "enable monitor" and result.returncode != 0:
            err = (result.stderr or result.stdout or "enable failed").strip()
            return {"ok": False, "error": err, "steps": steps}

    return {"ok": True, "steps": steps}


def _row_dict(name: str, nums: tuple[str, ...], freq_hz: int | None) -> dict[str, Any]:
    return {
        "name": name,
        "rd_bps": int(nums[0]),
        "wr_bps": int(nums[1]),
        "total_bps": int(nums[2]),
        "rd_lat": int(nums[3]),
        "wr_lat": int(nums[4]),
        "rd_trans": int(nums[5]),
        "wr_trans": int(nums[6]),
        "freq_hz": freq_hz,
    }


def _list_client_names(text: str) -> list[str]:
    """Best-effort list of monitor client names for diagnostics."""
    names: list[str] = []
    # mntX <name> <numbers...>  OR  <name> <numbers...>
    generic = re.compile(rf"^(?:\S+\s+)?(\S+)\s+{_NUMS}\s*$")
    for raw in (text or "").splitlines():
        line = raw.replace("\r", "").strip()
        if not line or line.startswith("Monitor") or line.startswith("------"):
            continue
        m = generic.match(line)
        if not m:
            continue
        name = m.group(1)
        if name and name not in names and not name.isdigit():
            names.append(name)
    return names


def parse_status_raw(text: str, target: str = TARGET_NAME) -> dict[str, Any] | None:
    """Parse status_raw text and extract a single target monitor row."""
    parsed = parse_status_raw_multi(text, targets=[target])
    return (parsed.get("clients") or {}).get(target)


def parse_status_raw_multi(
    text: str, targets: list[str] | tuple[str, ...] = DEFAULT_TARGETS
) -> dict[str, Any]:
    """Parse status_raw and extract multiple monitor rows."""
    freq_hz = None
    m = _FREQ_RE.search(text or "")
    if m:
        freq_hz = int(m.group(1))

    clients: dict[str, Any] = {}
    for target in targets:
        if target in clients:
            continue
        # Match "<target> RD WR Total RDLat WRLat RDTrans WRTrans" anywhere in line.
        pat = re.compile(
            rf"(?:^|\s){re.escape(target)}\s+{_NUMS}\s*$",
            re.MULTILINE,
        )
        hit = pat.search(text or "")
        if not hit:
            # Also try per-line after stripping CR.
            for raw in (text or "").splitlines():
                line = raw.replace("\r", "").strip()
                hit = re.search(rf"(?:^|\s){re.escape(target)}\s+{_NUMS}\s*$", line)
                if hit:
                    break
        if not hit:
            continue
        clients[target] = _row_dict(target, hit.groups(), freq_hz)

    return {"freq_hz": freq_hz, "clients": clients}


def parse_all_unique_clients(text: str) -> dict[str, Any]:
    """Parse every monitor row; duplicate names (e.g. vdec_4k) keep the first only."""
    freq_hz = None
    m = _FREQ_RE.search(text or "")
    if m:
        freq_hz = int(m.group(1))

    generic = re.compile(rf"^(?:\S+\s+)?(\S+)\s+{_NUMS}\s*$")
    clients: dict[str, Any] = {}
    for raw in (text or "").splitlines():
        line = raw.replace("\r", "").strip()
        if not line or line.startswith("Monitor") or line.startswith("------"):
            continue
        row = generic.match(line)
        if not row:
            continue
        name = row.group(1)
        if not name or name.isdigit() or name in clients:
            continue
        clients[name] = _row_dict(name, row.groups()[1:], freq_hz)

    return {"freq_hz": freq_hz, "clients": clients}


def sum_clients(clients: dict[str, Any]) -> dict[str, int]:
    """Sum RD/WR/Total across unique clients."""
    rd = wr = total = 0
    for row in clients.values():
        rd += int(row.get("rd_bps") or 0)
        wr += int(row.get("wr_bps") or 0)
        total += int(row.get("total_bps") or 0)
    return {"rd_bps": rd, "wr_bps": wr, "total_bps": total, "name": "total"}


def sample(
    targets: list[str] | tuple[str, ...] | None = None,
    target: str | None = None,
) -> dict[str, Any]:
    """Read one DDR monitor sample for one or more client names."""
    if targets is None:
        if target:
            targets = [target]
        else:
            targets = list(DEFAULT_TARGETS)

    status = adb.get_status()
    if not status["available"]:
        return {"ok": False, "error": "no adb device online"}

    try:
        result = _shell(f"cat {STATUS_PATH}", timeout=8.0)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": str(exc)}

    raw = result.stdout or ""
    if result.returncode != 0:
        err = (result.stderr or raw or "cat status_raw failed").strip()
        return {"ok": False, "error": err}

    all_parsed = parse_all_unique_clients(raw)
    all_clients = all_parsed["clients"]
    total = sum_clients(all_clients)

    parsed = parse_status_raw_multi(raw, targets=targets)
    clients = parsed["clients"]
    missing = [t for t in targets if t not in clients]
    if len(clients) == 0 and len(all_clients) == 0:
        found = _list_client_names(raw)
        return {
            "ok": False,
            "error": (
                f"target(s) not found in status_raw: {', '.join(targets)}"
                + (f"；当前可见: {', '.join(found)}" if found else "；未解析到任何 client")
            ),
            "raw": raw[:800],
            "found": found,
            "clients": {},
            "total": total,
            "freq_hz": parsed["freq_hz"],
        }

    # Prefer requested targets; fall back to all unique clients for charts.
    if not clients:
        clients = {t: all_clients[t] for t in targets if t in all_clients}
        missing = [t for t in targets if t not in clients]

    payload: dict[str, Any] = {
        "ok": True,
        "freq_hz": all_parsed["freq_hz"] or parsed["freq_hz"],
        "clients": clients,
        "all_clients": all_clients,
        "total": total,
        "missing": missing,
    }
    if missing:
        payload["warning"] = f"缺少: {', '.join(missing)}"
    if len(targets) == 1 and targets[0] in clients:
        payload.update(clients[targets[0]])
    return payload
