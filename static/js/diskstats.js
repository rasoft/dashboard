window.DiskstatsPanel = (() => {
  const MAX_POINTS = 120;
  const POLL_MS = 1000;
  const VISIBILITY_KEY = "android-board-diskstats-tracks-v2";
  const SECTOR_BYTES = 512;

  let root = null;
  let panelRoot = null;
  let tracks = [];
  let charts = {};
  let timer = null;
  let running = false;
  let starting = false;
  let ticking = false;
  let labels = [];
  let prevSample = null;
  const enabled = {};
  const series = {};

  function els() {
    const scope = panelRoot || root;
    return {
      clear: scope?.querySelector("#diskstats-clear"),
      status: root.querySelector("#diskstats-status"),
      toggles: root.querySelector("#diskstats-track-toggles"),
      charts: root.querySelector("#diskstats-charts"),
    };
  }

  function trackNodes(key) {
    return {
      meta: root.querySelector(`#diskstats-meta-${cssEscape(key)}`),
      canvas: root.querySelector(`#diskstats-chart-${cssEscape(key)}`),
      block: root.querySelector(`.ddr-chart-block[data-track="${cssAttr(key)}"]`),
      toggle: root.querySelector(`.ddr-track-btn[data-track="${cssAttr(key)}"]`),
    };
  }

  function cssEscape(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function cssAttr(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function loadVisibility() {
    try {
      const raw = JSON.parse(localStorage.getItem(VISIBILITY_KEY) || "null");
      if (!raw || typeof raw !== "object") return;
      tracks.forEach((t) => {
        if (typeof raw[t.key] === "boolean") enabled[t.key] = raw[t.key];
      });
    } catch {
      /* ignore */
    }
  }

  function saveVisibility() {
    const payload = {};
    tracks.forEach((t) => {
      payload[t.key] = !!enabled[t.key];
    });
    localStorage.setItem(VISIBILITY_KEY, JSON.stringify(payload));
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

  function formatMBps(bps) {
    return (Number(bps) / (1024 * 1024)).toFixed(2);
  }

  function toMBps(bps) {
    return Number(bps) / (1024 * 1024);
  }

  function timeLabel(date = new Date()) {
    return date.toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
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

  function ensureSeries(key) {
    if (!series[`${key}Rd`]) series[`${key}Rd`] = [];
    if (!series[`${key}Wr`]) series[`${key}Wr`] = [];
    if (!series[`${key}Total`]) series[`${key}Total`] = [];
  }

  function ensureChart(key) {
    if (typeof Chart === "undefined") {
      setStatus("Chart.js 未加载", true);
      return;
    }
    if (charts[key]) return;
    ensureSeries(key);
    const { canvas } = trackNodes(key);
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

  function updateCharts() {
    tracks.forEach((t) => {
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
    tracks.forEach((t) => {
      const on = !!enabled[t.key];
      const nodes = trackNodes(t.key);
      if (nodes.block) nodes.block.hidden = !on;
      if (nodes.toggle) nodes.toggle.setAttribute("aria-pressed", on ? "true" : "false");
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

  function trackTitle(track) {
    if (track.kind === "mount" && track.device) {
      return `${track.label} · ${track.device}`;
    }
    return track.label || track.device || track.key;
  }

  function maxTotalInWindow(key) {
    const arr = series[`${key}Total`] || [];
    let max = null;
    for (let i = 0; i < arr.length; i += 1) {
      const v = arr[i];
      if (v == null || Number.isNaN(v)) continue;
      if (max == null || v > max) max = v;
    }
    return max;
  }

  function deviceLine(track, row, maxTotalMbps) {
    const name = trackTitle(track);
    if (!row) return `${name} · —`;
    const maxText =
      maxTotalMbps == null ? "—" : Number(maxTotalMbps).toFixed(2);
    return (
      `${name} · RD ${formatMBps(row.rd_bps)} · WR ${formatMBps(row.wr_bps)} · ` +
      `Total ${formatMBps(row.total_bps)} · Peak ${maxText}`
    );
  }

  function ratesFrom(prev, curr) {
    const sectorBytes = Number(curr.sector_bytes) || SECTOR_BYTES;
    const dt = (Number(curr.ts_ms) - Number(prev.ts_ms)) / 1000;
    if (!(dt > 0)) return null;

    const out = {};
    tracks.forEach((t) => {
      const a = prev.devices?.[t.device];
      const b = curr.devices?.[t.device];
      if (!a || !b) {
        out[t.key] = null;
        return;
      }
      const dRead = b.sectors_read - a.sectors_read;
      const dWrite = b.sectors_written - a.sectors_written;
      if (dRead < 0 || dWrite < 0) {
        out[t.key] = null;
        return;
      }
      const rd_bps = (dRead * sectorBytes) / dt;
      const wr_bps = (dWrite * sectorBytes) / dt;
      out[t.key] = {
        rd_bps,
        wr_bps,
        total_bps: rd_bps + wr_bps,
      };
    });
    return out;
  }

  function pushSample(sample) {
    if (!prevSample) {
      prevSample = sample;
      tracks.forEach((t) => {
        const present = !!sample.devices?.[t.device];
        setMetaLine(
          trackNodes(t.key).meta,
          present ? `${trackTitle(t)} · 校准中…` : `${trackTitle(t)} · 未找到`
        );
      });
      return;
    }

    const rates = ratesFrom(prevSample, sample);
    prevSample = sample;
    if (!rates) return;

    labels.push(timeLabel());
    tracks.forEach((t) => {
      ensureSeries(t.key);
      const row = rates[t.key];
      series[`${t.key}Rd`].push(row ? toMBps(row.rd_bps) : null);
      series[`${t.key}Wr`].push(row ? toMBps(row.wr_bps) : null);
      series[`${t.key}Total`].push(row ? toMBps(row.total_bps) : null);
    });

    while (labels.length > MAX_POINTS) {
      labels.shift();
      Object.values(series).forEach((arr) => arr.shift());
    }

    tracks.forEach((t) => {
      setMetaLine(
        trackNodes(t.key).meta,
        deviceLine(t, rates[t.key], maxTotalInWindow(t.key))
      );
    });

    updateCharts();
  }

  function clearSeries() {
    labels.length = 0;
    Object.values(series).forEach((arr) => {
      arr.length = 0;
    });
    prevSample = null;
    updateCharts();
    tracks.forEach((t) => {
      setMetaLine(trackNodes(t.key).meta, `${trackTitle(t)} · —`);
    });
  }

  function sampleDevices() {
    const seen = new Set();
    const out = [];
    tracks.forEach((t) => {
      if (!t.device || seen.has(t.device)) return;
      seen.add(t.device);
      out.push(t.device);
    });
    return out;
  }

  async function fetchMap() {
    const res = await fetch("/api/proc/diskstats/map");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "解析 df 挂载映射失败");
    return data;
  }

  async function fetchSample() {
    const devices = sampleDevices();
    const params = new URLSearchParams({ devices: devices.join(",") });
    const res = await fetch(`/api/proc/diskstats?${params}`);
    const data = await res.json();
    if (!data.ok) {
      const detail = data.found?.length ? `；可见: ${data.found.join(", ")}` : "";
      throw new Error((data.error || "采样失败") + detail);
    }
    return data;
  }

  function renderTracks(mapData) {
    const { toggles, charts: chartsHost } = els();
    if (!toggles || !chartsHost) return;

    destroyCharts();
    labels.length = 0;
    Object.keys(series).forEach((k) => delete series[k]);
    prevSample = null;

    tracks = Array.isArray(mapData.tracks) ? mapData.tracks.slice() : [];
    tracks.forEach((t) => {
      enabled[t.key] = typeof enabled[t.key] === "boolean" ? enabled[t.key] : !!t.default_on;
      ensureSeries(t.key);
    });
    loadVisibility();

    toggles.innerHTML = "";
    chartsHost.innerHTML = "";

    tracks.forEach((t) => {
      const idSafe = cssEscape(t.key);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ddr-track-btn";
      btn.dataset.track = t.key;
      btn.textContent = t.label || t.device || t.key;
      btn.title = trackTitle(t);
      btn.setAttribute("aria-pressed", enabled[t.key] ? "true" : "false");
      btn.addEventListener("click", () => toggleTrack(t.key));
      toggles.appendChild(btn);

      const section = document.createElement("section");
      section.className = "ddr-chart-block";
      section.dataset.track = t.key;
      section.hidden = !enabled[t.key];
      section.innerHTML = `
        <div class="ddr-meta" id="diskstats-meta-${idSafe}">${trackTitle(t)} · —</div>
        <div class="ddr-chart-wrap">
          <canvas id="diskstats-chart-${idSafe}" aria-label="${trackTitle(t)} 磁盘读写曲线"></canvas>
        </div>
      `;
      chartsHost.appendChild(section);
    });

    applyVisibility();
  }

  async function tick() {
    if (!running || ticking || !tracks.length) return;
    if (window.Dashboard?.isPaused?.()) return;
    ticking = true;
    try {
      const sample = await fetchSample();
      pushSample(sample);
      const missing = Array.isArray(sample.missing) ? sample.missing.filter(Boolean) : [];
      const extra = missing.length ? ` · 缺少 ${missing.join(", ")}` : "";
      setStatus(`监测中 · 最近更新 ${timeLabel()}${extra}`, missing.length > 0);
    } catch (err) {
      setStatus(String(err.message || err), true);
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
    if (running || starting) return;
    starting = true;
    setStatus("正在通过 df 解析挂载磁盘…");
    try {
      const mapData = await fetchMap();
      renderTracks(mapData);
      if (!tracks.length) {
        throw new Error("未解析到可监测磁盘");
      }
      const unresolved = Array.isArray(mapData.unresolved) ? mapData.unresolved : [];
      const unresolvedHint = unresolved.length
        ? ` · 未映射 ${unresolved.map((u) => u.mount).join(", ")}`
        : "";
      running = true;
      starting = false;
      setStatus(`监测中${unresolvedHint}`);
      await tick();
      timer = setInterval(tick, POLL_MS);
    } catch (err) {
      starting = false;
      running = false;
      setStatus(String(err.message || err), true);
    }
  }

  function stop() {
    stopPolling();
    setStatus("已停止");
  }

  function mount(panelEl) {
    panelRoot = panelEl;
    root = panelEl.querySelector(".diskstats");
    if (!root) return;

    if (root.dataset.bound !== "1") {
      root.dataset.bound = "1";
      const { clear: clearBtn } = els();
      clearBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        clearSeries();
      });
    }

    start();
  }

  function unmount() {
    stopPolling();
    destroyCharts();
    prevSample = null;
    tracks = [];
    root = null;
    panelRoot = null;
    starting = false;
  }

  return { mount, unmount, start, stop };
})();
