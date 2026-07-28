const PANEL_DEFS = {
  remote: {
    id: "remote",
    title: "遥控器",
    w: 3,
    h: 18,
    minW: 3,
    minH: 18,
    maxW: 3,
    maxH: 18,
    x: 0,
    y: 0,
    lockedSize: true,
  },
  hdmi: {
    id: "hdmi",
    title: "HDMI 输出监测",
    w: 9,
    h: 14,
    minW: 5,
    minH: 7,
    x: 3,
    y: 0,
  },
};

const STORAGE_KEY = "android-board-dashboard-layout-v2";
const STORAGE_KEY_LEGACY = "android-board-dashboard-layout-v1";

const Dashboard = (() => {
  let grid = null;
  const openPanels = new Set();

  function cloneTemplate(id) {
    const tpl = document.getElementById(id);
    return tpl.content.cloneNode(true);
  }

  function defaultStore() {
    return {
      layouts: {},
      open: Object.keys(PANEL_DEFS),
    };
  }

  function loadStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (raw && typeof raw === "object" && raw.layouts) {
        return {
          layouts: raw.layouts || {},
          open: Array.isArray(raw.open) ? raw.open : Object.keys(PANEL_DEFS),
        };
      }
    } catch {
      /* ignore */
    }

    // Migrate legacy format: { panels: [{id,x,y,w,h}, ...] }
    try {
      const legacy = JSON.parse(localStorage.getItem(STORAGE_KEY_LEGACY) || "null");
      if (legacy?.panels?.length) {
        const layouts = {};
        const open = [];
        legacy.panels.forEach((p) => {
          if (!p?.id || !PANEL_DEFS[p.id]) return;
          layouts[p.id] = { x: p.x, y: p.y, w: p.w, h: p.h };
          open.push(p.id);
        });
        const migrated = { layouts, open };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    } catch {
      /* ignore */
    }

    return defaultStore();
  }

  function saveStore(store) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }

  function geometryFor(panelId, opts = {}) {
    const def = PANEL_DEFS[panelId];
    const saved = loadStore().layouts[panelId] || {};
    // Size-locked panels always use definition size; only position is restored.
    if (def.lockedSize) {
      return {
        x: opts.x ?? saved.x ?? def.x,
        y: opts.y ?? saved.y ?? def.y,
        w: def.w,
        h: def.h,
      };
    }
    return {
      x: opts.x ?? saved.x ?? def.x,
      y: opts.y ?? saved.y ?? def.y,
      w: opts.w ?? saved.w ?? def.w,
      h: opts.h ?? saved.h ?? def.h,
    };
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

    panel.querySelector('[data-action="close"]').addEventListener("click", (e) => {
      e.stopPropagation();
      closePanel(panelId);
    });

    return panel;
  }

  function addPanel(panelId, opts = {}) {
    if (!PANEL_DEFS[panelId] || openPanels.has(panelId)) return;
    const def = PANEL_DEFS[panelId];
    const geo = geometryFor(panelId, opts);

    const widget = grid.addWidget({
      id: panelId,
      x: geo.x,
      y: geo.y,
      w: geo.w,
      h: geo.h,
      minW: def.minW ?? def.w,
      minH: def.minH ?? def.h,
      maxW: def.maxW,
      maxH: def.maxH,
      noResize: !!def.lockedSize,
    });

    const contentHost = widget.querySelector(".grid-stack-item-content");
    contentHost.classList.add(`panel-host-${panelId}`);
    contentHost.innerHTML = "";
    const panelEl = buildPanelContent(panelId);
    contentHost.appendChild(panelEl);

    openPanels.add(panelId);
    if (panelId === "remote" && window.RemotePanel) window.RemotePanel.mount(panelEl);
    if (panelId === "hdmi" && window.HdmiPanel) window.HdmiPanel.mount(panelEl);
    persist();
  }

  function closePanel(panelId) {
    if (panelId === "hdmi" && window.HdmiPanel) {
      window.HdmiPanel.stop().catch(() => {});
    }
    if (panelId === "remote" && window.RemotePanel?.unmount) {
      window.RemotePanel.unmount();
    }

    // Remember last size/position before removing from the grid.
    const node = grid.engine.nodes.find((n) => n.id === panelId);
    if (node) {
      const store = loadStore();
      const def = PANEL_DEFS[panelId];
      store.layouts[panelId] = {
        x: node.x,
        y: node.y,
        w: def?.lockedSize ? def.w : node.w,
        h: def?.lockedSize ? def.h : node.h,
      };
      saveStore(store);
    }

    if (node?.el) grid.removeWidget(node.el);
    openPanels.delete(panelId);
    persist();
  }

  function persist() {
    const store = loadStore();
    grid.save(false).forEach((item) => {
      if (!item?.id) return;
      const def = PANEL_DEFS[item.id];
      store.layouts[item.id] = {
        x: item.x,
        y: item.y,
        w: def?.lockedSize ? def.w : item.w,
        h: def?.lockedSize ? def.h : item.h,
      };
    });
    store.open = [...openPanels];
    saveStore(store);
  }

  function restore() {
    const store = loadStore();
    const toOpen = (store.open || []).filter((id) => PANEL_DEFS[id]);
    const panels = toOpen.length ? toOpen : Object.keys(PANEL_DEFS);
    panels.forEach((id) => addPanel(id));
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
    if (!btn || !menu) return;

    const closeMenu = () => {
      menu.hidden = true;
    };
    const toggleMenu = () => {
      menu.hidden = !menu.hidden;
    };

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu();
    });
    document.addEventListener("click", (e) => {
      if (menu.hidden) return;
      if (btn.contains(e.target) || menu.contains(e.target)) return;
      closeMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMenu();
    });
    menu.querySelectorAll("button[data-panel]").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        addPanel(b.dataset.panel);
        closeMenu();
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
