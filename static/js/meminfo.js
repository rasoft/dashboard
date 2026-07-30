window.MeminfoPanel = (() => {
  const MAX_POINTS = 120;
  const POLL_MS = 1000;

  let root = null;
  let panelRoot = null;
  let chart = null;
  let timer = null;
  let running = false;
  let fetching = false;
  let labels = [];
  let memTotalMiB = null;
  // Stack bottom → top: Swap → Cached+Buffers → AnonPages; MemUsed is a separate overlay line.
  const series = {
    swapUsed: [],
    cachedBuffers: [],
    anon: [],
    used: [],
  };

  function els() {
    const scope = panelRoot || root;
    return {
      meta: root.querySelector("#meminfo-meta"),
      canvas: root.querySelector("#meminfo-chart"),
      status: root.querySelector("#meminfo-status"),
      clear: scope?.querySelector("#meminfo-clear"),
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

  function timeLabel(date = new Date()) {
    return date.toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function kbToMiB(kb) {
    if (kb == null || Number.isNaN(Number(kb))) return null;
    return Number(kb) / 1024;
  }

  function fmtMiB(kb) {
    const mib = kbToMiB(kb);
    if (mib == null) return "—";
    return `${mib.toFixed(1)} MiB`;
  }

  function rgba(hex, alpha) {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function makeStackDataset(label, data, color) {
    return {
      label,
      data,
      borderColor: color,
      backgroundColor: rgba(color, 0.55),
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.15,
      fill: true,
      yAxisID: "y",
    };
  }

  function makeOverlayLine(label, data, color) {
    return {
      label,
      data,
      borderColor: color,
      backgroundColor: "transparent",
      borderWidth: 2.25,
      pointRadius: 0,
      tension: 0.15,
      fill: false,
      yAxisID: "y1",
      order: -1,
    };
  }

  function syncAxisMax() {
    if (!chart) return;
    const max = memTotalMiB != null && memTotalMiB > 0 ? memTotalMiB : undefined;
    chart.options.scales.y.max = max;
    chart.options.scales.y1.max = max;
  }

  function ensureChart() {
    if (chart) return;
    if (typeof Chart === "undefined") {
      setStatus("Chart.js 未加载", true);
      return;
    }
    const { canvas } = els();
    if (!canvas) return;
    chart = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels,
        datasets: [
          makeStackDataset("Swap 已用", series.swapUsed, "#d4a017"),
          makeStackDataset("Cached + Buffers", series.cachedBuffers, "#2bb673"),
          makeStackDataset("AnonPages", series.anon, "#e36b6b"),
          makeOverlayLine("MemUsed", series.used, "#e8eef5"),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            reverse: true,
            labels: { color: "#c5d2df", boxWidth: 12 },
          },
          tooltip: {
            callbacks: {
              label(ctx) {
                const v = ctx.parsed.y;
                return `${ctx.dataset.label}: ${v == null ? "—" : `${v.toFixed(1)} MiB`}`;
              },
              footer(items) {
                const stackSum = items.reduce((acc, it) => {
                  if (it.dataset?.yAxisID === "y1") return acc;
                  const v = it.parsed?.y;
                  return acc + (v == null || Number.isNaN(v) ? 0 : v);
                }, 0);
                return `层叠合计 ${stackSum.toFixed(1)} MiB`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: "#8ea0b2", maxTicksLimit: 8 },
            grid: { color: "rgba(45, 58, 71, 0.55)" },
          },
          y: {
            stacked: true,
            beginAtZero: true,
            title: { display: true, text: "MiB", color: "#8ea0b2" },
            ticks: { color: "#8ea0b2" },
            grid: { color: "rgba(45, 58, 71, 0.55)" },
          },
          y1: {
            stacked: false,
            display: false,
            beginAtZero: true,
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
  }

  function pushSample(sample) {
    ensureChart();
    labels.push(timeLabel());
    series.swapUsed.push(kbToMiB(sample.swap_used_kb));
    series.cachedBuffers.push(kbToMiB(sample.cached_buffers_kb));
    series.anon.push(kbToMiB(sample.anon_pages_kb));
    series.used.push(kbToMiB(sample.mem_used_kb));
    memTotalMiB = kbToMiB(sample.mem_total_kb);

    while (labels.length > MAX_POINTS) {
      labels.shift();
      series.swapUsed.shift();
      series.cachedBuffers.shift();
      series.anon.shift();
      series.used.shift();
    }

    syncAxisMax();
    if (chart) chart.update("none");

    setMeta(
      `MemUsed ${fmtMiB(sample.mem_used_kb)} · Swap ${fmtMiB(sample.swap_used_kb)} · ` +
        `Cached+Buf ${fmtMiB(sample.cached_buffers_kb)} · Anon ${fmtMiB(sample.anon_pages_kb)} · ` +
        `Total ${fmtMiB(sample.mem_total_kb)}`
    );
  }

  function clearSeries() {
    labels.length = 0;
    series.swapUsed.length = 0;
    series.cachedBuffers.length = 0;
    series.anon.length = 0;
    series.used.length = 0;
    syncAxisMax();
    if (chart) chart.update("none");
    setMeta("等待采样…");
  }

  async function fetchSample() {
    const res = await fetch("/api/proc/meminfo");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "获取 /proc/meminfo 失败");
    return data;
  }

  async function tick() {
    if (!running || fetching) return;
    if (window.Dashboard?.isPaused?.()) return;
    fetching = true;
    try {
      const data = await fetchSample();
      pushSample(data);
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

  function mount(panelEl) {
    panelRoot = panelEl;
    root = panelEl.querySelector(".meminfo");
    if (!root) return;

    if (root.dataset.bound !== "1") {
      root.dataset.bound = "1";
      const { clear } = els();
      clear?.addEventListener("click", (e) => {
        e.stopPropagation();
        clearSeries();
      });
    }

    // Recreate chart so series/options changes apply after hot reload.
    if (chart) {
      chart.destroy();
      chart = null;
    }
    ensureChart();
    requestAnimationFrame(() => {
      if (chart) chart.resize();
    });
    start();
  }

  function unmount() {
    stop();
    if (chart) {
      chart.destroy();
      chart = null;
    }
    root = null;
    panelRoot = null;
  }

  return { mount, unmount, start, stop };
})();
