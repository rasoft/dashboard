function createVdecPanel(cfg) {
  // UI reads an in-memory cache; device ADB runs on a backend poller (~350ms target).
  const STACK = cfg.stack;
  const GROUP = cfg.group;
  const STATUS_ID = cfg.statusId;
  const DUMPFRAME_ID = cfg.dumpframeId;
  const IDS = cfg.ids;
  const API = cfg.api;
  const POLL_MS = 400;

  let root = null;
  let timer = null;
  let running = false;
  let fetching = false;
  let setting = false;
  let lastControlsKey = "";
  let didAutoEnableStatus = false;
  let lastSnaps = {};
  let eosHoldAnchor = {};
  let autoSnapping = false;
  let lastAutoSnapSig = "";

  function els() {
    return {
      meta: root?.querySelector(IDS.meta),
      list: root?.querySelector(IDS.list),
      status: root?.querySelector(IDS.status),
      controls: root?.querySelector(IDS.controls),
      previews: root?.querySelector(IDS.previews),
      clearTemps: root?.querySelector(IDS.clearTemps),
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
    const src = instOrFrame.src || STACK;
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

  function frameTitle(f) {
    const stackSrc = (f.src || STACK).toUpperCase();
    return `${stackSrc} V${f.log_id ?? snapKey(f)} ${f.w}×${f.h} ${f.format || ""} ${
      f.size || f.yuv_bytes || ""
    }B`.replace(/\s+/g, " ").trim();
  }

  function frameSrc(f) {
    return f.objectUrl || (f.jpeg ? `data:image/jpeg;base64,${f.jpeg}` : "");
  }

  function swapPreviewSrc(img, nextSrc) {
    if (!img || !nextSrc || img.dataset.url === nextSrc) return;
    const prevSrc = img.dataset.url || "";
    const gen = String(Number(img.dataset.gen || "0") + 1);
    img.dataset.gen = gen;
    const probe = new Image();
    probe.onload = () => {
      if (img.dataset.gen !== gen) {
        if (nextSrc.startsWith("blob:")) URL.revokeObjectURL(nextSrc);
        return;
      }
      img.src = nextSrc;
      img.dataset.url = nextSrc;
      if (prevSrc.startsWith("blob:") && prevSrc !== nextSrc) {
        URL.revokeObjectURL(prevSrc);
      }
    };
    probe.onerror = () => {
      if (img.dataset.gen !== gen) return;
      img.src = nextSrc;
      img.dataset.url = nextSrc;
    };
    probe.src = nextSrc;
  }

  function liveSnapKeys(instances) {
    const keys = new Set();
    for (const inst of instances || []) {
      const key = snapKey(inst);
      if (key) keys.add(key);
    }
    return keys;
  }

  function pruneSnaps(keepKeys) {
    const drop = {};
    if (!keepKeys || !keepKeys.size) return drop;
    for (const key of Object.keys(lastSnaps)) {
      if (keepKeys.has(key)) continue;
      drop[key] = lastSnaps[key];
      delete lastSnaps[key];
    }
    return drop;
  }

  function mergeSnaps(frames, keepKeys) {
    const dropped = keepKeys && keepKeys.size ? pruneSnaps(keepKeys) : {};
    for (const f of frames || []) {
      const key = snapKey(f);
      if (!key) continue;
      if (keepKeys && keepKeys.size && !keepKeys.has(key)) continue;
      const item = { ...f };
      if (item.jpeg && !item.objectUrl) {
        item.objectUrl = jpegToObjectUrl(item.jpeg);
      }
      lastSnaps[key] = item;
    }
    renderPreviews(true);
    revokeSnaps(dropped);
  }

  function renderPreviews(force = false) {
    const { previews } = els();
    if (!previews) return;
    const frames = Object.keys(lastSnaps)
      .map((k) => lastSnaps[k])
      .filter((f) => f && (f.objectUrl || f.jpeg));
    if (!frames.length) {
      if (force) {
        previews.innerHTML = "";
        delete previews.dataset.sig;
        previews.hidden = true;
      }
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

    const seen = new Set();
    for (const f of frames) {
      const key = snapKey(f);
      seen.add(key);
      let fig = previews.querySelector(`figure[data-key="${esc(key)}"]`);
      if (!fig) {
        fig = document.createElement("figure");
        fig.className = "omx-vdec-preview";
        fig.dataset.key = key;
        fig.innerHTML =
          '<img class="omx-vdec-snap" alt="" decoding="async"><figcaption></figcaption>';
        previews.appendChild(fig);
      }
      const img = fig.querySelector("img");
      const cap = fig.querySelector("figcaption");
      const title = frameTitle(f);
      if (cap) cap.textContent = title;
      if (img) {
        img.alt = "";
        img.title = title;
        if (f.w && f.h) img.style.aspectRatio = `${Number(f.w)} / ${Number(f.h)}`;
        swapPreviewSrc(img, frameSrc(f));
      }
    }
    Array.from(previews.querySelectorAll("figure[data-key]")).forEach((fig) => {
      if (!seen.has(fig.dataset.key)) fig.remove();
    });
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
    return row("末帧", `打开 ${GROUP} DumpFrame 并重新开播后约每秒更新预览`);
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
      (inst.src || STACK) === "c2"
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
              (inst.src || STACK) === "c2" ? "mode" : "omx"
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

  function visibleControlGroups() {
    return [GROUP];
  }

  function renderControls(controls) {
    const { controls: host } = els();
    if (!host) return;
    const groups = visibleControlGroups();
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
    renderControls(data.controls || []);

    const instances = data.instances || [];
    const dropped = instances.length ? pruneSnaps(liveSnapKeys(instances)) : {};
    renderPreviews(!!Object.keys(dropped).length);
    revokeSnaps(dropped);
    const statusOn =
      data.enabled === "1" ||
      data.enabled === "true" ||
      !!(data.controls || []).find((c) => c.id === STATUS_ID && c.on);
    const n = data.instance_count ?? instances.length;
    setMeta(
      `${statusOn ? "ON" : "OFF"} · ${fmtUptime(data.server_uptime_ms)} · ×${n}`
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
    const res = await fetch(API.sample);
    const data = await res.json();
    // Always return payload so controls can update even when status file is missing.
    return data;
  }

  async function setControl(id, value) {
    if (setting) return;
    setting = true;
    setStatus(`设置 ${id}=${value} …`);
    try {
      const res = await fetch(API.controls, {
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

  async function pullLivePreview(data) {
    const ctrls = data.controls || [];
    const dumpOn = !!ctrls.find((c) => c.id === DUMPFRAME_ID && c.on);
    if (!dumpOn || autoSnapping) return;
    const inst = (data.instances || []).filter((i) => {
      if (!i.snap || !(i.snap.ok || i.snap.req)) return false;
      return (i.src || STACK) === STACK;
    });
    if (!inst.length) return;
    const sig = inst
      .map(
        (i) =>
          `${i.src || STACK}:${i.log_id ?? i.id}:${i.snap?.req ?? ""}:${i.snap?.pts_us ?? ""}`
      )
      .join("|");
    if (!sig || sig === lastAutoSnapSig) return;
    autoSnapping = true;
    try {
      const res = await fetch(API.preview);
      const body = await res.json();
      if (body.ok) {
        lastAutoSnapSig = sig;
        mergeSnaps(body.frames || [], liveSnapKeys(inst));
      }
    } catch (err) {
      console.warn("dumpframe preview", err);
    } finally {
      autoSnapping = false;
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
      pullLivePreview(data);
      if (!didAutoEnableStatus && !setting && Array.isArray(data.controls)) {
        const dbg = data.controls.find((c) => c.id === STATUS_ID);
        if (!dbg || dbg.on) {
          didAutoEnableStatus = true;
        } else {
          await setControl(STATUS_ID, "1");
        }
      }
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

  function wipePreviews() {
    revokeSnaps(lastSnaps);
    lastSnaps = {};
    lastAutoSnapSig = "";
    autoSnapping = false;
    const { previews } = els();
    if (previews) {
      previews.innerHTML = "";
      previews.hidden = true;
      delete previews.dataset.sig;
    }
  }

  async function clearDebugTemps() {
    if (setting) return;
    const { clearTemps } = els();
    setting = true;
    if (clearTemps) clearTemps.disabled = true;
    setStatus(`删除 ${GROUP} 抓帧临时文件…`);
    try {
      const res = await fetch(API.clearTemps, { method: "POST" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "删除失败");
      wipePreviews();
      const n = data.removed != null ? data.removed : 0;
      setStatus(`已删除 ${n} 个抓帧文件（${STACK}_last_frame）`);
    } catch (err) {
      setStatus(String(err.message || err), true);
    } finally {
      setting = false;
      if (clearTemps) clearTemps.disabled = false;
    }
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
      const { controls, clearTemps } = els();
      controls?.addEventListener("click", onControlsClick);
      controls?.addEventListener("change", onControlsChange);
      clearTemps?.addEventListener("click", (e) => {
        e.stopPropagation();
        clearDebugTemps();
      });
    }

    lastControlsKey = "";
    didAutoEnableStatus = false;
    eosHoldAnchor = {};
    lastAutoSnapSig = "";
    autoSnapping = false;
    start();
  }

  function unmount() {
    revokeSnaps(lastSnaps);
    lastSnaps = {};
    stop();
    root = null;
    lastControlsKey = "";
    didAutoEnableStatus = false;
    eosHoldAnchor = {};
    autoSnapping = false;
    lastAutoSnapSig = "";
  }

  return { mount, unmount, start, stop };
}

window.OmxVdecPanel = createVdecPanel({
  stack: "omx",
  group: "OMX",
  statusId: "vdec_debug",
  dumpframeId: "omx_dumpframe",
  ids: {
    meta: "#omx-vdec-meta",
    list: "#omx-vdec-list",
    status: "#omx-vdec-status",
    controls: "#omx-vdec-controls",
    previews: "#omx-vdec-previews",
    clearTemps: "#omx-vdec-clear-temps",
  },
  api: {
    sample: "/api/omx/vdec",
    controls: "/api/omx/controls",
    preview: "/api/omx/vdec/preview",
    clearTemps: "/api/omx/vdec/clear-temps",
  },
});

window.C2VdecPanel = createVdecPanel({
  stack: "c2",
  group: "C2",
  statusId: "",
  dumpframeId: "c2_dumpframe",
  ids: {
    meta: "#c2-vdec-meta",
    list: "#c2-vdec-list",
    status: "#c2-vdec-status",
    controls: "#c2-vdec-controls",
    previews: "#c2-vdec-previews",
    clearTemps: "#c2-vdec-clear-temps",
  },
  api: {
    sample: "/api/c2/vdec",
    controls: "/api/c2/controls",
    preview: "/api/c2/vdec/preview",
    clearTemps: "/api/c2/vdec/clear-temps",
  },
});
