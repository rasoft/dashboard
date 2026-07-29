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
      list: root.querySelector("#hwc-st-list"),
      notes: root.querySelector("#hwc-st-notes"),
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

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtRect(r) {
    if (!r) return "—";
    return `${r.left} ${r.top} ${r.right} ${r.bottom}`;
  }

  function fmtBox(b) {
    if (!b) return "—";
    return `${b.x} ${b.y} ${b.width} ${b.height}`;
  }

  function fmtAlpha(a) {
    if (!a) return "—";
    if (a.raw) return a.raw;
    if (a.float != null && a.byte != null) return `${a.float}/${a.byte}`;
    return "—";
  }

  function colorFor(index, alpha = FILL_ALPHA) {
    const [r, g, b] = PALETTE[index % PALETTE.length];
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
    const pad = 16;
    const n = Math.max(1, layers.length);
    // Keep explode gap modest so the stack stays readable in a small panel.
    const gap = Math.max(120, Math.min(size.width, size.height) * 0.18);

    const items = layers.map((layer, i) => ({
      layer,
      colorIndex: i,
      // List is Z-desc; highest Z gets largest elevation.
      elev: (n - 1 - i) * gap,
      view: viewOf(layer),
    }));

    const baseCorners = [
      { x: 0, y: 0 },
      { x: size.width, y: 0 },
      { x: size.width, y: size.height },
      { x: 0, y: size.height },
    ];

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
    const scale = Math.min((cssW - pad * 2) / spanX, (cssH - pad * 2) / spanY);
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
    [...items].reverse().forEach(({ layer, colorIndex, elev, view }) => {
      if (!view) return;
      const corners = layerCorners(view);
      const pts = corners.map((c) => toScreen(c.x, c.y, elev));
      const alpha =
        layer.alpha?.float != null
          ? Math.min(0.55, Math.max(0.22, Number(layer.alpha.float) * 0.45))
          : 0.4;
      const colors = colorFor(colorIndex, alpha);
      const compType = String(layer.comp || "").trim().toLowerCase();
      const isClient = compType === "client" || compType.startsWith("client");

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

      drawPoly(ctx, pts, colors.fill, colors.stroke, isClient);

      drawOutsideLabel(ctx, pts, 0, `Z${layer.z} #${layer.id}`);
    });
  }

  function renderList(payload) {
    const { list, notes } = els();
    if (!list) return;

    const layers = payload.layers || [];
    if (!layers.length) {
      list.innerHTML = '<div class="hwc-st-empty">暂无图层</div>';
    } else {
      list.innerHTML = layers
        .map((layer, i) => {
          const colors = colorFor(i);
          const comp = `${escapeHtml(layer.comp || "—")}${
            layer.comp_star ? "*" : ""
          }`;
          const content = escapeHtml(layer.content || "—");
          const compType = String(layer.comp || "").trim().toLowerCase();
          const isClient =
            compType === "client" || compType.startsWith("client");
          const isDevice = compType === "device";
          return [
            `<div class="hwc-st-row${isDevice ? " device" : ""}${
              isClient ? " client" : ""
            }">`,
            `<div class="hwc-st-row-head">`,
            `<span class="hwc-st-swatch${isClient ? " dashed" : ""}" style="background:${colors.fill};border-color:${colors.stroke}"></span>`,
            `<span class="hwc-st-z">Z ${escapeHtml(String(layer.z))}</span>`,
            `<span class="hwc-st-id">ID ${escapeHtml(String(layer.id))}</span>`,
            `<span class="hwc-st-content">${content}</span>`,
            `<span class="hwc-st-comp">${comp}</span>`,
            `<span class="hwc-st-vpu">${escapeHtml(layer.vpu || "—")}</span>`,
            `<span class="hwc-st-format">${escapeHtml(layer.format || "—")}</span>`,
            `<span class="hwc-st-alpha">α ${escapeHtml(fmtAlpha(layer.alpha))}</span>`,
            `</div>`,
            `<div class="hwc-st-row-meta">`,
            `View ${escapeHtml(fmtBox(layer.vpu_view))}`,
            ` · Disp ${escapeHtml(fmtRect(layer.disp_frame))}`,
            ` · Crop ${escapeHtml(fmtRect(layer.source_crop))}`,
            ` · Clip ${escapeHtml(fmtBox(layer.vpu_clip))}`,
            `</div>`,
            `</div>`,
          ].join("");
        })
        .join("");
    }

    if (notes) {
      const noteLines = payload.notes || [];
      notes.innerHTML = noteLines.length
        ? noteLines
            .map((n) => `<div class="hwc-st-note">${escapeHtml(n)}</div>`)
            .join("")
        : "";
    }
  }

  function render(payload) {
    draw(payload);
    renderList(payload);
    // List height can shrink the stage; redraw after layout settles.
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
