window.SfFrametimelinePanel = (() => {
  const POLL_MS = 1000;
  const PAD = { top: 28, right: 16, bottom: 36, left: 52 };

  const COLOR = {
    expectedFill: "rgba(43, 182, 115, 0.35)",
    expectedStroke: "rgba(43, 182, 115, 0.95)",
    actualFill: "rgba(61, 156, 240, 0.45)",
    actualStroke: "rgba(61, 156, 240, 0.95)",
    jankFill: "rgba(224, 92, 92, 0.45)",
    jankStroke: "rgba(224, 92, 92, 0.95)",
    selected: "rgba(255, 255, 255, 0.9)",
  };

  let root = null;
  let timer = null;
  let running = false;
  let fetching = false;
  let lastPayload = null;
  let selectedIndex = null;
  let resizeObserver = null;
  let layout = null; // { frames, yMax, plot }

  function els() {
    return {
      meta: root.querySelector("#sf-ftl-meta"),
      stage: root.querySelector("#sf-ftl-stage"),
      canvas: root.querySelector("#sf-ftl-canvas"),
      detail: root.querySelector("#sf-ftl-detail"),
      status: root.querySelector("#sf-ftl-status"),
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

  function isJanky(item) {
    if (!item) return false;
    if (item.janky) return true;
    const jt = (item.jank_type || "").trim().toLowerCase();
    return !!jt && jt !== "none";
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtMs(v) {
    if (v == null || Number.isNaN(Number(v))) return "—";
    return `${Number(v).toFixed(2)} ms`;
  }

  function layerDurationMs(layer) {
    const tl = layer?.actual;
    if (!tl) return null;
    const start = tl.start_ms;
    const end = tl.present_ms != null ? tl.present_ms : tl.end_ms;
    if (start == null || end == null) return null;
    return Math.max(0, end - start);
  }

  function pickVsyncPeriod(payload) {
    const frames = payload.display_frames || [];
    for (const f of frames) {
      if (f.vsync_period_ms != null && Number(f.vsync_period_ms) > 0) {
        return Number(f.vsync_period_ms);
      }
    }
    return 16.6667;
  }

  /** Y max = ceil(last frame Expected Present time / 100) * 100 */
  function computeYMax(payload) {
    const frames = payload.display_frames || [];
    let present = null;
    if (frames.length) {
      const last = frames[frames.length - 1];
      const exp = last?.sf?.expected;
      if (exp?.present_ms != null) present = Number(exp.present_ms);
      else if (exp?.end_ms != null) present = Number(exp.end_ms);
    }
    if (present == null || !Number.isFinite(present) || present <= 0) {
      // Fallback if last expected present is missing.
      const count = Math.max(1, Number(payload.count) || frames.length || 1);
      present = count * pickVsyncPeriod(payload);
    }
    return Math.max(100, Math.ceil(present / 100) * 100);
  }

  function spanStartPresent(tl) {
    if (!tl) return null;
    const start = tl.start_ms;
    const present = tl.present_ms != null ? tl.present_ms : tl.end_ms;
    if (start == null || present == null) return null;
    if (!(present >= start)) return null;
    return { start, end: present };
  }

  function resizeCanvas() {
    const { stage, canvas } = els();
    if (!stage || !canvas) return { w: 0, h: 0 };
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, stage.clientHeight);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function drawBox(ctx, x, y, w, h, fill, stroke) {
    if (w <= 0 || h <= 0) return;
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  }

  function draw(payload) {
    const { canvas } = els();
    if (!canvas) return;
    lastPayload = payload;
    const { w, h } = resizeCanvas();
    if (!w || !h) return;
    const ctx = canvas.getContext("2d");
    const frames = payload.display_frames || [];
    const yMax = computeYMax(payload);
    const plotW = Math.max(40, w - PAD.left - PAD.right);
    const plotH = Math.max(40, h - PAD.top - PAD.bottom);
    const n = Math.max(1, frames.length);
    const slotW = plotW / n;

    layout = { frames, yMax, plotW, plotH, slotW, w, h };

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    ctx.fillRect(0, 0, w, h);

    const yAt = (ms) => PAD.top + plotH - (Math.min(Math.max(ms, 0), yMax) / yMax) * plotH;

    // Grid + Y axis
    ctx.strokeStyle = "rgba(142,160,178,0.25)";
    ctx.fillStyle = "#8ea0b2";
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i += 1) {
      const ms = (yMax * i) / yTicks;
      const y = yAt(ms);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + plotW, y);
      ctx.stroke();
      ctx.fillText(`${Math.round(ms)}`, PAD.left - 6, y);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("ms", 8, 6);

    // X axis labels
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelStep = Math.max(1, Math.ceil(n / 12));
    frames.forEach((f, i) => {
      if (i % labelStep !== 0 && i !== n - 1) return;
      const x = PAD.left + (i + 0.5) * slotW;
      ctx.fillText(String(f.index), x, PAD.top + plotH + 8);
    });
    ctx.fillText("帧序号", PAD.left + plotW / 2, h - 14);

    frames.forEach((frame, i) => {
      const cx = PAD.left + (i + 0.5) * slotW;
      const colW = Math.max(4, slotW * 0.72);
      const jank = isJanky(frame);

      const expFill = jank ? COLOR.jankFill : COLOR.expectedFill;
      const expStroke = jank ? COLOR.jankStroke : COLOR.expectedStroke;
      const actFill = jank ? COLOR.jankFill : COLOR.actualFill;
      const actStroke = jank ? COLOR.jankStroke : COLOR.actualStroke;

      // Expected: solid + outline Start→Present (green / red if jank)
      const expected = spanStartPresent(frame.sf?.expected);
      if (expected) {
        const y0 = yAt(expected.end);
        const y1 = yAt(expected.start);
        const boxH = Math.max(2, y1 - y0);
        const x = cx - colW * 0.42;
        drawBox(ctx, x, y0, colW * 0.4, boxH, expFill, expStroke);
      }

      // Actual: solid + outline Start→Present (blue / red if jank)
      const actual = spanStartPresent(frame.sf?.actual);
      if (actual) {
        const y0 = yAt(actual.end);
        const y1 = yAt(actual.start);
        const boxH = Math.max(2, y1 - y0);
        const x = cx + colW * 0.02;
        drawBox(ctx, x, y0, colW * 0.4, boxH, actFill, actStroke);
      }

      if (selectedIndex != null && frame.index === selectedIndex) {
        ctx.strokeStyle = COLOR.selected;
        ctx.lineWidth = 2;
        ctx.strokeRect(
          PAD.left + i * slotW + 1,
          PAD.top,
          Math.max(2, slotW - 2),
          plotH
        );
      }
    });
  }

  function frameAtClientX(clientX) {
    if (!layout) return null;
    const { canvas } = els();
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const { frames, slotW } = layout;
    if (!frames.length) return null;
    const i = Math.floor((x - PAD.left) / slotW);
    if (i < 0 || i >= frames.length) return null;
    return frames[i];
  }

  function renderDetail(frame) {
    const { detail } = els();
    if (!detail) return;
    if (!frame) {
      detail.innerHTML =
        '<div class="sf-ftl-detail-empty">点击某一帧查看 Layer 明细</div>';
      return;
    }

    const exp = spanStartPresent(frame.sf?.expected);
    const act = spanStartPresent(frame.sf?.actual);
    const head = [
      `<div class="sf-ftl-detail-head">`,
      `<strong>Display Frame #${frame.index}</strong>`,
      isJanky(frame) ? `<span class="sf-ftl-badge jank">Jank</span>` : "",
      `<span class="sf-ftl-muted">Expected ${
        exp ? `${fmtMs(exp.start)} → ${fmtMs(exp.end)}` : "—"
      }</span>`,
      `<span class="sf-ftl-muted">Actual ${
        act ? `${fmtMs(act.start)} → ${fmtMs(act.end)}` : "—"
      }</span>`,
      `<span class="sf-ftl-muted">Δ present ${fmtMs(frame.present_delta_ms)}</span>`,
      frame.jank_type
        ? `<span class="sf-ftl-muted">${escapeHtml(frame.jank_type)}</span>`
        : "",
      `</div>`,
    ].join("");

    const layers = frame.layers || [];
    if (!layers.length) {
      detail.innerHTML =
        head + '<div class="sf-ftl-detail-empty">该帧无 Layer</div>';
      return;
    }

    const rows = layers
      .map((layer) => {
        const jank = isJanky(layer);
        const span = spanStartPresent(layer.actual);
        return [
          `<div class="sf-ftl-layer${jank ? " jank" : ""}">`,
          `<div class="sf-ftl-layer-name" title="${escapeHtml(layer.name || "")}">`,
          escapeHtml(layer.name || "layer"),
          jank ? ` <span class="sf-ftl-badge jank">Jank</span>` : "",
          `</div>`,
          `<div class="sf-ftl-layer-meta">`,
          span
            ? `Actual ${fmtMs(span.start)} → ${fmtMs(span.end)} (${fmtMs(
                layerDurationMs(layer)
              )})`
            : `Actual ${fmtMs(layerDurationMs(layer))}`,
          layer.jank_type ? ` · ${escapeHtml(layer.jank_type)}` : "",
          layer.present_state ? ` · ${escapeHtml(layer.present_state)}` : "",
          layer.token != null ? ` · token ${escapeHtml(String(layer.token))}` : "",
          `</div>`,
          `</div>`,
        ].join("");
      })
      .join("");

    detail.innerHTML = head + `<div class="sf-ftl-layer-list">${rows}</div>`;
  }

  function onCanvasClick(evt) {
    const frame = frameAtClientX(evt.clientX);
    if (!frame) return;
    selectedIndex = frame.index;
    renderDetail(frame);
    if (lastPayload) draw(lastPayload);
  }

  async function fetchSample() {
    const res = await fetch("/api/sf/frametimeline");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "获取 FrameTimeline 失败");
    return data;
  }

  async function tick() {
    if (!running || fetching) return;
    if (window.Dashboard?.isPaused?.()) return;
    fetching = true;
    try {
      const data = await fetchSample();
      const yMax = computeYMax(data);
      const vsync = pickVsyncPeriod(data);
      const frames = data.display_frames || [];
      const lastJank = [...frames].reverse().find((f) => isJanky(f)) || null;
      selectedIndex = lastJank ? lastJank.index : null;
      draw(data);
      renderDetail(lastJank);

      const sel = selectedIndex != null ? ` · 已选 #${selectedIndex}` : "";
      setMeta(
        `${data.count} Display Frame · jank ${data.jank_count}` +
          ` · Vsync ${vsync.toFixed(2)} ms · Y 0–${yMax} ms${sel}`
      );
      setStatus(
        `监测中 · 最近更新 ${new Date().toLocaleTimeString("zh-CN", {
          hour12: false,
        })}`
      );
    } catch (err) {
      setStatus(String(err.message || err), true);
    } finally {
      fetching = false;
    }
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    running = false;
  }

  function start() {
    if (running) return;
    running = true;
    setStatus("监测中…");
    tick();
    timer = setInterval(tick, POLL_MS);
  }

  function onResize() {
    if (lastPayload) draw(lastPayload);
    else resizeCanvas();
  }

  function mount(panelEl) {
    root = panelEl.querySelector(".sf-ftl");
    if (!root) return;

    const { canvas, stage } = els();
    if (root.dataset.bound !== "1") {
      root.dataset.bound = "1";
      if (canvas) canvas.addEventListener("click", onCanvasClick);
    }

    renderDetail(null);
    setStatus("等待操作");

    if (stage && typeof ResizeObserver !== "undefined") {
      if (resizeObserver) resizeObserver.disconnect();
      resizeObserver = new ResizeObserver(() => onResize());
      resizeObserver.observe(stage);
    }

    resizeCanvas();
    start();
  }

  function unmount() {
    stop();
    const { canvas } = els();
    if (canvas) canvas.removeEventListener("click", onCanvasClick);
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    root = null;
    lastPayload = null;
    selectedIndex = null;
    layout = null;
  }

  return { mount, unmount, start, stop };
})();
