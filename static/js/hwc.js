window.HwcPanel = (() => {
  const POLL_MS = 1000;
  const FILL_ALPHA = 0.4;
  const PALETTE = [
    [61, 156, 240],
    [43, 182, 115],
    [212, 160, 23],
    [226, 92, 92],
    [180, 120, 220],
    [70, 190, 160],
    [90, 140, 220],
    [230, 140, 80],
    [100, 180, 200],
    [200, 100, 160],
  ];

  let root = null;
  let timer = null;
  let running = false;
  let fetching = false;
  let lastPayload = null;
  let resizeObserver = null;

  function els() {
    return {
      stage: root.querySelector("#hwc-stage"),
      canvas: root.querySelector("#hwc-canvas"),
      legend: root.querySelector("#hwc-legend"),
      meta: root.querySelector("#hwc-meta"),
      status: root.querySelector("#hwc-status"),
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

  function colorFor(index, alpha = FILL_ALPHA) {
    const [r, g, b] = PALETTE[index % PALETTE.length];
    return {
      fill: `rgba(${r}, ${g}, ${b}, ${alpha})`,
      stroke: `rgba(${r}, ${g}, ${b}, 0.95)`,
      swatch: `rgb(${r}, ${g}, ${b})`,
    };
  }

  function shortName(name) {
    if (!name) return "—";
    if (name.length <= 72) return name;
    return `${name.slice(0, 34)}…${name.slice(-34)}`;
  }

  function isClientComp(layer) {
    const t = String(layer?.comp_type || "")
      .trim()
      .toLowerCase();
    return t === "client" || t.startsWith("client");
  }

  function frameView(layer) {
    const fr = layer?.frame;
    if (!fr) return null;
    const x = Number(fr.left) || 0;
    const y = Number(fr.top) || 0;
    const width =
      Number(fr.width) ||
      Math.max(0, (Number(fr.right) || 0) - x);
    const height =
      Number(fr.height) ||
      Math.max(0, (Number(fr.bottom) || 0) - y);
    if (!(width > 0 || height > 0)) return null;
    return { x, y, width: Math.max(1, width), height: Math.max(1, height) };
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

  /** Rotate display (x,y) 270° CCW around Z (= prior 90° + 180°), then axonometric project. */
  function project(x, y, elev, size) {
    const rx = y;
    const ry = size.width - x;
    return {
      sx: (rx - ry) * Math.cos(Math.PI / 6),
      sy: (rx + ry) * Math.sin(Math.PI / 6) - elev,
    };
  }

  function layerCorners(view) {
    const x = Number(view?.x) || 0;
    const y = Number(view?.y) || 0;
    const w = Math.max(1, Number(view?.width) || 0);
    const h = Math.max(1, Number(view?.height) || 0);
    return [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
  }

  function drawPoly(ctx, pts, fill, stroke, dashed) {
    if (!pts || pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].sx, pts[0].sy);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].sx, pts[i].sy);
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = dashed ? 2 : 1.75;
      ctx.setLineDash(dashed ? [8, 5] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** Place a label outside the polygon, offset from a corner away from the centroid. */
  function drawOutsideLabel(ctx, pts, cornerIndex, text) {
    if (!pts?.length) return;
    const corner = pts[cornerIndex];
    if (!corner) return;
    let cx = 0;
    let cy = 0;
    pts.forEach((p) => {
      cx += p.sx;
      cy += p.sy;
    });
    cx /= pts.length;
    cy /= pts.length;
    let dx = corner.sx - cx;
    let dy = corner.sy - cy;
    const len = Math.hypot(dx, dy) || 1;
    const dist = 16;
    const x = corner.sx + (dx / len) * dist;
    const y = corner.sy + (dy / len) * dist;

    const fontSize = 11;
    ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    const tw = ctx.measureText(text).width;
    const lh = fontSize + 3;
    const padX = 3;
    const alignLeft = dx >= 0;
    const alignTop = dy >= 0;
    ctx.textAlign = alignLeft ? "left" : "right";
    ctx.textBaseline = alignTop ? "top" : "bottom";
    const boxX = alignLeft ? x - padX : x - tw - padX;
    const boxY = alignTop ? y : y - lh;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(boxX, boxY, tw + padX * 2, lh);
    ctx.fillStyle = "#f2f6fa";
    ctx.fillText(text, x, y);
  }

  function draw(payload) {
    const { canvas, legend } = els();
    if (!canvas) return;
    lastPayload = payload;
    const { w: cssW, h: cssH } = resizeCanvas();
    if (!cssW || !cssH) return;

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.fillRect(0, 0, cssW, cssH);

    const layers = payload?.layers || [];
    const size = {
      width: Math.max(1, payload?.width || 1920),
      height: Math.max(1, payload?.height || 1080),
    };
    const pad = 48;
    const availW = Math.max(40, cssW - pad * 2);
    const availH = Math.max(40, cssH - pad * 2);
    const n = Math.max(1, layers.length);

    const baseCorners = [
      { x: 0, y: 0 },
      { x: size.width, y: 0 },
      { x: size.width, y: size.height },
      { x: 0, y: size.height },
    ];

    const basePts = baseCorners.map((c) => project(c.x, c.y, 0, size));
    let baseMinX = Infinity;
    let baseMinY = Infinity;
    let baseMaxX = -Infinity;
    let baseMaxY = -Infinity;
    basePts.forEach((p) => {
      baseMinX = Math.min(baseMinX, p.sx);
      baseMinY = Math.min(baseMinY, p.sy);
      baseMaxX = Math.max(baseMaxX, p.sx);
      baseMaxY = Math.max(baseMaxY, p.sy);
    });
    const baseSpanX = Math.max(1, baseMaxX - baseMinX);
    const baseSpanY = Math.max(1, baseMaxY - baseMinY);
    const minGap = Math.max(48, Math.min(size.width, size.height) * 0.05);
    const maxGap = Math.max(minGap, Math.min(size.width, size.height) * 0.32);
    let gap = Math.max(120, Math.min(size.width, size.height) * 0.18);
    if (n > 1) {
      const targetTotalY = (availH * baseSpanX) / availW;
      const rawGap = (targetTotalY - baseSpanY) / (n - 1);
      if (Number.isFinite(rawGap)) {
        gap = Math.min(maxGap, Math.max(minGap, rawGap));
      }
    } else {
      gap = 0;
    }

    // Table order only: earlier rows at bottom, later rows explode upward.
    const items = layers.map((layer, tableIndex) => ({
      layer,
      tableIndex,
      colorIndex: layer.index ?? tableIndex,
      elev: tableIndex * gap,
      view: frameView(layer),
    }));

    const allPts = [];
    const maxElev = (n - 1) * gap;
    baseCorners.forEach((c) => {
      allPts.push(project(c.x, c.y, 0, size));
      allPts.push(project(c.x, c.y, maxElev, size));
    });
    items.forEach(({ view, elev }) => {
      if (!view) return;
      layerCorners(view).forEach((c) => allPts.push(project(c.x, c.y, elev, size)));
    });

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    allPts.forEach((p) => {
      minX = Math.min(minX, p.sx);
      minY = Math.min(minY, p.sy);
      maxX = Math.max(maxX, p.sx);
      maxY = Math.max(maxY, p.sy);
    });
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
      renderLegend(layers);
      return;
    }

    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const scale = Math.min(availW / spanX, availH / spanY);
    if (!(scale > 0)) {
      renderLegend(layers);
      return;
    }
    const ox = (cssW - spanX * scale) / 2 - minX * scale;
    const oy = (cssH - spanY * scale) / 2 - minY * scale;

    const toScreen = (x, y, elev) => {
      const p = project(x, y, elev, size);
      return { sx: ox + p.sx * scale, sy: oy + p.sy * scale };
    };

    drawPoly(
      ctx,
      baseCorners.map((c) => toScreen(c.x, c.y, 0)),
      "rgba(142,160,178,0.1)",
      "rgba(180,200,220,0.7)",
      false
    );

    // Draw in table order: early rows first (bottom), later rows on top.
    items.forEach(({ layer, colorIndex, elev, view }) => {
      if (!view) return;
      const corners = layerCorners(view);
      const pts = corners.map((c) => toScreen(c.x, c.y, elev));
      const colors = colorFor(colorIndex, FILL_ALPHA);
      const client = isClientComp(layer);

      if (elev > 0) {
        ctx.strokeStyle = "rgba(142,160,178,0.28)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        [0, 1].forEach((i) => {
          const c = corners[i];
          const a = toScreen(c.x, c.y, 0);
          const b = toScreen(c.x, c.y, elev);
          ctx.beginPath();
          ctx.moveTo(a.sx, a.sy);
          ctx.lineTo(b.sx, b.sy);
          ctx.stroke();
        });
        ctx.setLineDash([]);
      }

      drawPoly(ctx, pts, colors.fill, colors.stroke, client);

      const fr = layer.frame || {};
      const left = fr.left ?? view.x;
      const top = fr.top ?? view.y;
      const right = fr.right ?? view.x + view.width;
      const bottom = fr.bottom ?? view.y + view.height;
      drawOutsideLabel(ctx, pts, 0, `[${left},${top}]`);
      drawOutsideLabel(ctx, pts, 2, `(${right},${bottom})`);
    });

    renderLegend(layers);
  }

  function renderLegend(layers) {
    const { legend } = els();
    if (!legend) return;
    legend.innerHTML = "";
    if (!layers.length) {
      const empty = document.createElement("div");
      empty.className = "hwc-legend-empty";
      empty.textContent = "暂无图层";
      legend.appendChild(empty);
      return;
    }
    // Legend: last table row (topmost) first.
    [...layers].reverse().forEach((layer, i) => {
      const colors = colorFor(layer.index ?? layers.length - 1 - i);
      const row = document.createElement("div");
      row.className = "hwc-legend-item";
      if (layer.focused) row.classList.add("focused");

      const swatch = document.createElement("span");
      swatch.className = "hwc-swatch";
      swatch.style.background = colors.fill;
      swatch.style.borderColor = colors.stroke;
      swatch.classList.add(isClientComp(layer) ? "dashed" : "solid");

      const label = document.createElement("span");
      label.className = "hwc-legend-label";
      const z = Number.isFinite(layer.z) ? layer.z : "?";
      const comp = layer.comp_type || "?";
      label.textContent = `Z ${z} · ${comp} · ${shortName(layer.name)}`;
      label.title = layer.name || "";

      row.appendChild(swatch);
      row.appendChild(label);
      legend.appendChild(row);
    });
  }

  async function fetchLayers() {
    const res = await fetch("/api/hwc/layers");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "获取 HWC 层失败");
    return data;
  }

  async function tick() {
    if (!running || fetching) return;
    fetching = true;
    try {
      const data = await fetchLayers();
      lastPayload = data;
      draw(data);
      requestAnimationFrame(() => {
        if (lastPayload) draw(lastPayload);
      });
      const state = data.display_state ? ` · ${data.display_state}` : "";
      setMeta(`${data.count} 层 · 轴测爆炸 ${data.width}×${data.height}${state}`);
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
    root = panelEl.querySelector(".hwc");
    if (!root) return;

    if (root.dataset.bound !== "1") {
      root.dataset.bound = "1";
      window.addEventListener("resize", onResize);
    }

    const { stage } = els();
    if (stage && typeof ResizeObserver !== "undefined") {
      if (resizeObserver) resizeObserver.disconnect();
      resizeObserver = new ResizeObserver(() => onResize());
      resizeObserver.observe(stage);
    }

    resizeCanvas();
    start();
    requestAnimationFrame(() => {
      if (lastPayload) draw(lastPayload);
      else resizeCanvas();
    });
  }

  function unmount() {
    stop();
    window.removeEventListener("resize", onResize);
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    root = null;
    lastPayload = null;
  }

  return { mount, unmount, start, stop };
})();
