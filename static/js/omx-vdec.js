window.OmxVdecPanel = (() => {
  // UI reads an in-memory cache; device ADB runs on a backend poller (~350ms target).
  const POLL_MS = 400;

  let root = null;
  let timer = null;
  let running = false;
  let fetching = false;
  let setting = false;
  let lastControlsKey = "";
  let didAutoEnableStatus = false;

  function els() {
    return {
      meta: root?.querySelector("#omx-vdec-meta"),
      list: root?.querySelector("#omx-vdec-list"),
      status: root?.querySelector("#omx-vdec-status"),
      controls: root?.querySelector("#omx-vdec-controls"),
    };
  }

  function setStatus(text, isError = false) {
    const { status } = els();
    if (!status) return;
    status.textContent = text;
    status.classList.toggle("error", !!isError);
  }

  function setMeta(text) {
    const { meta } = els();
    if (meta) meta.textContent = text;
  }

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtPts(us) {
    if (us == null || us === "") return "—";
    const n = Number(us);
    if (Number.isNaN(n)) return String(us);
    if (n < 0) return String(n);
    return `${(n / 1000).toFixed(3)} ms`;
  }

  function fmtMono(ms) {
    if (!ms) return "—";
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) return String(ms);
    return (
      d.toLocaleTimeString("zh-CN", { hour12: false }) +
      "." +
      String(d.getMilliseconds()).padStart(3, "0")
    );
  }

  function yn(v) {
    return v ? "是" : "否";
  }

  function row(th, td) {
    return `<tr><th>${esc(th)}</th><td>${td}</td></tr>`;
  }

  function renderInstance(inst) {
    const r = inst.resolution || {};
    const b = inst.buffers || {};
    const inp = inst.input || {};
    const out = inst.output || {};
    const fc = inst.flowctrl || {};
    const pad =
      r.aligned_w !== r.clip_w || r.aligned_h !== r.clip_h ? " (padding)" : "";
    const timeout =
      fc.wait_timeout_count
        ? `，超时 ${esc(fc.wait_timeout_count)} 次（最近 pending=${esc(
            fc.last_wait_timeout_pending
          )}, ${esc(fmtMono(fc.last_wait_timeout_mono_ms))}）`
        : "";

    const wtlSize = Number(b.now_wtl_size) || 0;
    const wtlActive = wtlSize > 0;
    const showWtl = !!inst.use_wtl || wtlActive;
    const flags = [inst.secure ? "DRM" : "clear", inst.compress ? "compress" : null]
      .filter(Boolean)
      .join(" · ");
    const wtlChip = showWtl
      ? `<span class="omx-vdec-chip ${
          wtlActive ? "wtl-on" : "muted"
        }" title="${
          wtlActive
            ? `WTL active · now_wtl_size=${wtlSize}`
            : "WTL pref on, not active (now_wtl_size=0)"
        }">WTL</span>`
      : "";

    return `
      <article class="omx-vdec-card">
        <header class="omx-vdec-card-head">
          <h3>${esc(inst.id || "V?")}</h3>
          <span class="omx-vdec-chip">${esc(inst.codec || "?")}</span>
          <span class="omx-vdec-chip muted">${esc(flags)}</span>
          ${wtlChip}
        </header>
        <table class="omx-vdec-table">
          ${row(
            "运行",
            `${yn(inst.running)} / vdec=${esc(inst.vdec_state)} / omx=${esc(
              inst.omx_state
            )}`
          )}
          ${row(
            "分辨率",
            `clip ${esc(r.clip_w)}×${esc(r.clip_h)} aligned ${esc(
              r.aligned_w
            )}×${esc(r.aligned_h)}${esc(pad)}`
          )}
          ${row(
            "Buffer",
            `driver_need=${esc(b.driver_need)} max=${esc(b.max)} min=${esc(
              b.min
            )} attached=${esc(b.attached)} now=${esc(b.now_fb_size)}/${esc(
              b.now_wtl_size
            )}`
          )}
          ${row(
            "输入(最后)",
            `${esc(inp.last_bytes)} bytes, PTS ${esc(fmtPts(inp.last_pts_us))}`
          )}
          ${row(
            "输入(累计)",
            `total_input=${esc(inp.total_input)}, ${esc(
              inp.total_packets
            )} pkts, ${esc(inp.avg_bitrate_kbps)} kbps`
          )}
          ${row(
            "输出(最后)",
            `当前 #${esc(out.current_frame)}, PTS ${esc(
              fmtPts(out.last_pts_us)
            )}`
          )}
          ${row(
            "输出(累计)",
            `共 ${esc(out.total_frames)} 帧, ${esc(out.avg_fps)} fps`
          )}
          ${row(
            "FlowCtrl",
            `${fc.enabled ? "开" : "关"} pending=${esc(fc.pending)}/${esc(
              fc.max_pending
            )}${timeout}`
          )}
          ${row("Handle", `<code>${esc(inst.vdec_handle || "—")}</code>`)}
        </table>
      </article>`;
  }

  function fmtUptime(ms) {
    const n = Number(ms) || 0;
    if (n < 10000) return `${n}ms`;
    const s = Math.floor(n / 1000);
    if (s < 3600) {
      const m = Math.floor(s / 60);
      const r = s % 60;
      return m ? `${m}m${String(r).padStart(2, "0")}s` : `${s}s`;
    }
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h${String(m).padStart(2, "0")}m`;
  }

  function controlsKey(controls) {
    return (controls || [])
      .map((c) => `${c.id}:${c.value}:${c.raw || ""}:${c.on ? 1 : 0}`)
      .join("|");
  }

  function renderControls(controls) {
    const { controls: host } = els();
    if (!host) return;
    const key = controlsKey(controls);
    if (key === lastControlsKey && host.childElementCount) return;
    lastControlsKey = key;

    if (!controls || !controls.length) {
      host.innerHTML = '<span class="omx-vdec-ctrl-empty">开关读取中…</span>';
      return;
    }

    host.innerHTML = controls
      .map((ctrl) => {
        const title = `${ctrl.prop}${ctrl.hint ? " · " + ctrl.hint : ""}`;
        if (ctrl.type === "choice") {
          const opts = (ctrl.choices || [])
            .map(
              (c) =>
                `<option value="${esc(c.value)}" ${
                  String(ctrl.value) === String(c.value) ? "selected" : ""
                }>${esc(c.label)}</option>`
            )
            .join("");
          return `
            <label class="omx-vdec-ctrl" title="${esc(title)}">
              <span class="omx-vdec-ctrl-label">${esc(ctrl.label)}</span>
              <select data-ctrl-id="${esc(ctrl.id)}" ${
                setting ? "disabled" : ""
              }>${opts}</select>
            </label>`;
        }
        const on = !!ctrl.on;
        return `
          <button type="button"
            class="omx-vdec-toggle ${on ? "on" : "off"}"
            data-ctrl-id="${esc(ctrl.id)}"
            data-on="${on ? "1" : "0"}"
            title="${esc(title)}"
            ${setting ? "disabled" : ""}>
            ${esc(ctrl.label)}
          </button>`;
      })
      .join("");
  }

  function render(data) {
    const { list } = els();
    if (!list) return;
    renderControls(data.controls || []);

    // Opening the panel implies we want status export; enable once if still off.
    if (!didAutoEnableStatus && !setting && Array.isArray(data.controls)) {
      didAutoEnableStatus = true;
      const dbg = data.controls.find((c) => c.id === "vdec_debug");
      if (dbg && !dbg.on) {
        setControl("vdec_debug", "1");
      }
    }

    const instances = data.instances || [];
    const statusOn =
      data.enabled === "1" ||
      data.enabled === "true" ||
      !!(data.controls || []).find((c) => c.id === "vdec_debug" && c.on);
    const n = data.instance_count ?? instances.length;
    setMeta(
      `${statusOn ? "ON" : "OFF"} · ${fmtUptime(data.server_uptime_ms)} · ×${n}`
    );

    if (!data.ok) {
      list.innerHTML = `<p class="omx-vdec-empty">${esc(
        data.error || "无状态"
      )}${data.hint ? `<br/><small>${esc(data.hint)}</small>` : ""}</p>`;
      return;
    }
    if (!instances.length) {
      list.innerHTML =
        '<p class="omx-vdec-empty">无活跃 decoder（开播后会出现实例）</p>';
      return;
    }
    list.innerHTML = instances.map(renderInstance).join("");
  }

  async function fetchSample() {
    const res = await fetch("/api/omx/vdec");
    const data = await res.json();
    // Always return payload so controls can update even when status file is missing.
    return data;
  }

  async function setControl(id, value) {
    if (setting) return;
    setting = true;
    setStatus(`设置 ${id}=${value} …`);
    try {
      const res = await fetch("/api/omx/controls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, value }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "设置失败");
      lastControlsKey = "";
      if (data.controls) renderControls(data.controls);
      setStatus(
        `已设置 ${data.prop}=${data.value}${data.hint ? " — " + data.hint : ""}`
      );
      if (!fetching) await tick();
    } catch (err) {
      setStatus(String(err.message || err), true);
      lastControlsKey = "";
      if (!fetching) await tick();
    } finally {
      setting = false;
    }
  }

  async function tick() {
    if (!running) return;
    if (fetching) {
      scheduleNext(POLL_MS);
      return;
    }
    if (window.Dashboard?.isPaused?.()) {
      scheduleNext(POLL_MS);
      return;
    }
    fetching = true;
    const t0 = performance.now();
    try {
      const data = await fetchSample();
      render(data);
      const cost = Math.round(performance.now() - t0);
      const adbMs = data.adb_ms != null ? data.adb_ms : "—";
      const ageMs = data.cache_age_ms != null ? data.cache_age_ms : "—";
      if (!setting) {
        setStatus(
          `监测中 · UI ${cost}ms · 缓存龄 ${ageMs}ms · ADB ${adbMs}ms · ${new Date().toLocaleTimeString(
            "zh-CN",
            { hour12: false }
          )}`
        );
      }
      scheduleNext(Math.max(0, POLL_MS - cost));
    } catch (err) {
      setStatus(String(err.message || err), true);
      scheduleNext(POLL_MS);
    } finally {
      fetching = false;
    }
  }

  function scheduleNext(delayMs = POLL_MS) {
    if (!running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      tick();
    }, delayMs);
  }

  function onControlsClick(e) {
    const btn = e.target.closest(".omx-vdec-toggle");
    if (!btn || !root.contains(btn)) return;
    e.stopPropagation();
    const id = btn.dataset.ctrlId;
    const next = btn.dataset.on === "1" ? "0" : "1";
    setControl(id, next);
  }

  function onControlsChange(e) {
    const sel = e.target.closest("select[data-ctrl-id]");
    if (!sel || !root.contains(sel)) return;
    e.stopPropagation();
    setControl(sel.dataset.ctrlId, sel.value);
  }

  function stop() {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function start() {
    if (running) return;
    running = true;
    setStatus("监测中…");
    tick();
  }

  function mount(panelEl) {
    root = panelEl.querySelector(".omx-vdec");
    if (!root) return;

    if (root.dataset.bound !== "1") {
      root.dataset.bound = "1";
      const { controls } = els();
      controls?.addEventListener("click", onControlsClick);
      controls?.addEventListener("change", onControlsChange);
    }

    lastControlsKey = "";
    didAutoEnableStatus = false;
    start();
  }

  function unmount() {
    stop();
    root = null;
    lastControlsKey = "";
    didAutoEnableStatus = false;
  }

  return { mount, unmount, start, stop };
})();
