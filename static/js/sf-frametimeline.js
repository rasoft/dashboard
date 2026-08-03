window.SfFrametimelinePanel = (() => {
  const POLL_MS = 1000;
  const PAD = { top: 28, right: 16, bottom: 40, left: 56 };

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
  let layout = null; // { frames, xMax, plotW, plotH, slotH, w, h }

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

  /** X max = ceil(last frame Expected Present time / 100) * 100 */
  function computeXMax(payload) {
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
    const xMax = computeXMax(payload);
    const plotW = Math.max(40, w - PAD.left - PAD.right);
    const plotH = Math.max(40, h - PAD.top - PAD.bottom);
    const n = Math.max(1, frames.length);
    const slotH = plotH / n;

    layout = { frames, xMax, plotW, plotH, slotH, w, h };

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    ctx.fillRect(0, 0, w, h);

    // X: time (ms) left→right; Y: frame index top→bottom.
    const xAt = (ms) =>
      PAD.left + (Math.min(Math.max(ms, 0), xMax) / xMax) * plotW;

    // Grid + X axis (ms)
    ctx.strokeStyle = "rgba(142,160,178,0.25)";
    ctx.fillStyle = "#8ea0b2";
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const xTicks = 5;
    for (let i = 0; i <= xTicks; i += 1) {
      const ms = (xMax * i) / xTicks;
      const x = xAt(ms);
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, PAD.top + plotH);
      ctx.stroke();
      ctx.fillText(`${Math.round(ms)}`, x, PAD.top + plotH + 8);
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText("ms", w - 8, 6);

    // Y axis labels (frame index)
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const labelStep = Math.max(1, Math.ceil(n / 16));
    frames.forEach((f, i) => {
      if (i % labelStep !== 0 && i !== n - 1) return;
      const y = PAD.top + (i + 0.5) * slotH;
      ctx.fillText(String(f.index), PAD.left - 6, y);
    });
    ctx.save();
    ctx.translate(14, PAD.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("帧序号", 0, 0);
    ctx.restore();

    frames.forEach((frame, i) => {
      const cy = PAD.top + (i + 0.5) * slotH;
      const rowH = Math.max(4, slotH * 0.72);
      const jank = isJanky(frame);

      const expFill = jank ? COLOR.jankFill : COLOR.expectedFill;
      const expStroke = jank ? COLOR.jankStroke : COLOR.expectedStroke;
      const actFill = jank ? COLOR.jankFill : COLOR.actualFill;
      const actStroke = jank ? COLOR.jankStroke : COLOR.actualStroke;

      // Expected: solid + outline Start→Present (green / red if jank)
      const expected = spanStartPresent(frame.sf?.expected);
      if (expected) {
        const x0 = xAt(expected.start);
        const x1 = xAt(expected.end);
        const boxW = Math.max(2, x1 - x0);
        const y = cy - rowH * 0.42;
        drawBox(ctx, x0, y, boxW, rowH * 0.4, expFill, expStroke);
      }

      // Actual: solid + outline Start→Present (blue / red if jank)
      const actual = spanStartPresent(frame.sf?.actual);
      if (actual) {
        const x0 = xAt(actual.start);
        const x1 = xAt(actual.end);
        const boxW = Math.max(2, x1 - x0);
        const y = cy + rowH * 0.02;
        drawBox(ctx, x0, y, boxW, rowH * 0.4, actFill, actStroke);
      }

      if (selectedIndex != null && frame.index === selectedIndex) {
        ctx.strokeStyle = COLOR.selected;
        ctx.lineWidth = 2;
        ctx.strokeRect(
          PAD.left,
          PAD.top + i * slotH + 1,
          plotW,
          Math.max(2, slotH - 2)
        );
      }
    });
  }

  function frameAtClientY(clientY) {
    if (!layout) return null;
    const { canvas } = els();
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const y = clientY - rect.top;
    const { frames, slotH } = layout;
    if (!frames.length) return null;
    const i = Math.floor((y - PAD.top) / slotH);
    if (i < 0 || i >= frames.length) return null;
    return frames[i];
  }

  function findFrameByIndex(index) {
    if (index == null || !lastPayload) return null;
    const frames = lastPayload.display_frames || [];
    return frames.find((f) => f.index === index) || null;
  }

  function timelinePoints(tl) {
    if (!tl) return { start: null, end: null, present: null };
    const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
    return {
      start: num(tl.start_ms),
      end: num(tl.end_ms),
      present: num(tl.present_ms),
    };
  }

  function collectMs(points) {
    return [points.start, points.end, points.present].filter((v) => v != null);
  }

  function barSpanFromPoints(points) {
    if (points.start == null) return null;
    const ends = [points.end, points.present].filter((v) => v != null);
    if (!ends.length) return null;
    const end = Math.max(...ends);
    if (!(end >= points.start)) return null;
    return { start: points.start, end };
  }

  function zoomRangeForFrame(frame) {
    const values = [];
    const pushPts = (tl) => {
      collectMs(timelinePoints(tl)).forEach((v) => values.push(v));
    };
    pushPts(frame?.sf?.expected);
    pushPts(frame?.sf?.actual);
    if (!values.length) return null;
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (!(max > min)) max = min + 1;
    const padMs = Math.max(1.5, (max - min) * 0.18);
    return { min: Math.max(0, min - padMs), max: max + padMs };
  }

  function zoomRowsForFrame(frame) {
    const jank = isJanky(frame);
    const expPts = timelinePoints(frame.sf?.expected);
    const actPts = timelinePoints(frame.sf?.actual);
    const rows = [
      {
        label: "Expected",
        span: barSpanFromPoints(expPts),
        kind: "expected",
        jank,
        markers: [
          expPts.start != null
            ? { ms: expPts.start, tag: "S", name: "Start" }
            : null,
          expPts.present != null
            ? { ms: expPts.present, tag: "P", name: "Present" }
            : null,
        ].filter(Boolean),
      },
      {
        label: "Actual",
        span: barSpanFromPoints(actPts),
        kind: "actual",
        jank,
        markers: [
          actPts.start != null
            ? { ms: actPts.start, tag: "S", name: "Start" }
            : null,
          actPts.end != null ? { ms: actPts.end, tag: "E", name: "End" } : null,
          actPts.present != null
            ? { ms: actPts.present, tag: "P", name: "Present" }
            : null,
        ].filter(Boolean),
      },
    ];
    return rows;
  }

  function drawZoomMarkers(ctx, markers, xAt, yBarTop, yBarBot, color, placement = "above") {
    if (!markers?.length) return;
    const groups = [];
    markers.forEach((m) => {
      const x = xAt(m.ms);
      const g = groups.find((item) => Math.abs(item.x - x) < 6);
      if (g) g.items.push(m);
      else groups.push({ x, items: [m] });
    });
    const below = placement === "below";

    groups.forEach((g) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(g.x, yBarTop - (below ? 0 : 3));
      ctx.lineTo(g.x, yBarBot + (below ? 3 : 0));
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ctx.textBaseline = below ? "top" : "bottom";
      const label = g.items
        .map((m) => `${m.tag}:${Number(m.ms).toFixed(2)}`)
        .join(" ");
      const textW = ctx.measureText(label).width;
      let tx = g.x;
      ctx.textAlign = "center";
      if (tx - textW / 2 < 2) {
        ctx.textAlign = "left";
        tx = g.x + 2;
      }
      ctx.fillText(label, tx, below ? yBarBot + 4 : yBarTop - 4);
    });
  }

  function drawZoomIntervalInBar(ctx, xAt, a, b, yTop, yBot, label) {
    if (a == null || b == null) return;
    const x0 = xAt(Math.min(a, b));
    const x1 = xAt(Math.max(a, b));
    const mid = (x0 + x1) / 2;
    const cy = (yTop + yBot) / 2;
    const dt = Math.abs(b - a);
    let text = `${label} ${dt.toFixed(2)}`;
    const segW = Math.max(0, x1 - x0);

    ctx.save();
    ctx.font = "bold 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let tw = ctx.measureText(text).width;
    if (segW < tw + 6) {
      text = `${label}${dt.toFixed(1)}`;
      tw = ctx.measureText(text).width;
    }
    if (segW < 10) {
      ctx.restore();
      return;
    }
    // Halo for contrast inside colored bars.
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.strokeText(text, mid, cy);
    ctx.fillStyle = "rgba(245, 248, 252, 0.96)";
    ctx.fillText(text, mid, cy);
    ctx.restore();
  }

  function drawZoomInterval(ctx, xAt, a, b, y, label, color, labelSide = "center") {
    if (a == null || b == null) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const x0 = xAt(lo);
    const x1 = xAt(hi);
    const mid = (x0 + x1) / 2;
    const dt = Math.abs(b - a);
    const text = `${label} ${dt.toFixed(2)}`;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.moveTo(x0, y - 3);
    ctx.lineTo(x0, y + 3);
    ctx.moveTo(x1, y - 3);
    ctx.lineTo(x1, y + 3);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.textBaseline = "middle";
    if (labelSide === "left") {
      ctx.textAlign = "right";
      ctx.fillText(text, x0 - 4, y);
    } else if (labelSide === "right") {
      ctx.textAlign = "left";
      ctx.fillText(text, x1 + 4, y);
    } else {
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(text, mid, y + 3);
    }
    ctx.restore();
  }

  function drawZoom(frame) {
    const { detail } = els();
    const wrap = detail?.querySelector(".sf-ftl-zoom-wrap");
    const canvas = detail?.querySelector("#sf-ftl-zoom");
    if (!wrap || !canvas || !frame) return;

    const range = zoomRangeForFrame(frame);
    const rows = zoomRowsForFrame(frame);
    const expPts = timelinePoints(frame.sf?.expected);
    const actPts = timelinePoints(frame.sf?.actual);
    const dpr = window.devicePixelRatio || 1;
    wrap.style.height = "186px";
    const w = Math.max(1, wrap.clientWidth);
    const h = Math.max(1, wrap.clientHeight);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.fillRect(0, 0, w, h);

    if (!range) {
      ctx.fillStyle = "#8ea0b2";
      ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("该帧无可绘制的 Start→Present 区间", w / 2, h / 2);
      return;
    }

    const pad = { top: 22, right: 10, bottom: 40, left: 86 };
    const plotW = Math.max(40, w - pad.left - pad.right);
    const plotH = Math.max(40, h - pad.top - pad.bottom);
    const spanMs = range.max - range.min;
    const xAt = (ms) =>
      pad.left +
      ((Math.min(Math.max(ms, range.min), range.max) - range.min) / spanMs) * plotW;

    ctx.strokeStyle = "rgba(142,160,178,0.28)";
    ctx.fillStyle = "#8ea0b2";
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const ticks = 4;
    for (let i = 0; i <= ticks; i += 1) {
      const ms = range.min + (spanMs * i) / ticks;
      const x = xAt(ms);
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + plotH);
      ctx.stroke();
      ctx.fillText(ms.toFixed(1), x, pad.top + plotH + 6);
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText("ms", w - 6, 4);
    ctx.textAlign = "left";
    ctx.fillText(
      `Frame #${frame.index} · S/E/P 时刻 · 条带内 S→P / S→E / E→P · S↔S / P↔P`,
      8,
      4
    );

    const n = Math.max(1, rows.length);
    const slotH = plotH / n;
    const rowGeom = [];

    rows.forEach((row, i) => {
      const cy = pad.top + (i + 0.5) * slotH;
      const barH = Math.max(16, Math.min(28, slotH * 0.52));
      const yTop = cy - barH / 2;
      const yBot = cy + barH / 2;
      rowGeom.push({ cy, yTop, yBot, barH });

      ctx.fillStyle = "#9eb0c2";
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(row.label, pad.left - 6, cy);

      let fill = COLOR.actualFill;
      let stroke = COLOR.actualStroke;
      if (row.kind === "expected") {
        // Expected stays green even when the frame is janky.
        fill = COLOR.expectedFill;
        stroke = COLOR.expectedStroke;
      } else if (row.jank) {
        // Actual is fully red on jank (no segmented coloring).
        fill = COLOR.jankFill;
        stroke = COLOR.jankStroke;
      }

      if (row.span) {
        const x0 = xAt(row.span.start);
        const x1 = xAt(row.span.end);
        drawBox(ctx, x0, yTop, Math.max(2, x1 - x0), barH, fill, stroke);
      }

      if (row.markers?.length) {
        // Actual S/E/P labels go below the bar to avoid overlapping S↔S / P↔P.
        const placement = row.kind === "actual" ? "below" : "above";
        drawZoomMarkers(ctx, row.markers, xAt, yTop, yBot, stroke, placement);
      }
    });

    const expGeom = rowGeom[0];
    const actGeom = rowGeom[1];

    // S→P / S→E / E→P inside their bar segments.
    if (expGeom && expPts.start != null && expPts.present != null) {
      drawZoomIntervalInBar(
        ctx,
        xAt,
        expPts.start,
        expPts.present,
        expGeom.yTop,
        expGeom.yBot,
        "S→P"
      );
    }

    if (actGeom) {
      if (actPts.start != null && actPts.end != null) {
        drawZoomIntervalInBar(
          ctx,
          xAt,
          actPts.start,
          actPts.end,
          actGeom.yTop,
          actGeom.yBot,
          "S→E"
        );
      }
      if (actPts.end != null && actPts.present != null) {
        drawZoomIntervalInBar(
          ctx,
          xAt,
          actPts.end,
          actPts.present,
          actGeom.yTop,
          actGeom.yBot,
          "E→P"
        );
      }
    }

    if (expGeom && actGeom) {
      const yBetween = (expGeom.yBot + actGeom.yTop) / 2;
      const color = "rgba(232, 238, 245, 0.92)";
      if (expPts.start != null && actPts.start != null) {
        drawZoomInterval(
          ctx,
          xAt,
          expPts.start,
          actPts.start,
          yBetween,
          "S↔S",
          color,
          "left"
        );
      }
      if (expPts.present != null && actPts.present != null) {
        drawZoomInterval(
          ctx,
          xAt,
          expPts.present,
          actPts.present,
          yBetween,
          "P↔P",
          color,
          "right"
        );
      }
    }
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

    const zoom = `
      <div class="sf-ftl-zoom-wrap" aria-label="选中帧放大条带">
        <canvas id="sf-ftl-zoom"></canvas>
      </div>
    `;

    const layers = frame.layers || [];
    let body = "";
    if (!layers.length) {
      body = '<div class="sf-ftl-detail-empty">该帧无 Layer</div>';
    } else {
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
            layer.token != null
              ? ` · token ${escapeHtml(String(layer.token))}`
              : "",
            `</div>`,
            `</div>`,
          ].join("");
        })
        .join("");
      body = `<div class="sf-ftl-layer-list">${rows}</div>`;
    }

    detail.innerHTML = head + zoom + body;
    requestAnimationFrame(() => drawZoom(frame));
  }

  function onCanvasClick(evt) {
    const frame = frameAtClientY(evt.clientY);
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
      const xMax = computeXMax(data);
      const vsync = pickVsyncPeriod(data);
      const frames = data.display_frames || [];
      const lastJank = [...frames].reverse().find((f) => isJanky(f)) || null;
      selectedIndex = lastJank ? lastJank.index : null;
      draw(data);
      renderDetail(lastJank);

      const sel = selectedIndex != null ? ` · 已选 #${selectedIndex}` : "";
      setMeta(
        `${data.count} Display Frame · jank ${data.jank_count}` +
          ` · Vsync ${vsync.toFixed(2)} ms · X 0–${xMax} ms${sel}`
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
    const frame = findFrameByIndex(selectedIndex);
    if (frame) drawZoom(frame);
  }

  function mount(panelEl) {
    root = panelEl.querySelector(".sf-ftl");
    if (!root) return;

    const { canvas, stage, detail } = els();
    if (root.dataset.bound !== "1") {
      root.dataset.bound = "1";
      if (canvas) canvas.addEventListener("click", onCanvasClick);
    }

    renderDetail(null);
    setStatus("等待操作");

    if (typeof ResizeObserver !== "undefined") {
      if (resizeObserver) resizeObserver.disconnect();
      resizeObserver = new ResizeObserver(() => onResize());
      if (stage) resizeObserver.observe(stage);
      if (detail) resizeObserver.observe(detail);
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
