window.HwcStatusPanel = (() => {
  const POLL_MS = 1000;
  const FILL_ALPHA = 0.35;
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
  // VPU channel colors for the axonometric diagram / list swatches.
  const VPU_COLORS = {
    OSD: [230, 140, 80], // orange
    SMT: [226, 70, 70], // red
    MSK: [140, 148, 158], // gray
    VPP: [61, 156, 240], // blue
    VPP1: [130, 200, 255], // light blue
  };

  let root = null;
  let timer = null;
  let running = false;
  let fetching = false;
  let lastPayload = null;
  let resizeObserver = null;

  function els() {
    return {
      meta: root.querySelector("#hwc-st-meta"),
      stage: root.querySelector("#hwc-st-stage"),
      canvas: root.querySelector("#hwc-st-canvas"),
      legend: root.querySelector("#hwc-st-legend"),
      status: root.querySelector("#hwc-st-status"),
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

  function normalizeVpuType(vpu) {
    const s = String(vpu || "").trim().toUpperCase();
    if (!s || s === "—" || s === "-") return "";
    if (s === "OSD" || s.startsWith("OSD")) return "OSD";
    if (s === "SMT" || s.startsWith("SMT")) return "SMT";
    if (s === "MSK" || s.startsWith("MSK")) return "MSK";
    // VPP1 before VPP so "VPP1..." is not classified as VPP.
    if (s === "VPP1" || s.startsWith("VPP1")) return "VPP1";
    if (s === "VPP" || s === "VPP0" || s.startsWith("VPP")) return "VPP";
    return "";
  }

  function colorFor(index, alpha = FILL_ALPHA, layerOrVpu = null) {
    let rgb = null;
    if (layerOrVpu != null) {
      const vpu =
        typeof layerOrVpu === "string"
          ? layerOrVpu
          : layerOrVpu?.vpu;
      const key = normalizeVpuType(vpu);
      if (key && VPU_COLORS[key]) rgb = VPU_COLORS[key];
    }
    if (!rgb) rgb = PALETTE[index % PALETTE.length];
    const [r, g, b] = rgb;
    return {
      fill: `rgba(${r}, ${g}, ${b}, ${alpha})`,
      stroke: `rgba(${r}, ${g}, ${b}, 0.95)`,
      swatch: `rgb(${r}, ${g}, ${b})`,
    };
  }

  function parseVirtualSize(notes) {
    for (const note of notes || []) {
      const m = String(note).match(/virtual\s*=\s*(\d+)\s*x\s*(\d+)/i);
      if (m) return { width: Number(m[1]), height: Number(m[2]) };
    }
    return null;
  }

  function displaySize(payload) {
    const virtual = parseVirtualSize(payload?.notes);
    let width = virtual?.width || 0;
    let height = virtual?.height || 0;
    (payload?.layers || []).forEach((layer) => {
      const v = viewOf(layer);
      if (!v) return;
      width = Math.max(width, (v.x || 0) + (v.width || 0));
      height = Math.max(height, (v.y || 0) + (v.height || 0));
    });
    return {
      width: Math.max(1, width || 1920),
      height: Math.max(1, height || 1080),
    };
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
    // (x, y) -> (y, W - x) keeps the plane in the positive quadrant.
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

  function viewOf(layer) {
    const v = layer?.vpu_view;
    if (v && (v.width > 0 || v.height > 0)) return v;
    const d = layer?.disp_frame;
    if (d) {
      return {
        x: d.left || 0,
        y: d.top || 0,
        width: d.width || Math.max(0, (d.right || 0) - (d.left || 0)),
        height: d.height || Math.max(0, (d.bottom || 0) - (d.top || 0)),
      };
    }
    return null;
  }

  function isClientComp(layer) {
    const compType = String(layer?.comp || "").trim().toLowerCase();
    return compType === "client" || compType.startsWith("client");
  }

  /** Union of layer views into one axis-aligned box. */
  function unionViews(views) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let any = false;
    (views || []).forEach((v) => {
      if (!v) return;
      any = true;
      const x = Number(v.x) || 0;
      const y = Number(v.y) || 0;
      const w = Math.max(0, Number(v.width) || 0);
      const h = Math.max(0, Number(v.height) || 0);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    });
    if (!any) return null;
    return {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }

  /**
   * Build drawable items for the axonometric stack: all Comp=Client layers
   * collapse into a single plane (at the highest-Z Client slot).
   */
  function drawItemsFromLayers(layers) {
    const list = layers || [];
    const clientLayers = list.filter(isClientComp);
    const items = [];
    let clientMerged = false;

    list.forEach((layer, i) => {
      if (isClientComp(layer)) {
        if (clientMerged) return;
        clientMerged = true;
        // List is Z-desc; clients[0] is the topmost Client layer.
        const top = clientLayers[0] || layer;
        const view = unionViews(clientLayers.map(viewOf)) || viewOf(top);
        const count = clientLayers.length;
        items.push({
          layer: top,
          colorIndex: i,
          view,
          isClient: true,
          mergedCount: count,
        });
        return;
      }
      items.push({
        layer,
        colorIndex: i,
        view: viewOf(layer),
        isClient: false,
        mergedCount: 1,
      });
    });
    return items;
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

  /** Place a label inside the polygon, inset from a corner toward the centroid. */
  function drawInsideLabel(ctx, pts, cornerIndex, text) {
    if (!pts?.length || !text) return;
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
    let dx = cx - corner.sx;
    let dy = cy - corner.sy;
    const len = Math.hypot(dx, dy) || 1;
    const dist = 12;
    const x = corner.sx + (dx / len) * dist;
    const y = corner.sy + (dy / len) * dist;

    const fontSize = 11;
    ctx.font = `700 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    const tw = ctx.measureText(text).width;
    const lh = fontSize + 3;
    const padX = 3;
    const alignLeft = dx >= 0;
    const alignTop = dy >= 0;
    ctx.textAlign = alignLeft ? "left" : "right";
    ctx.textBaseline = alignTop ? "top" : "bottom";
    const boxX = alignLeft ? x - padX : x - tw - padX;
    const boxY = alignTop ? y : y - lh;
    ctx.fillStyle = "rgba(0, 0, 0, 0.62)";
    ctx.fillRect(boxX, boxY, tw + padX * 2, lh);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, x, y);
  }

  function vpuLabelOf(layer) {
    const key = normalizeVpuType(layer?.vpu);
    if (key) return key;
    const raw = String(layer?.vpu || "").trim();
    return raw && raw !== "—" ? raw : "";
  }

  function draw(payload) {
    const { canvas } = els();
    if (!canvas) return;
    lastPayload = payload;
    const { w: cssW, h: cssH } = resizeCanvas();
    if (!cssW || !cssH) return;

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.fillRect(0, 0, cssW, cssH);

    const layers = payload?.layers || [];
    const size = displaySize(payload);
    const pad = 48; // room for outside corner labels
    const availW = Math.max(40, cssW - pad * 2);
    const availH = Math.max(40, cssH - pad * 2);
    const rawItems = drawItemsFromLayers(layers);
    const n = Math.max(1, rawItems.length);

    const baseCorners = [
      { x: 0, y: 0 },
      { x: size.width, y: 0 },
      { x: size.width, y: size.height },
      { x: 0, y: size.height },
    ];

    // Pick explode gap so the stack aspect matches the panel when possible.
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
      // Want availH / (baseSpanY + (n-1)*gap) ≈ availW / baseSpanX
      const targetTotalY = (availH * baseSpanX) / availW;
      const rawGap = (targetTotalY - baseSpanY) / (n - 1);
      if (Number.isFinite(rawGap)) {
        gap = Math.min(maxGap, Math.max(minGap, rawGap));
      }
    } else {
      gap = 0;
    }

    const items = rawItems.map((item, i) => ({
      ...item,
      // Highest Z (earlier in Z-desc list) gets largest elevation.
      elev: (n - 1 - i) * gap,
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
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;

    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const scale = Math.min(availW / spanX, availH / spanY);
    if (!(scale > 0)) return;
    const ox = (cssW - spanX * scale) / 2 - minX * scale;
    const oy = (cssH - spanY * scale) / 2 - minY * scale;

    const toScreen = (x, y, elev) => {
      const p = project(x, y, elev, size);
      return { sx: ox + p.sx * scale, sy: oy + p.sy * scale };
    };

    // Base display plane.
    drawPoly(
      ctx,
      baseCorners.map((c) => toScreen(c.x, c.y, 0)),
      "rgba(142,160,178,0.1)",
      "rgba(180,200,220,0.7)",
      false
    );

    // Low Z first (bottom), high Z last (top).
    [...items].reverse().forEach(({ layer, colorIndex, elev, view, isClient, mergedCount }) => {
      if (!view) return;
      const corners = layerCorners(view);
      const pts = corners.map((c) => toScreen(c.x, c.y, elev));
      const alpha =
        layer.alpha?.float != null
          ? Math.min(0.55, Math.max(0.22, Number(layer.alpha.float) * 0.45))
          : 0.4;
      const colors = colorFor(colorIndex, alpha, layer);

      if (elev > 0) {
        ctx.strokeStyle = "rgba(142,160,178,0.28)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        // Only front two corners to reduce clutter.
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

      drawPoly(ctx, pts, colors.fill, colors.stroke, !!isClient);

      const left = view.x || 0;
      const top = view.y || 0;
      const right = left + (view.width || 0);
      const bottom = top + (view.height || 0);
      const idText =
        mergedCount > 1 ? `#${layer.id}×${mergedCount}` : `#${layer.id}`;
      // Corners: 0=TL, 2=BR outside; 3=BL id inside the layer.
      drawOutsideLabel(ctx, pts, 0, `[${left},${top}]`);
      drawOutsideLabel(ctx, pts, 2, `(${right},${bottom})`);
      drawInsideLabel(ctx, pts, 3, idText);
    });

    renderLegend(layers);
  }

  function fmtAlphaFloat(alpha) {
    if (alpha?.float != null && Number.isFinite(Number(alpha.float))) {
      return Number(alpha.float).toFixed(3);
    }
    if (alpha?.raw) {
      const m = String(alpha.raw).match(/^([-\d.]+)/);
      if (m) return Number(m[1]).toFixed(3);
    }
    return "—";
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

    // Z-desc order (same as payload.layers).
    layers.forEach((layer, i) => {
      const colors = colorFor(i, FILL_ALPHA, layer);
      const row = document.createElement("div");
      row.className = "hwc-legend-item";

      const swatch = document.createElement("span");
      swatch.className = "hwc-swatch";
      swatch.style.background = colors.fill;
      swatch.style.borderColor = colors.stroke;
      swatch.classList.add(isClientComp(layer) ? "dashed" : "solid");

      const label = document.createElement("span");
      label.className = "hwc-legend-label";
      const id = layer.id != null ? `#${layer.id}` : "#—";
      const content = layer.content || "—";
      const comp = `${layer.comp || "—"}${layer.comp_star ? "*" : ""}`;
      const vpu = vpuLabelOf(layer) || layer.vpu || "—";
      const format = layer.format || "—";
      const alpha = fmtAlphaFloat(layer.alpha);
      label.textContent = `${id} · ${content} · ${comp} · ${vpu} · ${format} · α ${alpha}`;
      label.title = label.textContent;

      row.appendChild(swatch);
      row.appendChild(label);
      legend.appendChild(row);
    });
  }

  function render(payload) {
    draw(payload);
    // Legend height can shrink the stage; redraw after layout settles.
    requestAnimationFrame(() => {
      if (lastPayload) draw(lastPayload);
    });
  }

  async function fetchSample() {
    const res = await fetch("/api/hwc/status");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "获取 HWC 状态失败");
    return data;
  }

  async function tick() {
    if (!running || fetching) return;
    fetching = true;
    try {
      const data = await fetchSample();
      render(data);
      const size = displaySize(data);
      const name = data.display_name || "HWC";
      const gens =
        data.state_gen != null && data.validated_gen != null
          ? ` · gen ${data.state_gen}/${data.validated_gen}`
          : "";
      setMeta(
        `${name} · ${data.count} 层（Z 降序） · 轴测爆炸 View ${size.width}×${size.height}${gens}`
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
    root = panelEl.querySelector(".hwc-st");
    if (!root) return;

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
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    root = null;
    lastPayload = null;
  }

  return { mount, unmount, start, stop };
})();
