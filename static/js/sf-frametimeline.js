window.SfFrametimelinePanel = (() => {
  const POLL_MS = 1000;
  const ROW_H = 22;
  const LABEL_W = 168;
  const PAD_R = 12;
  const PAD_T = 22;
  const PAD_B = 18;

  let root = null;
  let timer = null;
  let running = false;
  let fetching = false;
  let lastPayload = null;
  let resizeObserver = null;

  function els() {
    return {
      meta: root.querySelector("#sf-ftl-meta"),
      stage: root.querySelector("#sf-ftl-stage"),
      canvas: root.querySelector("#sf-ftl-canvas"),
      status: root.querySelector("#sf-ftl-status"),
      legend: root.querySelector("#sf-ftl-legend"),
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

  function barRange(tl) {
    if (!tl) return null;
    const start = tl.start_ms;
    const end = tl.present_ms != null ? tl.present_ms : tl.end_ms;
    if (start == null || end == null) return null;
    if (!(end >= start)) return null;
    return { start, end };
  }

  function collectRows(payload) {
    const rows = [];
    (payload.display_frames || []).forEach((df) => {
      rows.push({
        kind: "sf",
        label: `SF #${df.index}`,
        janky: isJanky(df),
        expected: df.sf?.expected,
        actual: df.sf?.actual,
        jank_type: df.jank_type,
      });
      (df.layers || []).forEach((layer) => {
        const name = layer.name || "layer";
        const short = name.length > 28 ? `${name.slice(0, 26)}…` : name;
        rows.push({
          kind: "layer",
          label: short,
          fullLabel: name,
          janky: isJanky(layer),
          expected: layer.expected,
          actual: layer.actual,
          jank_type: layer.jank_type,
        });
      });
    });
    return rows;
  }

  function timeExtent(rows) {
    let min = Infinity;
    let max = -Infinity;
    rows.forEach((row) => {
      [row.expected, row.actual].forEach((tl) => {
        const r = barRange(tl);
        if (!r) return;
        min = Math.min(min, r.start);
        max = Math.max(max, r.end);
      });
    });
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return { min: 0, max: 16.67 };
    }
    if (max <= min) max = min + 1;
    const pad = Math.max(1, (max - min) * 0.04);
    return { min: min - pad, max: max + pad };
  }

  function resizeCanvas() {
    const { stage, canvas } = els();
    if (!stage || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rows = lastPayload ? collectRows(lastPayload) : [];
    const contentH = Math.max(stage.clientHeight, PAD_T + PAD_B + rows.length * ROW_H + 8);
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, contentH);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(payload) {
    const { canvas, stage } = els();
    if (!canvas || !stage) return;
    lastPayload = payload;
    resizeCanvas();
    const ctx = canvas.getContext("2d");
    const cssW = stage.clientWidth;
    const rows = collectRows(payload);
    const extent = timeExtent(rows);
    const plotW = Math.max(40, cssW - LABEL_W - PAD_R);
    const span = extent.max - extent.min || 1;

    const xAt = (ms) => LABEL_W + ((ms - extent.min) / span) * plotW;

    ctx.clearRect(0, 0, cssW, canvas.height / (window.devicePixelRatio || 1));

    // Background
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    ctx.fillRect(0, 0, cssW, canvas.height / (window.devicePixelRatio || 1));

    // Grid / axis
    ctx.strokeStyle = "rgba(142,160,178,0.25)";
    ctx.fillStyle = "#8ea0b2";
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const ticks = 6;
    for (let i = 0; i <= ticks; i += 1) {
      const ms = extent.min + (span * i) / ticks;
      const x = xAt(ms);
      ctx.beginPath();
      ctx.moveTo(x, PAD_T - 4);
      ctx.lineTo(x, PAD_T + rows.length * ROW_H);
      ctx.stroke();
      ctx.fillText(`${ms.toFixed(1)}`, x, 4);
    }
    ctx.textAlign = "left";
    ctx.fillText("ms", cssW - PAD_R - 14, 4);

    rows.forEach((row, idx) => {
      const y = PAD_T + idx * ROW_H;
      if (idx % 2 === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.03)";
        ctx.fillRect(0, y, cssW, ROW_H);
      }

      ctx.fillStyle = row.kind === "sf" ? "#dce7f2" : "#9aadc0";
      ctx.font =
        row.kind === "sf"
          ? "600 11px system-ui, -apple-system, sans-serif"
          : "11px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(row.label, 8, y + ROW_H / 2, LABEL_W - 14);

      const fill = row.janky ? "rgba(224, 92, 92, 0.78)" : "rgba(61, 156, 240, 0.72)";
      const stroke = row.janky ? "rgba(255, 160, 160, 0.95)" : "rgba(180, 210, 240, 0.9)";

      const expected = barRange(row.expected);
      if (expected) {
        const x0 = xAt(expected.start);
        const x1 = xAt(expected.end);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.25;
        ctx.strokeRect(x0, y + 5, Math.max(2, x1 - x0), ROW_H - 10);
      }

      const actual = barRange(row.actual);
      if (actual) {
        const x0 = xAt(actual.start);
        const x1 = xAt(actual.end);
        ctx.fillStyle = fill;
        ctx.fillRect(x0, y + 6, Math.max(2, x1 - x0), ROW_H - 12);
      }
    });
  }

  async function fetchSample() {
    const res = await fetch("/api/sf/frametimeline");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "获取 FrameTimeline 失败");
    return data;
  }

  async function tick() {
    if (!running || fetching) return;
    fetching = true;
    try {
      const data = await fetchSample();
      draw(data);
      const vsync =
        data.display_frames?.find((f) => f.vsync_period_ms != null)?.vsync_period_ms;
      const vsyncLabel = vsync != null ? ` · Vsync ${Number(vsync).toFixed(2)} ms` : "";
      setMeta(
        `${data.count} Display Frame · jank ${data.jank_count}${vsyncLabel}`
      );
      setStatus(
        `监测中 · 最近更新 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`
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

    const { stage } = els();
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
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    root = null;
    lastPayload = null;
  }

  return { mount, unmount, start, stop };
})();
