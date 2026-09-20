window.OmxVdecPanel = (() => {
  // UI reads an in-memory cache; device ADB runs on a backend poller (~350ms target).
  const POLL_MS = 400;

  let root = null;
  let timer = null;
  let running = false;
  let fetching = false;
  let setting = false;
  let lastControlsKey = "";
  let lastStack = null;
  let didAutoEnableStatus = false;
  let lastSnaps = {};
  let eosHoldAnchor = {};
  let snapping = false;

  function els() {
    return {
      meta: root?.querySelector("#omx-vdec-meta"),
      list: root?.querySelector("#omx-vdec-list"),
      status: root?.querySelector("#omx-vdec-status"),
      controls: root?.querySelector("#omx-vdec-controls"),
      snap: root?.querySelector("#omx-vdec-snap"),
      previews: root?.querySelector("#omx-vdec-previews"),
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

  function fmtDur(ms) {
    const n = Number(ms);
    if (!n || n < 0) return "—";
    if (n < 1000) return `${Math.round(n)} ms`;
    return `${(n / 1000).toFixed(1)}s`;
  }

  function usageChip(u) {
    const purpose = u.purpose || "";
    if (!purpose || purpose === "unset") return "";
    let cls = "muted";
    if (purpose.indexOf("HWC") >= 0) cls = "usage-hwc";
    else if (purpose === "GPU") cls = "usage-gpu";
    const title = [u.hex, u.bits].filter(Boolean).join(" ");
    return `<span class="omx-vdec-chip ${cls}" title="${esc(title)}">${esc(
      purpose
    )}</span>`;
  }

  function liveHoldMs(inst) {
    const e = inst.eos || {};
    const key = snapKey(inst);
    if (!key || e.phase !== "output") {
      if (key) delete eosHoldAnchor[key];
      return Number(e.hold_ms) || 0;
    }
    const reported = Number(e.hold_ms) || 0;
    const now = Date.now();
    const prev = eosHoldAnchor[key];
    if (!prev || reported > prev.holdMs) {
      eosHoldAnchor[key] = { holdMs: reported, wallMs: now };
      return reported;
    }
    return prev.holdMs + (now - prev.wallMs);
  }

  function eosChip(inst) {
    const e = inst.eos || {};
    if (!e.phase || e.phase === "none") return "";
    if (e.phase === "output") {
      return `<span class="omx-vdec-chip eos-hold" title="already returned EOS">EOS hold ${esc(
        fmtDur(liveHoldMs(inst))
      )}</span>`;
    }
    const label =
      e.phase === "decoded"
        ? "EOS decoded"
        : e.phase === "input"
          ? "EOS in"
          : `EOS ${e.phase}`;
    return `<span class="omx-vdec-chip eos-pending">${esc(label)}</span>`;
  }

  function usageText(u) {
    const purpose = u.purpose || "unset";
    const hex = u.hex || (u.consumer != null ? `0x${Number(u.consumer).toString(16)}` : "0x0");
    const bits = u.bits ? ` (${u.bits})` : "";
    return `${esc(purpose)} <code>${esc(hex)}</code>${esc(bits)}`;
  }

  function eosText(inst) {
    const e = inst.eos || {};
    if (!e.phase || e.phase === "none") return "无";
    if (e.phase === "output") {
      return `已报EOS，客户端未停 ${esc(fmtDur(liveHoldMs(inst)))}（入→出 ${esc(
        fmtDur(e.input_to_output_ms)
      )}）`;
    }
    if (e.phase === "decoded") return "解码已EOF，待回填";
    if (e.phase === "input") return "输入已EOF，解码中";
    return esc(e.phase);
  }

  function snapKey(instOrFrame) {
    if (instOrFrame == null) return "";
    const src = instOrFrame.src || "omx";
    if (instOrFrame.log_id != null && instOrFrame.log_id !== "") {
      return `${src}:${instOrFrame.log_id}`;
    }
    if (instOrFrame.id != null) return `${src}:${instOrFrame.id}`;
    return "";
  }

  function snapFor(inst) {
    const key = snapKey(inst);
    const cached = key ? lastSnaps[key] : null;
    if (cached) return { ...(inst.snap || {}), ...cached };
    return inst.snap || {};
  }

  function jpegToObjectUrl(b64) {
    try {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([arr], { type: "image/jpeg" }));
    } catch (err) {
      return "";
    }
  }

  function revokeSnaps(map) {
    Object.keys(map || {}).forEach((k) => {
      const url = map[k]?.objectUrl;
      if (url) URL.revokeObjectURL(url);
    });
  }

  function commitSnaps(frames) {
    const next = {};
    for (const f of frames || []) {
      const key = snapKey(f);
      if (!key) continue;
      const item = { ...f };
      if (item.jpeg && !item.objectUrl) {
        item.objectUrl = jpegToObjectUrl(item.jpeg);
      }
      next[key] = item;
    }
    revokeSnaps(lastSnaps);
    lastSnaps = next;
    renderPreviews(true);
  }

  function renderPreviews(force = false) {
    const { previews } = els();
    if (!previews) return;
    const frames = Object.keys(lastSnaps)
      .map((k) => lastSnaps[k])
      .filter((f) => f && (f.objectUrl || f.jpeg));
    // Decoder teardown empties the instance list; never wipe a captured still.
    if (!frames.length) {
      return;
    }
    const sig = frames
      .map((f) => `${snapKey(f)}:${f.req || ""}:${f.size || f.yuv_bytes || ""}`)
      .join("|");
    if (!force && previews.dataset.sig === sig) {
      previews.hidden = false;
      return;
    }
    previews.dataset.sig = sig;
    previews.hidden = false;
    previews.innerHTML = frames
      .map((f) => {
        const imgSrc = f.objectUrl || `data:image/jpeg;base64,${f.jpeg}`;
        const stackSrc = (f.src || "omx").toUpperCase();
        const title = `${esc(stackSrc)} V${esc(f.log_id ?? snapKey(f))} ${esc(f.w)}×${esc(f.h)} ${esc(
          f.format || ""
        )} ${esc(f.size || f.yuv_bytes || "")}B`;
        return `<figure class="omx-vdec-preview"><img class="omx-vdec-snap" alt="${title}" src="${imgSrc}"><figcaption>${title}</figcaption></figure>`;
      })
      .join("");
  }

  function snapRow(inst) {
    const s = snapFor(inst);
    if (s.jpeg) {
      const info = `${esc(s.w)}×${esc(s.h)} ${esc(s.format || "")} stride ${esc(
        s.stride
      )} ${esc(s.size || s.yuv_bytes || "")}B · 见上方预览`;
      return row("末帧", info);
    }
    if (s.ok) {
      return row(
        "末帧",
        `${esc(s.w)}×${esc(s.h)} ${esc(s.format || "")} <code>${esc(
          s.path || ""
        )}</code>`
      );
    }
    if (s.error) {
      return row("末帧", esc(s.error));
    }
    return row("末帧", "点「抓末帧」获取当前正在交付的帧");
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
    const u = inst.usage || {};
    const e = inst.eos || {};
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

    const srcChip =
      inst.src === "c2"
        ? '<span class="omx-vdec-chip">C2</span>'
        : '<span class="omx-vdec-chip muted">OMX</span>';

    return `
      <article class="omx-vdec-card">
        <header class="omx-vdec-card-head">
          <h3>${esc(inst.id || "V?")}</h3>
          ${srcChip}
          <span class="omx-vdec-chip">${esc(inst.codec || "?")}</span>
          <span class="omx-vdec-chip muted">${esc(flags)}</span>
          ${usageChip(u)}
          ${eosChip(inst)}
          ${wtlChip}
        </header>
        <table class="omx-vdec-table">
          ${row(
            "运行",
            `${yn(inst.running)} / vdec=${esc(inst.vdec_state)} / ${
              inst.src === "c2" ? "mode" : "omx"
            }=${esc(inst.omx_state)}`
          )}
          ${row("用途", usageText(u))}
          ${row("EOS", eosText(inst))}
          ${snapRow(inst)}
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

  function visibleControlGroups(stack) {
    const playing = stack?.playing;
    const preferred = stack?.preferred;
    const current = stack?.current;
    const installed = stack?.installed || [];
    if (playing === "both") return ["OMX", "C2"];
    if (playing === "c2") return ["C2"];
    if (playing === "omx") return ["OMX"];
    if (preferred === "c2" || current === "c2") return ["C2"];
    if (preferred === "omx" || current === "omx") return ["OMX"];
    if (installed.length === 1) {
      return installed[0] === "c2" ? ["C2"] : ["OMX"];
    }
    return ["OMX", "C2"];
  }

  function renderControls(controls, stack) {
    const { controls: host } = els();
    if (!host) return;
    const groups = visibleControlGroups(stack || lastStack);
    const filtered = (controls || []).filter((ctrl) => {
      const group = ctrl.group || "";
      return !group || groups.indexOf(group) >= 0;
    });
    const key = `${groups.join("+")}|${controlsKey(filtered)}`;
    if (key === lastControlsKey && host.childElementCount) return;
    lastControlsKey = key;

    if (!filtered.length) {
      host.innerHTML = '<span class="omx-vdec-ctrl-empty">开关读取中…</span>';
      return;
    }

    const showGroupLabel = groups.length > 1;
    let lastGroup = "";
    host.innerHTML = filtered
      .map((ctrl) => {
        const group = ctrl.group || "";
        const groupHtml =
          showGroupLabel && group && group !== lastGroup
            ? `<span class="omx-vdec-ctrl-empty">${esc(group)}</span>`
            : "";
        lastGroup = group;
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
          return `${groupHtml}
            <label class="omx-vdec-ctrl" title="${esc(title)}">
              <span class="omx-vdec-ctrl-label">${esc(ctrl.label)}</span>
              <select data-ctrl-id="${esc(ctrl.id)}" ${
                setting ? "disabled" : ""
              }>${opts}</select>
            </label>`;
        }
        const on = !!ctrl.on;
        return `${groupHtml}
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
    lastStack = data.codec_stack || lastStack;
    renderControls(data.controls || [], lastStack);
    renderPreviews();

    const instances = data.instances || [];
    const statusOn =
      data.enabled === "1" ||
      data.enabled === "true" ||
      data.c2_enabled === "1" ||
      data.c2_enabled === "true" ||
      !!(data.controls || []).find(
        (c) => (c.id === "vdec_debug" || c.id === "c2_vdec_debug") && c.on
      );
    const n = data.instance_count ?? instances.length;
    const stackLabel = data.codec_stack?.label
      ? `${data.codec_stack.label} · `
      : "";
    setMeta(
      `${stackLabel}${statusOn ? "ON" : "OFF"} · ${fmtUptime(data.server_uptime_ms)} · ×${n}`
    );

    if (!instances.length) {
      const kept = Object.keys(lastSnaps).some(
        (k) => lastSnaps[k]?.objectUrl || lastSnaps[k]?.jpeg
      );
      const hint = data.hint ? `<br/><small>${esc(data.hint)}</small>` : "";
      if (kept) {
        list.innerHTML = `<p class="omx-vdec-empty">decoder 已结束，抓帧预览仍保留在上方${hint}</p>`;
        return;
      }
      const playing = data.codec_stack?.playing;
      if (playing === "c2" || playing === "both") {
        list.innerHTML = `<p class="omx-vdec-empty">正在播 C2，但还没有调试实例。${hint}</p>`;
        return;
      }
      if (playing === "omx") {
        list.innerHTML = `<p class="omx-vdec-empty">正在播 OMX，但还没有调试实例。${hint}</p>`;
        return;
      }
      if (!data.ok) {
        list.innerHTML = `<p class="omx-vdec-empty">${esc(
          data.error || "无状态"
        )}${hint}</p>`;
        return;
      }
      list.innerHTML = `<p class="omx-vdec-empty">无活跃 decoder（开播后会出现实例）${hint}</p>`;
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
      if (data.controls) renderControls(data.controls, lastStack);
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

  async function snapLastFrame() {
    if (snapping) return;
    snapping = true;
    const { snap } = els();
    if (snap) snap.disabled = true;
    setStatus("抓取最后上报帧…");
    try {
      const res = await fetch("/api/omx/vdec/snap", { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error || data.hint || "抓帧失败");
      }
      const n = (data.frames || []).filter((f) => f.ok).length;
      commitSnaps(data.frames || []);
      setStatus(`已抓末帧 ×${n}（req ${data.req}）`);
    } catch (err) {
      setStatus(String(err.message || err), true);
    } finally {
      snapping = false;
      const { snap } = els();
      if (snap) snap.disabled = false;
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
      if (!didAutoEnableStatus && !setting && Array.isArray(data.controls)) {
        const playing = data.codec_stack?.playing;
        const preferred = data.codec_stack?.preferred;
        let ids = ["vdec_debug", "c2_vdec_debug"];
        if (playing === "c2" || (!playing && preferred === "c2")) {
          ids = ["c2_vdec_debug"];
        } else if (playing === "omx" || (!playing && preferred === "omx")) {
          ids = ["vdec_debug"];
        }
        const pending = ids.filter((id) => {
          const dbg = data.controls.find((c) => c.id === id);
          return dbg && !dbg.on;
        });
        if (!pending.length) {
          didAutoEnableStatus = true;
        } else {
          await setControl(pending[0], "1");
        }
      }
      const cost = Math.round(performance.now() - t0);
      const adbMs = data.adb_ms != null ? data.adb_ms : "—";
      const ageMs = data.cache_age_ms != null ? data.cache_age_ms : "—";
      if (!setting && !snapping) {
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
      const { controls, snap } = els();
      controls?.addEventListener("click", onControlsClick);
      controls?.addEventListener("change", onControlsChange);
      snap?.addEventListener("click", (e) => {
        e.stopPropagation();
        snapLastFrame();
      });
    }

    lastControlsKey = "";
    lastStack = null;
    didAutoEnableStatus = false;
    eosHoldAnchor = {};
    start();
  }

  function unmount() {
    stop();
    root = null;
    lastControlsKey = "";
    lastStack = null;
    didAutoEnableStatus = false;
    eosHoldAnchor = {};
    snapping = false;
  }

  return { mount, unmount, start, stop };
})();
