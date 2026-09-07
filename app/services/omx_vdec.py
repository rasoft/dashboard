"""OMX video decoder debug status via ADB (device JSON snapshot).

Hot path: a single background thread pulls with `adb exec-out cat` into an
in-memory cache. HTTP handlers only read the cache, so the UI is not blocked
by 2–3s ADB latency and concurrent browser polls do not stack ADB calls.

Also exposes a small allowlist of persist.vendor.omx.* debug controls.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from typing import Any

from flask import current_app

from app.services import adb

logger = logging.getLogger(__name__)

STATUS_PATH_DEFAULT = "/data/vendor/media/omx_vdec_status.json"
ENABLE_PROP = "persist.vendor.omx.vdec.debug"
JSON_PATH_PROP = "persist.vendor.omx.vdec.debug.json"

# Dashboard-exportable controls only (never free-form setprop).
CONTROLS: list[dict[str, Any]] = [
    {
        "id": "loglevel",
        "prop": "persist.vendor.omx.loglevel",
        "type": "choice",
        "label": "Log",
        "default": "3",
        "choices": [
            {"value": "1", "label": "DEBUG"},
            {"value": "2", "label": "INFO"},
            {"value": "3", "label": "ERROR"},
        ],
        "hint": "新建 decoder 后生效（1=DEBUG 2=INFO 3=ERROR；组件默认 3）",
    },
    {
        "id": "flowctrl",
        "prop": "persist.vendor.omx.flowctrl.en",
        "type": "bool",
        "label": "FlowCtrl",
        "default_on": True,
        "hint": "新建 FlowCtrl / decoder 后生效",
    },
    {
        "id": "dumpes",
        "prop": "persist.vendor.omx.dumpes.en",
        "type": "bool",
        "label": "ES Dump",
        "default_on": False,
        "hint": "新建 decoder 后生效；默认 /data/vendor/media/debug",
    },
    {
        "id": "dumpes_rawpts",
        "prop": "persist.vendor.omx.dumpes.rawpts",
        "type": "bool",
        "label": "ES rawpts",
        "default_on": False,
        "hint": "配合 ES Dump；新建 decoder 后生效",
    },
    {
        "id": "use_wtl",
        "prop": "persist.vendor.omx.use_wtl",
        "type": "bool",
        "label": "WTL",
        "default_on": True,
        "hint": "策略开关；新建 decoder 后生效（实际还看 4K/now_wtl_size）",
    },
    {
        "id": "vdec_debug",
        "prop": ENABLE_PROP,
        "type": "bool",
        "label": "Status",
        "default_on": False,
        "hint": "状态 JSON/HTML 导出；需重新开播才会 register",
    },
]

_CONTROL_BY_ID = {c["id"]: c for c in CONTROLS}
_CONTROL_PROPS = [c["prop"] for c in CONTROLS]

_ROOT_COOLDOWN_S = 30.0
_PROP_REFRESH_S = 3.0
_POLL_TARGET_S = 0.35
_IDLE_STOP_S = 45.0

_root_lock = threading.Lock()
_last_root_mono = 0.0

_cache_lock = threading.Lock()
_cache: dict[str, Any] = {
    "ok": False,
    "error": "尚未采样",
    "path": STATUS_PATH_DEFAULT,
}
_cache_mono = 0.0
_last_client_mono = 0.0

_poller_lock = threading.Lock()
_poller_thread: threading.Thread | None = None
_poller_stop = threading.Event()

_cached_enabled = ""
_cached_path = STATUS_PATH_DEFAULT
_cached_controls: list[dict[str, Any]] = []
_last_prop_mono = 0.0

_SAFE_VALUE_RE = re.compile(r"^[A-Za-z0-9._\-]+$")


def _ensure_root(*, force: bool = False) -> dict[str, Any]:
    """Best-effort adb root. Rate-limited — adb root restarts adbd and is expensive."""
    global _last_root_mono

    with _root_lock:
        now = time.monotonic()
        if not force and _last_root_mono and (now - _last_root_mono) < _ROOT_COOLDOWN_S:
            return {
                "ok": True,
                "skipped": True,
                "steps": [{"step": "adb root", "skipped": True, "reason": "cooldown"}],
            }
        _last_root_mono = now

    steps: list[dict[str, Any]] = []
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
    except OSError as exc:
        return {"ok": False, "error": f"adb root failed: {exc}", "steps": steps}
    except Exception as exc:
        return {"ok": False, "error": f"adb root failed: {exc}", "steps": steps}

    try:
        adb.run_adb(["wait-for-device"], timeout=15.0)
        time.sleep(0.8)
    except Exception as exc:
        return {"ok": False, "error": f"wait-for-device failed: {exc}", "steps": steps}

    return {"ok": True, "steps": steps}


def _prop_on(raw: str, default_on: bool) -> bool:
    value = (raw or "").strip().lower()
    if value in ("1", "true", "on", "yes"):
        return True
    if value in ("0", "false", "off", "no"):
        return False
    return default_on


def _normalize_set_value(ctrl: dict[str, Any], value: Any) -> str | None:
    if ctrl["type"] == "bool":
        if isinstance(value, bool):
            return "1" if value else "0"
        text = str(value).strip().lower()
        if text in ("1", "true", "on", "yes"):
            return "1"
        if text in ("0", "false", "off", "no"):
            return "0"
        return None
    text = str(value).strip()
    if not text or not _SAFE_VALUE_RE.match(text):
        return None
    allowed = {c["value"] for c in ctrl.get("choices") or []}
    if allowed and text not in allowed:
        return None
    return text


def _build_controls(raw_map: dict[str, str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for ctrl in CONTROLS:
        raw = raw_map.get(ctrl["prop"], "")
        item: dict[str, Any] = {
            "id": ctrl["id"],
            "prop": ctrl["prop"],
            "type": ctrl["type"],
            "label": ctrl["label"],
            "hint": ctrl.get("hint", ""),
            "raw": raw,
        }
        if ctrl["type"] == "bool":
            default_on = bool(ctrl.get("default_on", False))
            item["default_on"] = default_on
            item["on"] = _prop_on(raw, default_on)
            item["value"] = "1" if item["on"] else "0"
            item["explicit"] = raw != ""
        else:
            default = str(ctrl.get("default", ""))
            value = raw if raw != "" else default
            # UI only offers 1/2/3 (DEBUG/INFO/ERROR); coerce nearby OMX levels.
            if ctrl["id"] == "loglevel":
                if value == "0":
                    value = "1"
                elif value == "4":
                    value = "3"
                elif value not in ("1", "2", "3"):
                    value = default
            item["default"] = default
            item["value"] = value
            item["choices"] = list(ctrl.get("choices") or [])
            item["explicit"] = raw != ""
        out.append(item)
    return out


def _refresh_props(*, force: bool = False) -> None:
    global _cached_enabled, _cached_path, _cached_controls, _last_prop_mono
    now = time.monotonic()
    if not force and _last_prop_mono and (now - _last_prop_mono) < _PROP_REFRESH_S:
        return

    props = list(dict.fromkeys([*_CONTROL_PROPS, JSON_PATH_PROP]))
    script = " ; ".join(f'echo "__P__|{p}|$(getprop {p})"' for p in props)
    raw_map: dict[str, str] = {}
    try:
        result = adb.run_shell(script, timeout=5.0)
        for line in (result.stdout or "").splitlines():
            if not line.startswith("__P__|"):
                continue
            parts = line.split("|", 2)
            if len(parts) >= 3:
                raw_map[parts[1]] = parts[2].strip()
    except Exception as exc:
        logger.warning("omx props refresh failed: %s", exc)

    _cached_enabled = raw_map.get(ENABLE_PROP, _cached_enabled)
    _cached_path = raw_map.get(JSON_PATH_PROP) or STATUS_PATH_DEFAULT
    _cached_controls = _build_controls(raw_map)
    _last_prop_mono = now


def list_controls() -> dict[str, Any]:
    _refresh_props(force=True)
    return {"ok": True, "controls": list(_cached_controls)}


def set_control(control_id: str, value: Any) -> dict[str, Any]:
    """Set one allowlisted OMX debug prop on device."""
    ctrl = _CONTROL_BY_ID.get(control_id)
    if ctrl is None:
        return {"ok": False, "error": f"unknown control: {control_id}"}

    normalized = _normalize_set_value(ctrl, value)
    if normalized is None:
        return {"ok": False, "error": f"invalid value for {control_id}: {value!r}"}

    status = adb.get_status()
    if not status["available"]:
        return {"ok": False, "error": "no adb device online"}

    root = _ensure_root(force=False)
    if not root.get("ok"):
        return root

    prop = ctrl["prop"]
    try:
        result = adb.run_shell(f"setprop {prop} {normalized}", timeout=5.0)
    except Exception as exc:
        return {"ok": False, "error": str(exc), "steps": root.get("steps")}

    if result.returncode != 0:
        err = (result.stderr or result.stdout or "setprop failed").strip()
        return {"ok": False, "error": err, "prop": prop, "steps": root.get("steps")}

    _refresh_props(force=True)
    try:
        _ensure_poller(current_app._get_current_object())
    except Exception:
        pass

    matched = next((c for c in _cached_controls if c["id"] == control_id), None)
    return {
        "ok": True,
        "id": control_id,
        "prop": prop,
        "value": normalized,
        "control": matched,
        "controls": list(_cached_controls),
        "hint": ctrl.get("hint", ""),
        "steps": root.get("steps"),
    }


def enable() -> dict[str, Any]:
    """Enable OMX VDEC debug status export (compat wrapper)."""
    return set_control("vdec_debug", "1")


def _attach_controls(payload: dict[str, Any]) -> dict[str, Any]:
    out = dict(payload)
    out["controls"] = list(_cached_controls)
    out["enabled"] = _cached_enabled
    out["path"] = out.get("path") or _cached_path or STATUS_PATH_DEFAULT
    return out


def _parse_json_body(raw: str, *, enabled: str, path: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if not text:
        hint = ""
        if enabled not in ("1", "true"):
            hint = f"请先打开 Status（{ENABLE_PROP}=1），并重新开播"
        else:
            hint = "调试已开但尚无状态文件：需 userdebug OMX 构建，且至少创建过一个 decoder"
        return {
            "ok": False,
            "error": "无法读取 OMX 状态文件（空）",
            "hint": hint,
            "path": path,
            "enabled": enabled,
        }

    lower = text.lower()
    if "permission denied" in lower:
        return {
            "ok": False,
            "error": "permission denied",
            "hint": "打开 Status 或手动 adb root 后再试",
            "path": path,
            "enabled": enabled,
            "permission_denied": True,
        }
    if "no such file" in lower or "not found" in lower:
        return {
            "ok": False,
            "error": text[:200],
            "hint": "尚无状态文件：确认 Status 已开并重新开播",
            "path": path,
            "enabled": enabled,
        }

    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        return {
            "ok": False,
            "error": f"JSON 解析失败: {exc}",
            "path": path,
            "enabled": enabled,
            "raw": text[:800],
        }

    if not isinstance(payload, dict):
        return {
            "ok": False,
            "error": "状态文件根节点不是 object",
            "path": path,
            "enabled": enabled,
        }

    instances = payload.get("instances")
    if not isinstance(instances, list):
        instances = []

    return {
        "ok": True,
        "path": path,
        "enabled": enabled,
        "status_path": payload.get("status_path", path),
        "server_uptime_ms": payload.get("server_uptime_ms", 0),
        "instance_count": payload.get("instance_count", len(instances)),
        "instances": instances,
    }


def _pull_once() -> dict[str, Any]:
    """Fast device read: prefer `adb exec-out cat` (no PTY), fallback to shell."""
    _refresh_props(force=False)
    path = _cached_path or STATUS_PATH_DEFAULT
    enabled = _cached_enabled
    t0 = time.monotonic()

    raw = ""
    err = ""
    try:
        result = adb.run_adb(["exec-out", "cat", path], timeout=4.0)
        raw = result.stdout or ""
        if result.returncode != 0 and not raw.strip():
            err = (result.stderr or "").strip()
            shell = adb.run_shell(f'cat "{path}" 2>&1', timeout=4.0)
            raw = shell.stdout or ""
            if shell.returncode != 0 and not raw.strip():
                err = (shell.stderr or err or "cat failed").strip()
    except Exception as exc:
        return _attach_controls(
            {
                "ok": False,
                "error": str(exc),
                "path": path,
                "enabled": enabled,
                "adb_ms": int((time.monotonic() - t0) * 1000),
            }
        )

    parsed = _parse_json_body(raw, enabled=enabled, path=path)
    parsed["adb_ms"] = int((time.monotonic() - t0) * 1000)

    if parsed.get("permission_denied"):
        root = _ensure_root(force=False)
        if root.get("ok") and not root.get("skipped"):
            return _pull_once()

    return _attach_controls(parsed)


def _set_cache(payload: dict[str, Any]) -> None:
    global _cache, _cache_mono
    with _cache_lock:
        _cache = dict(payload)
        _cache_mono = time.monotonic()


def _poll_loop(app) -> None:
    logger.info("omx_vdec poller started")
    try:
        with app.app_context():
            while not _poller_stop.is_set():
                if time.monotonic() - _last_client_mono > _IDLE_STOP_S:
                    logger.info("omx_vdec poller idle-stop")
                    break
                t0 = time.monotonic()
                try:
                    payload = _pull_once()
                    _set_cache(payload)
                except Exception:
                    logger.exception("omx_vdec poll failed")
                    _set_cache(
                        _attach_controls(
                            {
                                "ok": False,
                                "error": "poll failed",
                                "path": _cached_path or STATUS_PATH_DEFAULT,
                                "enabled": _cached_enabled,
                            }
                        )
                    )
                elapsed = time.monotonic() - t0
                delay = max(0.05, _POLL_TARGET_S - elapsed)
                if _poller_stop.wait(delay):
                    break
    finally:
        with _poller_lock:
            global _poller_thread
            _poller_thread = None
        logger.info("omx_vdec poller stopped")


def _ensure_poller(app) -> None:
    global _poller_thread, _last_client_mono
    _last_client_mono = time.monotonic()
    with _poller_lock:
        alive = _poller_thread is not None and _poller_thread.is_alive()
        if alive:
            return
        _poller_stop.clear()
        thread = threading.Thread(
            target=_poll_loop,
            args=(app,),
            name="omx-vdec-poller",
            daemon=True,
        )
        _poller_thread = thread
        thread.start()


def sample() -> dict[str, Any]:
    """Return latest cached OMX status; keep background poller alive."""
    app = current_app._get_current_object()
    _ensure_poller(app)

    with _cache_lock:
        payload = dict(_cache)
        age_ms = int((time.monotonic() - _cache_mono) * 1000) if _cache_mono else None

    if age_ms is None or (not payload.get("ok") and payload.get("error") == "尚未采样"):
        deadline = time.monotonic() + 4.0
        while time.monotonic() < deadline:
            time.sleep(0.05)
            with _cache_lock:
                payload = dict(_cache)
                age_ms = int((time.monotonic() - _cache_mono) * 1000) if _cache_mono else None
            if age_ms is not None and payload.get("error") != "尚未采样":
                break

    if "controls" not in payload:
        payload = _attach_controls(payload)
    payload["cache_age_ms"] = age_ms
    payload["poll_target_ms"] = int(_POLL_TARGET_S * 1000)
    return payload
