window.HwcPanel = (() => {
  const POLL_MS = 1000;
  const ALPHA = 0.8;
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

  function colorFor(index) {
    const [r, g, b] = PALETTE[index % PALETTE.length];
    return {
      fill: `rgba(${r}, ${g}, ${b}, ${ALPHA})`,
      stroke: `rgba(${r}, ${g}, ${b}, 1)`,
      swatch: `rgb(${r}, ${g}, ${b})`,
    };
  }

  function shortName(name) {
    if (!name) return "—";
    if (name.length <= 72) return name;
    return `${name.slice(0, 34)}…${name.slice(-34)}`;
  }

  function resizeCanvas() {
    const { stage, canvas } = els();
    if (!stage || !canvas) return;
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(120, Math.floor(rect.width));
    const cssH = Math.max(120, Math.floor(rect.height));
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(payload) {
    const { canvas, legend } = els();
    if (!canvas) return;
    resizeCanvas();
    const ctx = canvas.getContext("2d");
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;

    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.fillRect(0, 0, cssW, cssH);

    const layers = payload?.layers || [];
    const srcW = Math.max(1, payload?.width || 1920);
    const srcH = Math.max(1, payload?.height || 1080);
    const pad = 8;
    const scale = Math.min((cssW - pad * 2) / srcW, (cssH - pad * 2) / srcH);
    const ox = (cssW - srcW * scale) / 2;
    const oy = (cssH - srcH * scale) / 2;

    // Display bounds outline
    ctx.strokeStyle = "rgba(142, 160, 178, 0.55)";
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeRect(ox, oy, srcW * scale, srcH * scale);

    layers.forEach((layer, i) => {
      const fr = layer.frame || {};
      const left = fr.left || 0;
      const top = fr.top || 0;
      const right = fr.right || left;
      const bottom = fr.bottom || top;
      const x = ox + left * scale;
      const y = oy + top * scale;
      const w = Math.max(1, (fr.width || 0) * scale);
      const h = Math.max(1, (fr.height || 0) * scale);
      const colors = colorFor(layer.index ?? i);

      ctx.fillStyle = colors.fill;
      ctx.fillRect(x, y, w, h);

      ctx.strokeStyle = colors.stroke;
      ctx.lineWidth = layer.focused ? 2.5 : 1.5;
      if (String(layer.comp_type).toUpperCase() === "DEVICE") {
        ctx.setLineDash([]);
      } else {
        ctx.setLineDash([6, 4]);
      }
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
      ctx.setLineDash([]);

      // Corner coordinate labels: (left,top) / (right,bottom)
      const fontSize = Math.max(9, Math.min(12, Math.floor(Math.min(w, h) / 8)));
      ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      ctx.textBaseline = "top";
      const tl = `[${left},${top}]`;
      const br = `(${right},${bottom})`;
      const tlW = ctx.measureText(tl).width;
      const brW = ctx.measureText(br).width;
      const labelH = fontSize + 2;
      const inset = 3;

      // Top-left
      ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
      ctx.fillRect(x + inset, y + inset, tlW + 4, labelH);
      ctx.fillStyle = "#f2f6fa";
      ctx.textAlign = "left";
      ctx.fillText(tl, x + inset + 2, y + inset + 1);

      // Bottom-right
      ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
      ctx.fillRect(x + w - brW - inset - 4, y + h - labelH - inset, brW + 4, labelH);
      ctx.fillStyle = "#f2f6fa";
      ctx.textAlign = "left";
      ctx.fillText(br, x + w - brW - inset - 2, y + h - labelH - inset + 1);
    });

    if (legend) {
      legend.innerHTML = "";
      if (!layers.length) {
        const empty = document.createElement("div");
        empty.className = "hwc-legend-empty";
        empty.textContent = "暂无图层";
        legend.appendChild(empty);
      } else {
        // Legend: last table row (topmost) first.
        [...layers].reverse().forEach((layer, i) => {
          const colors = colorFor(layer.index ?? i);
          const row = document.createElement("div");
          row.className = "hwc-legend-item";
          if (layer.focused) row.classList.add("focused");

          const swatch = document.createElement("span");
          swatch.className = "hwc-swatch";
          swatch.style.background = colors.fill;
          swatch.style.borderColor = colors.stroke;
          if (String(layer.comp_type).toUpperCase() === "DEVICE") {
            swatch.classList.add("solid");
          } else {
            swatch.classList.add("dashed");
          }

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
    }
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
      const state = data.display_state ? ` · ${data.display_state}` : "";
      setMeta(`${data.count} 层 · ${data.width}×${data.height}${state}`);
      setStatus(`监测中 · 最近更新 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`);
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
