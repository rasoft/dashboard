window.DdrPanel = (() => {
  const MAX_POINTS = 120;
  const POLL_MS = 1000;
  const VISIBILITY_KEY = "android-board-ddr-tracks-v1";

  const TRACKS = [
    {
      key: "cpu",
      target: "cpu_a55_main",
      metaId: "ddr-meta-cpu",
      canvasId: "ddr-chart-cpu",
      emptyMeta: "等待采样…",
      defaultOn: true,
    },
    {
      key: "gpu",
      target: "gpu",
      metaId: "ddr-meta-gpu",
      canvasId: "ddr-chart-gpu",
      emptyMeta: "gpu · —",
      defaultOn: true,
    },
    {
      key: "vpu",
      target: "vpu",
      metaId: "ddr-meta-vpu",
      canvasId: "ddr-chart-vpu",
      emptyMeta: "vpu · —",
      defaultOn: true,
    },
    {
      key: "audio",
      target: "audio",
      metaId: "ddr-meta-audio",
      canvasId: "ddr-chart-audio",
      emptyMeta: "audio · —",
      defaultOn: false,
    },
    {
      key: "vdec",
      target: "vdec_4k",
      metaId: "ddr-meta-vdec",
      canvasId: "ddr-chart-vdec",
      emptyMeta: "vdec_4k · —",
      defaultOn: false,
    },
    {
      key: "vdec2k",
      target: "vdec_2k_jpeg",
      metaId: "ddr-meta-vdec2k",
      canvasId: "ddr-chart-vdec2k",
      emptyMeta: "vdec_2k_jpeg · —",
      defaultOn: false,
    },
    {
      key: "emmc",
      target: "emmc_sd",
      metaId: "ddr-meta-emmc",
      canvasId: "ddr-chart-emmc",
      emptyMeta: "emmc_sd · —",
      defaultOn: false,
    },
    {
      key: "usbpcie",
      target: "usb_pcie",
      metaId: "ddr-meta-usbpcie",
      canvasId: "ddr-chart-usbpcie",
      emptyMeta: "usb_pcie · —",
      defaultOn: false,
    },
    {
      key: "phyeth",
      target: "phy_eth_dac",
      metaId: "ddr-meta-phyeth",
      canvasId: "ddr-chart-phyeth",
      emptyMeta: "phy_eth_dac · —",
      defaultOn: false,
    },
  ];

  const TARGETS = TRACKS.map((t) => t.target);

  let root = null;
  let charts = {};
  let timer = null;
  let running = false;
  let enabling = false;
  let labels = [];
  const enabled = {};
  const series = {};

  TRACKS.forEach((t) => {
    enabled[t.key] = !!t.defaultOn;
    series[`${t.key}Rd`] = [];
    series[`${t.key}Wr`] = [];
    series[`${t.key}Total`] = [];
  });

  function els() {
    const out = {
      start: root.querySelector("#ddr-start"),
      stop: root.querySelector("#ddr-stop"),
      clear: root.querySelector("#ddr-clear"),
      status: root.querySelector("#ddr-status"),
      toggles: root.querySelector("#ddr-track-toggles"),
    };
    TRACKS.forEach((t) => {
      out[`meta_${t.key}`] = root.querySelector(`#${t.metaId}`);
      out[`canvas_${t.key}`] = root.querySelector(`#${t.canvasId}`);
      out[`block_${t.key}`] = root.querySelector(`.ddr-chart-block[data-track="${t.key}"]`);
      out[`toggle_${t.key}`] = root.querySelector(`.ddr-track-btn[data-track="${t.key}"]`);
    });
    return out;
  }

  function loadVisibility() {
    try {
      const raw = JSON.parse(localStorage.getItem(VISIBILITY_KEY) || "null");
      if (!raw || typeof raw !== "object") return;
      TRACKS.forEach((t) => {
        if (typeof raw[t.key] === "boolean") enabled[t.key] = raw[t.key];
      });
    } catch {
      /* ignore */
    }
  }

  function saveVisibility() {
    localStorage.setItem(VISIBILITY_KEY, JSON.stringify({ ...enabled }));
  }

  function setStatus(text, isError = false) {
    const { status } = els();
    if (!status) return;
    status.textContent = text;
    status.classList.toggle("error", !!isError);
  }

  function setMetaLine(el, text) {
    if (el) el.textContent = text;
  }

  function setButtons() {
    const { start, stop } = els();
    if (start) start.disabled = running || enabling;
    if (stop) stop.disabled = !running;
  }

  function formatMbps(bps) {
    return (Number(bps) / (1024 * 1024)).toFixed(2);
  }

  function formatFreq(hz) {
    if (!hz) return "—";
    if (hz >= 1e9) return `${(hz / 1e9).toFixed(2)} GHz`;
    if (hz >= 1e6) return `${(hz / 1e6).toFixed(0)} MHz`;
    return `${hz} Hz`;
  }

  function timeLabel(date = new Date()) {
    return date.toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function toMbps(bps) {
    return Number(bps) / (1024 * 1024);
  }

  function chartOptions() {
    return {
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
              return `${ctx.dataset.label}: ${v == null ? "—" : v.toFixed(2)} MB/s`;
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
          title: { display: true, text: "MB/s", color: "#8ea0b2" },
          ticks: { color: "#8ea0b2" },
          grid: { color: "rgba(45, 58, 71, 0.55)" },
        },
      },
    };
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

  function ensureChart(key) {
    if (typeof Chart === "undefined") {
      setStatus("Chart.js 未加载", true);
      return;
    }
    if (charts[key]) return;
    const track = TRACKS.find((t) => t.key === key);
    if (!track) return;
    const canvas = els()[`canvas_${key}`];
    if (!canvas) return;
    charts[key] = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels,
        datasets: [
          makeLineDataset("RD", series[`${key}Rd`], "#3d9cf0"),
          makeLineDataset("WR", series[`${key}Wr`], "#2bb673"),
          makeLineDataset("Total", series[`${key}Total`], "#d4a017"),
        ],
      },
      options: chartOptions(),
    });
  }

  function ensureVisibleCharts() {
    TRACKS.forEach((t) => {
      if (enabled[t.key]) ensureChart(t.key);
    });
  }

  function updateCharts() {
    TRACKS.forEach((t) => {
      if (!enabled[t.key]) return;
      const chart = charts[t.key];
      if (chart) chart.update("none");
    });
  }

  function destroyCharts() {
    Object.values(charts).forEach((c) => c.destroy());
    charts = {};
  }

  function applyVisibility() {
    const nodes = els();
    TRACKS.forEach((t) => {
      const on = !!enabled[t.key];
      const block = nodes[`block_${t.key}`];
      const toggle = nodes[`toggle_${t.key}`];
      if (block) block.hidden = !on;
      if (toggle) toggle.setAttribute("aria-pressed", on ? "true" : "false");
      if (on) {
        ensureChart(t.key);
        // Chart.js needs a resize after becoming visible.
        requestAnimationFrame(() => {
          if (charts[t.key]) charts[t.key].resize();
        });
      }
    });
  }

  function setTrackEnabled(key, on) {
    if (!(key in enabled)) return;
    enabled[key] = !!on;
    saveVisibility();
    applyVisibility();
  }

  function toggleTrack(key) {
    setTrackEnabled(key, !enabled[key]);
  }

  function clientLine(name, row) {
    if (!row) return `${name} · —`;
    return (
      `${name} · RD ${formatMbps(row.rd_bps)} · WR ${formatMbps(row.wr_bps)} · ` +
      `Total ${formatMbps(row.total_bps)} MB/s`
    );
  }

  function normalizeSample(data) {
    if (data.clients && typeof data.clients === "object") {
      return data;
    }
    if (data.name && data.rd_bps != null) {
      return {
        ...data,
        clients: { [data.name]: data },
      };
    }
    return { ...data, clients: {} };
  }

  function pushSample(sample) {
    const data = normalizeSample(sample);
    const clients = data.clients || {};
    const rows = TRACKS.map((t) => ({ track: t, row: clients[t.target] || null }));

    if (rows.every(({ row }) => !row)) {
      const found = Array.isArray(sample.found) ? sample.found.join(", ") : "";
      throw new Error(
        sample.error ||
          (found
            ? `未找到 ${TARGETS.join("/")}；当前可见: ${found}`
            : `采样缺少 ${TARGETS.join(" / ")}`)
      );
    }

    labels.push(timeLabel());
    rows.forEach(({ track, row }) => {
      series[`${track.key}Rd`].push(row ? toMbps(row.rd_bps) : null);
      series[`${track.key}Wr`].push(row ? toMbps(row.wr_bps) : null);
      series[`${track.key}Total`].push(row ? toMbps(row.total_bps) : null);
    });

    while (labels.length > MAX_POINTS) {
      labels.shift();
      Object.values(series).forEach((arr) => arr.shift());
    }

    updateCharts();

    const nodes = els();
    rows.forEach(({ track, row }) => {
      let text = clientLine(track.target, row);
      if (track.key === "cpu") {
        text = `DDR ${formatFreq(data.freq_hz)} · ${text}`;
      }
      setMetaLine(nodes[`meta_${track.key}`], text);
    });
  }

  function clearSeries() {
    labels.length = 0;
    Object.values(series).forEach((arr) => {
      arr.length = 0;
    });
    updateCharts();
    const nodes = els();
    TRACKS.forEach((t) => setMetaLine(nodes[`meta_${t.key}`], t.emptyMeta));
  }

  async function enable() {
    const res = await fetch("/api/ddr/enable", { method: "POST" });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "启用 DDR monitor 失败");
    return data;
  }

  async function fetchSample() {
    const params = new URLSearchParams({ targets: TARGETS.join(",") });
    const res = await fetch(`/api/ddr/sample?${params}`);
    const data = await res.json();
    if (!data.ok) {
      const detail = data.found?.length ? `；可见: ${data.found.join(", ")}` : "";
      throw new Error((data.error || "采样失败") + detail);
    }
    return data;
  }

  async function tick() {
    if (!running) return;
    try {
      const sample = await fetchSample();
      pushSample(sample);
      const warn = sample.warning ? ` · ${sample.warning}` : "";
      setStatus(`监测中 · 最近更新 ${timeLabel()}${warn}`, !!sample.warning);
    } catch (err) {
      setStatus(String(err.message || err), true);
    }
  }

  function stopPolling() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    running = false;
    setButtons();
  }

  async function start() {
    if (running || enabling) return;
    enabling = true;
    setButtons();
    setStatus("正在启用 DDR monitor…");
    try {
      await enable();
      ensureVisibleCharts();
      running = true;
      enabling = false;
      setButtons();
      setStatus("监测中…");
      await tick();
      timer = setInterval(tick, POLL_MS);
    } catch (err) {
      enabling = false;
      running = false;
      setButtons();
      setStatus(String(err.message || err), true);
    }
  }

  function stop() {
    stopPolling();
    setStatus("已停止");
  }

  function bindToggles() {
    const { toggles } = els();
    if (!toggles || toggles.dataset.bound === "1") return;
    toggles.dataset.bound = "1";
    toggles.querySelectorAll(".ddr-track-btn[data-track]").forEach((btn) => {
      btn.addEventListener("click", () => toggleTrack(btn.dataset.track));
    });
  }

  function mount(panelEl) {
    root = panelEl.querySelector(".ddr");
    if (!root) return;

    loadVisibility();

    if (root.dataset.bound !== "1") {
      root.dataset.bound = "1";
      const { start: startBtn, stop: stopBtn, clear: clearBtn } = els();
      startBtn?.addEventListener("click", () => start());
      stopBtn?.addEventListener("click", () => stop());
      clearBtn?.addEventListener("click", () => clearSeries());
      bindToggles();
    }

    applyVisibility();
    setButtons();
    start();
  }

  function unmount() {
    stopPolling();
    destroyCharts();
    root = null;
  }

  return { mount, unmount, start, stop };
})();
