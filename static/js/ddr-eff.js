window.DdrEffPanel = (() => {
  const MAX_POINTS = 120;
  const POLL_MS = 1000;
  const VISIBILITY_KEY = "android-board-ddr-eff-tracks-v1";

  const TRACKS = [
    {
      key: "total",
      target: "total",
      metaId: "ddr-eff-meta-total",
      canvasId: "ddr-eff-chart-total",
      emptyMeta: "total · —",
      defaultOn: true,
      synthetic: true,
    },
    {
      key: "cpu",
      target: "cpu_a55_main",
      metaId: "ddr-eff-meta-cpu",
      canvasId: "ddr-eff-chart-cpu",
      emptyMeta: "等待采样…",
      defaultOn: true,
    },
    {
      key: "gpu",
      target: "gpu",
      metaId: "ddr-eff-meta-gpu",
      canvasId: "ddr-eff-chart-gpu",
      emptyMeta: "gpu · —",
      defaultOn: true,
    },
    {
      key: "vpu",
      target: "vpu",
      metaId: "ddr-eff-meta-vpu",
      canvasId: "ddr-eff-chart-vpu",
      emptyMeta: "vpu · —",
      defaultOn: true,
    },
    {
      key: "audio",
      target: "audio",
      metaId: "ddr-eff-meta-audio",
      canvasId: "ddr-eff-chart-audio",
      emptyMeta: "audio · —",
      defaultOn: false,
    },
    {
      key: "vdec",
      target: "vdec_4k",
      metaId: "ddr-eff-meta-vdec",
      canvasId: "ddr-eff-chart-vdec",
      emptyMeta: "vdec_4k · —",
      defaultOn: false,
    },
    {
      key: "vdec2k",
      target: "vdec_2k_jpeg",
      metaId: "ddr-eff-meta-vdec2k",
      canvasId: "ddr-eff-chart-vdec2k",
      emptyMeta: "vdec_2k_jpeg · —",
      defaultOn: false,
    },
    {
      key: "emmc",
      target: "emmc_sd",
      metaId: "ddr-eff-meta-emmc",
      canvasId: "ddr-eff-chart-emmc",
      emptyMeta: "emmc_sd · —",
      defaultOn: false,
    },
    {
      key: "usbpcie",
      target: "usb_pcie",
      metaId: "ddr-eff-meta-usbpcie",
      canvasId: "ddr-eff-chart-usbpcie",
      emptyMeta: "usb_pcie · —",
      defaultOn: false,
    },
    {
      key: "phyeth",
      target: "phy_eth_dac",
      metaId: "ddr-eff-meta-phyeth",
      canvasId: "ddr-eff-chart-phyeth",
      emptyMeta: "phy_eth_dac · —",
      defaultOn: false,
    },
  ];

  const SAMPLE_TRACKS = TRACKS.filter((t) => !t.synthetic);
  const TARGETS = SAMPLE_TRACKS.map((t) => t.target);

  let root = null;
  let panelRoot = null;
  let charts = {};
  let timer = null;
  let running = false;
  let enabling = false;
  let ticking = false;
  let labels = [];
  const enabled = {};
  const series = {};

  TRACKS.forEach((t) => {
    enabled[t.key] = !!t.defaultOn;
    series[`${t.key}Rd`] = [];
    series[`${t.key}Wr`] = [];
  });

  function els() {
    const scope = panelRoot || root;
    const out = {
      clear: scope?.querySelector("#ddr-eff-clear"),
      status: root.querySelector("#ddr-eff-status"),
      toggles: root.querySelector("#ddr-eff-track-toggles"),
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

  function formatEff(v) {
    return Number(v).toFixed(2);
  }

  function timeLabel(date = new Date()) {
    return date.toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  /** Bytes per transaction: BW(B/s) / Trans; 0 when Trans is 0. */
  function effFromRow(row) {
    if (!row) return null;
    const rdTrans = Number(row.rd_trans) || 0;
    const wrTrans = Number(row.wr_trans) || 0;
    const rdBps = Number(row.rd_bps) || 0;
    const wrBps = Number(row.wr_bps) || 0;
    return {
      rd: rdTrans > 0 ? rdBps / rdTrans : 0,
      wr: wrTrans > 0 ? wrBps / wrTrans : 0,
    };
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
              return `${ctx.dataset.label}: ${v == null ? "—" : v.toFixed(2)} B/trans`;
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
          title: { display: true, text: "B/trans", color: "#8ea0b2" },
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

  function maxInWindow(arr) {
    let max = null;
    for (let i = 0; i < arr.length; i += 1) {
      const v = arr[i];
      if (v == null || Number.isNaN(v)) continue;
      if (max == null || v > max) max = v;
    }
    return max;
  }

  function clientLine(name, eff, peakRd, peakWr) {
    if (!eff) return `${name} · —`;
    const peakRdText = peakRd == null ? "—" : formatEff(peakRd);
    const peakWrText = peakWr == null ? "—" : formatEff(peakWr);
    return (
      `${name} · RD ${formatEff(eff.rd)} · WR ${formatEff(eff.wr)} · ` +
      `Peak RD ${peakRdText} · Peak WR ${peakWrText}`
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
    const sampleRows = SAMPLE_TRACKS.map((t) => ({
      track: t,
      row: clients[t.target] || null,
      eff: effFromRow(clients[t.target] || null),
    }));

    if (sampleRows.every(({ row }) => !row)) {
      const found = Array.isArray(sample.found) ? sample.found.join(", ") : "";
      throw new Error(
        sample.error ||
          (found
            ? `未找到 ${TARGETS.join("/")}；当前可见: ${found}`
            : `采样缺少 ${TARGETS.join(" / ")}`)
      );
    }

    labels.push(timeLabel());

    sampleRows.forEach(({ track, eff }) => {
      series[`${track.key}Rd`].push(eff ? eff.rd : null);
      series[`${track.key}Wr`].push(eff ? eff.wr : null);
    });

    // Board-wide total: sum BW / sum Trans across unique clients.
    const totalRow = data.total || {
      rd_bps: 0,
      wr_bps: 0,
      rd_trans: 0,
      wr_trans: 0,
    };
    const totalEff = effFromRow(totalRow);
    series.totalRd.push(totalEff.rd);
    series.totalWr.push(totalEff.wr);

    while (labels.length > MAX_POINTS) {
      labels.shift();
      Object.values(series).forEach((arr) => arr.shift());
    }

    updateCharts();

    const nodes = els();
    setMetaLine(
      nodes.meta_total,
      clientLine(
        "total",
        totalEff,
        maxInWindow(series.totalRd),
        maxInWindow(series.totalWr)
      )
    );
    sampleRows.forEach(({ track, eff }) => {
      setMetaLine(
        nodes[`meta_${track.key}`],
        clientLine(
          track.target,
          eff,
          maxInWindow(series[`${track.key}Rd`]),
          maxInWindow(series[`${track.key}Wr`])
        )
      );
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
    if (!running || ticking) return;
    if (window.Dashboard?.isPaused?.()) return;
    ticking = true;
    try {
      const sample = await fetchSample();
      pushSample(sample);
      const parts = [];
      if (sample.reenabled) parts.push("已自动重新初始化 monitor");
      if (sample.warning) parts.push(sample.warning);
      const extra = parts.length ? ` · ${parts.join(" · ")}` : "";
      setStatus(`监测中 · 最近更新 ${timeLabel()}${extra}`, !!sample.warning);
    } catch (err) {
      const msg = String(err.message || err);
      setStatus(msg, true);
    } finally {
      ticking = false;
    }
  }

  function stopPolling() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    running = false;
  }

  async function start() {
    if (running || enabling) return;
    enabling = true;
    setStatus("正在启用 DDR monitor…");
    try {
      await enable();
      ensureVisibleCharts();
      running = true;
      enabling = false;
      setStatus("监测中…");
      await tick();
      timer = setInterval(tick, POLL_MS);
    } catch (err) {
      enabling = false;
      running = false;
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
    panelRoot = panelEl;
    root = panelEl.querySelector(".ddr-eff");
    if (!root) return;

    loadVisibility();

    if (root.dataset.bound !== "1") {
      root.dataset.bound = "1";
      const { clear: clearBtn } = els();
      clearBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        clearSeries();
      });
      bindToggles();
    }

    applyVisibility();
    start();
  }

  function unmount() {
    stopPolling();
    destroyCharts();
    root = null;
    panelRoot = null;
  }

  return { mount, unmount, start, stop };
})();
