window.SfEventsPanel = (() => {
  const MAX_POINTS = 120;
  const POLL_MS = 1000;

  let root = null;
  let chart = null;
  let timer = null;
  let running = false;
  let fetching = false;
  let labels = [];
  const series = {
    work: [],
    ready: [],
    vsync: [],
  };

  function els() {
    return {
      meta: root.querySelector("#sf-events-meta"),
      canvas: root.querySelector("#sf-events-chart"),
      status: root.querySelector("#sf-events-status"),
      clear: root.querySelector("#sf-events-clear"),
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

  function fmtMs(v) {
    if (v == null || Number.isNaN(Number(v))) return "—";
    return `${Number(v).toFixed(2)} ms`;
  }

  function makeLineDataset(label, data, color) {
    return {
      label,
      data,
      borderColor: color,
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.2,
    };
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
          makeLineDataset("mWorkDuration", series.work, "#3d9cf0"),
          makeLineDataset("mReadyDuration", series.ready, "#2bb673"),
          makeLineDataset("last vsync", series.vsync, "#d4a017"),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            labels: { color: "#c5d2df", boxWidth: 12 },
          },
          tooltip: {
            callbacks: {
              label(ctx) {
                const v = ctx.parsed.y;
                return `${ctx.dataset.label}: ${v == null ? "—" : `${v.toFixed(2)} ms`}`;
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
            beginAtZero: true,
            title: { display: true, text: "ms", color: "#8ea0b2" },
            ticks: { color: "#8ea0b2" },
            grid: { color: "rgba(45, 58, 71, 0.55)" },
          },
        },
      },
    });
  }

  function pushSample(sample) {
    ensureChart();
    labels.push(timeLabel());
    series.work.push(
      sample.work_duration_ms == null ? null : Number(sample.work_duration_ms)
    );
    series.ready.push(
      sample.ready_duration_ms == null ? null : Number(sample.ready_duration_ms)
    );
    series.vsync.push(
      sample.last_vsync_ms == null ? null : Number(sample.last_vsync_ms)
    );

    while (labels.length > MAX_POINTS) {
      labels.shift();
      series.work.shift();
      series.ready.shift();
      series.vsync.shift();
    }

    if (chart) chart.update("none");

    const extra = [];
    if (sample.pending_count != null) extra.push(`pending ${sample.pending_count}`);
    if (sample.connection_count != null) {
      extra.push(`conn ${sample.connection_count}`);
    }
    setMeta(
      `work ${fmtMs(sample.work_duration_ms)} · ready ${fmtMs(sample.ready_duration_ms)} · ` +
        `vsync ${fmtMs(sample.last_vsync_ms)}` +
        (extra.length ? ` · ${extra.join(" · ")}` : "")
    );
  }

  function clearSeries() {
    labels.length = 0;
    series.work.length = 0;
    series.ready.length = 0;
    series.vsync.length = 0;
    if (chart) chart.update("none");
    setMeta("等待采样…");
  }

  async function fetchSample() {
    const res = await fetch("/api/sf/events");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "获取 Sf-事件失败");
    return data;
  }

  async function tick() {
    if (!running || fetching) return;
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
    root = panelEl.querySelector(".sf-events");
    if (!root) return;

    if (root.dataset.bound !== "1") {
      root.dataset.bound = "1";
      const { clear } = els();
      if (clear) clear.addEventListener("click", () => clearSeries());
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
  }

  return { mount, unmount, start, stop };
})();
