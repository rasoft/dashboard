const PANEL_DEFS = {
  remote: {
    id: "remote",
    title: "遥控器",
    w: 4,
    h: 8,
    minW: 3,
    minH: 6,
    x: 0,
    y: 0,
  },
  hdmi: {
    id: "hdmi",
    title: "HDMI 输出监测",
    w: 8,
    h: 10,
    minW: 5,
    minH: 7,
    x: 4,
    y: 0,
  },
};

const STORAGE_KEY = "android-board-dashboard-layout-v1";

const Dashboard = (() => {
  let grid = null;
  const openPanels = new Set();

  function cloneTemplate(id) {
    const tpl = document.getElementById(id);
    return tpl.content.cloneNode(true);
  }

  function buildPanelContent(panelId) {
    const shell = cloneTemplate("tpl-panel-shell");
    const panel = shell.querySelector(".panel");
    panel.dataset.panelId = panelId;
    panel.querySelector(".panel-title").textContent = PANEL_DEFS[panelId].title;

    const body = panel.querySelector(".panel-body");
    if (panelId === "remote") {
      body.appendChild(cloneTemplate("tpl-remote"));
    } else if (panelId === "hdmi") {
      body.appendChild(cloneTemplate("tpl-hdmi"));
    }

    panel.querySelector('[data-action="collapse"]').addEventListener("click", (e) => {
      e.stopPropagation();
      panel.classList.toggle("collapsed");
      persist();
    });

    panel.querySelector('[data-action="close"]').addEventListener("click", (e) => {
      e.stopPropagation();
      closePanel(panelId);
    });

    return panel;
  }

  function addPanel(panelId, opts = {}) {
    if (!PANEL_DEFS[panelId] || openPanels.has(panelId)) return;
    const def = PANEL_DEFS[panelId];

    const widget = grid.addWidget({
      id: panelId,
      x: opts.x ?? def.x,
      y: opts.y ?? def.y,
      w: opts.w ?? def.w,
      h: opts.h ?? def.h,
      minW: def.minW,
      minH: def.minH,
    });

    const contentHost = widget.querySelector(".grid-stack-item-content");
    contentHost.innerHTML = "";
    const panelEl = buildPanelContent(panelId);
    contentHost.appendChild(panelEl);

    if (opts.collapsed) panelEl.classList.add("collapsed");

    openPanels.add(panelId);
    if (panelId === "remote" && window.RemotePanel) window.RemotePanel.mount(panelEl);
    if (panelId === "hdmi" && window.HdmiPanel) window.HdmiPanel.mount(panelEl);
    persist();
  }

  function closePanel(panelId) {
    if (panelId === "hdmi" && window.HdmiPanel) {
      window.HdmiPanel.stop().catch(() => {});
    }
    const node = grid.engine.nodes.find((n) => n.id === panelId);
    if (node?.el) grid.removeWidget(node.el);
    openPanels.delete(panelId);
    persist();
  }

  function persist() {
    const layout = grid.save(false).map((item) => {
      const panel = item.el?.querySelector(".panel");
      return {
        id: item.id,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        collapsed: panel?.classList.contains("collapsed") || false,
      };
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ panels: layout }));
  }

  function restore() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch {
      saved = null;
    }

    const panels = saved?.panels?.length
      ? saved.panels
      : [
          { id: "remote", ...PANEL_DEFS.remote },
          { id: "hdmi", ...PANEL_DEFS.hdmi },
        ];

    panels.forEach((p) => {
      if (PANEL_DEFS[p.id]) addPanel(p.id, p);
    });
  }

  async function refreshStatus() {
    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      updatePill("status-adb", data.adb?.available, data.adb?.selected?.serial || "无设备");
      const hdmiName = data.hdmi?.video?.name || data.hdmi?.video?.device || "未检测到采集卡";
      updatePill("status-hdmi", data.hdmi?.available, hdmiName);
    } catch (err) {
      updatePill("status-adb", false, "状态获取失败");
      updatePill("status-hdmi", false, "状态获取失败");
    }
  }

  function updatePill(id, ok, detail) {
    const el = document.getElementById(id);
    if (!el) return;
    el.dataset.state = ok ? "ok" : "bad";
    el.querySelector(".detail").textContent = detail;
  }

  function setupAddMenu() {
    const btn = document.getElementById("btn-add-panel");
    const menu = document.getElementById("add-panel-menu");
    btn.addEventListener("click", () => {
      menu.hidden = !menu.hidden;
    });
    document.addEventListener("click", (e) => {
      if (!btn.contains(e.target) && !menu.contains(e.target)) menu.hidden = true;
    });
    menu.querySelectorAll("button[data-panel]").forEach((b) => {
      b.addEventListener("click", () => {
        addPanel(b.dataset.panel);
        menu.hidden = true;
      });
    });
  }

  function init() {
    grid = GridStack.init({
      cellHeight: 48,
      margin: 8,
      float: true,
      draggable: { handle: ".panel-header" },
      resizable: { handles: "e, se, s, sw, w" },
    });

    grid.on("change", () => persist());
    setupAddMenu();
    document.getElementById("btn-refresh-status").addEventListener("click", refreshStatus);
    restore();
    refreshStatus();
    setInterval(refreshStatus, 8000);
  }

  return { init, addPanel, closePanel, refreshStatus };
})();

document.addEventListener("DOMContentLoaded", () => Dashboard.init());
