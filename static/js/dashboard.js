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
  ddr: {
    id: "ddr",
    title: "内存带宽",
    w: 9,
    h: 16,
    minW: 5,
    minH: 10,
    x: 3,
    y: 14,
  },
  hwc: {
    id: "hwc",
    title: "Sf-HWC层",
    w: 6,
    h: 12,
    minW: 4,
    minH: 8,
    x: 0,
    y: 18,
  },
  "sf-events": {
    id: "sf-events",
    title: "Sf-事件",
    w: 6,
    h: 10,
    minW: 4,
    minH: 7,
    x: 6,
    y: 18,
  },
};

const STORAGE_KEY = "android-board-dashboard-layout-v2";
const STORAGE_KEY_LEGACY = "android-board-dashboard-layout-v1";
const CELL_HEIGHT = 48;
const GRID_MARGIN = 8;
/** Minimum cells of a panel that must remain inside the workspace. */
const MIN_VISIBLE_COLS = 1;
const MIN_VISIBLE_ROWS = 1;

const Dashboard = (() => {
  let grid = null;
  const openPanels = new Set();
  let clamping = false;

  function cloneTemplate(id) {
    const tpl = document.getElementById(id);
    return tpl.content.cloneNode(true);
  }

  function availableRows() {
    const workspace = document.querySelector(".workspace");
    const height = workspace?.clientHeight || 0;
    if (height > 40) return Math.max(8, Math.floor(height / CELL_HEIGHT));
    return Math.max(8, Math.floor(Math.max(480, window.innerHeight - 120) / CELL_HEIGHT));
  }

  function clampNode(node) {
    if (!grid || !node?.el) return false;
    const cols = grid.getColumn() || 12;
    const rows = availableRows();
    const def = PANEL_DEFS[node.id];

    let w = Math.max(1, node.w || 1);
    let h = Math.max(1, node.h || 1);
    if (def?.lockedSize) {
      w = def.w;
      h = def.h;
    }
    w = Math.min(w, cols);

    const keepW = Math.min(w, MIN_VISIBLE_COLS);
    const keepH = Math.min(h, MIN_VISIBLE_ROWS);
    // Allow hanging off right/bottom; keep x/y >= 0 so GridStack CSS still works.
    const minX = 0;
    const maxX = Math.max(0, cols - keepW);
    const minY = 0;
    const maxY = Math.max(0, rows - keepH);

    const x = Math.max(minX, Math.min(Number(node.x) || 0, maxX));
    const y = Math.max(minY, Math.min(Number(node.y) || 0, maxY));

    if (x === node.x && y === node.y && w === node.w && h === node.h) return false;
    clamping = true;
    try {
      grid.update(node.el, { x, y, w, h });
    } finally {
      clamping = false;
    }
    return true;
  }

  function clampAllPanels() {
    if (!grid?.engine?.nodes || clamping) return;
    [...grid.engine.nodes].forEach((node) => clampNode(node));
  }

  function installPartialBoundFix() {
    const engine = grid.engine;
    if (!engine || engine._partialBoundFixInstalled) return;
    engine._partialBoundFixInstalled = true;

    engine.nodeBoundFix = function (node, resizing) {
      if (node.maxW) node.w = Math.min(node.w, node.maxW);
      if (node.maxH) node.h = Math.min(node.h, node.maxH);
      if (node.minW && node.minW <= this.column) node.w = Math.max(node.w, node.minW);
      if (node.minH) node.h = Math.max(node.h, node.minH);
      if (node.w > this.column) node.w = this.column;
      if (node.w < 1) node.w = 1;
      if (node.h < 1) node.h = 1;

      // Keep at least one cell inside the visible workspace; allow overhang past right/bottom.
      const cols = this.column || 12;
      const rows = availableRows();
      const keepW = Math.min(node.w, MIN_VISIBLE_COLS);
      const keepH = Math.min(node.h, MIN_VISIBLE_ROWS);
      if (node.x < 0) node.x = 0;
      if (node.y < 0) node.y = 0;
      if (node.x > cols - keepW) node.x = Math.max(0, cols - keepW);
      if (node.y > rows - keepH) node.y = Math.max(0, rows - keepH);
      // Intentionally do NOT force x+w <= cols or y+h <= rows (partial overhang).
      return this;
    };
  }

  function applyWorkspaceBounds() {
    if (!grid) return;
    grid.opts.maxRow = 0;
    if (grid.engine) grid.engine.maxRow = 0;
    installPartialBoundFix();
    clampAllPanels();
  }

  function sanitizeGeometry(panelId, geo) {
    const def = PANEL_DEFS[panelId];
    const cols = 12;
    const rows = availableRows();
    let x = Number(geo.x);
    let y = Number(geo.y);
    let w = Number(geo.w);
    let h = Number(geo.h);
    if (!Number.isFinite(x)) x = def.x;
    if (!Number.isFinite(y)) y = def.y;
    if (!Number.isFinite(w) || w < 1) w = def.w;
    if (!Number.isFinite(h) || h < 1) h = def.h;
    if (def.lockedSize) {
      w = def.w;
      h = def.h;
    }
    w = Math.min(Math.max(1, w), cols);
    h = Math.max(1, h);
    x = Math.max(0, Math.min(x, cols - 1));
    y = Math.max(0, Math.min(y, Math.max(0, rows - 1)));
    return { x, y, w, h };
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
      return sanitizeGeometry(panelId, {
        x: opts.x ?? saved.x ?? def.x,
        y: opts.y ?? saved.y ?? def.y,
        w: def.w,
        h: def.h,
      });
    }
    return sanitizeGeometry(panelId, {
      x: opts.x ?? saved.x ?? def.x,
      y: opts.y ?? saved.y ?? def.y,
      w: opts.w ?? saved.w ?? def.w,
      h: opts.h ?? saved.h ?? def.h,
    });
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
    } else if (panelId === "ddr") {
      body.appendChild(cloneTemplate("tpl-ddr"));
    } else if (panelId === "hwc") {
      body.appendChild(cloneTemplate("tpl-hwc"));
    } else if (panelId === "sf-events") {
      body.appendChild(cloneTemplate("tpl-sf-events"));
    }

    panel.querySelector('[data-action="close"]').addEventListener("click", (e) => {
      e.stopPropagation();
      closePanel(panelId);
    });

    // Click anywhere on the panel (header or body) to raise it above siblings.
    panel.addEventListener("pointerdown", (e) => {
      if (e.target.closest('[data-action="close"]')) return;
      const item = panel.closest(".grid-stack-item");
      bringToFront(item);
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
    if (panelId === "ddr" && window.DdrPanel) window.DdrPanel.mount(panelEl);
    if (panelId === "hwc" && window.HwcPanel) window.HwcPanel.mount(panelEl);
    if (panelId === "sf-events" && window.SfEventsPanel) {
      window.SfEventsPanel.mount(panelEl);
    }

    const node = grid.engine.nodes.find((n) => n.id === panelId);
    if (node) clampNode(node);
    persist();
  }

  function closePanel(panelId) {
    if (panelId === "hdmi" && window.HdmiPanel) {
      window.HdmiPanel.stop().catch(() => {});
    }
    if (panelId === "remote" && window.RemotePanel?.unmount) {
      window.RemotePanel.unmount();
    }
    if (panelId === "ddr" && window.DdrPanel?.unmount) {
      window.DdrPanel.unmount();
    }
    if (panelId === "hwc" && window.HwcPanel?.unmount) {
      window.HwcPanel.unmount();
    }
    if (panelId === "sf-events" && window.SfEventsPanel?.unmount) {
      window.SfEventsPanel.unmount();
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
    let toOpen = (store.open || []).filter((id) => PANEL_DEFS[id]);
    // If layout was corrupted to an empty open list, fall back to all panels.
    if (!toOpen.length) toOpen = Object.keys(PANEL_DEFS);
    toOpen.forEach((id) => addPanel(id));
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

  function bringToFront(el) {
    if (!el) return;
    const host = document.getElementById("dashboard-grid");
    if (!host) return;
    let maxZ = 1;
    host.querySelectorAll(".grid-stack-item").forEach((item) => {
      const z = Number.parseInt(item.style.zIndex || "1", 10);
      if (Number.isFinite(z) && z > maxZ) maxZ = z;
    });
    el.style.zIndex = String(maxZ + 1);
  }

  function init() {
    grid = GridStack.init({
      cellHeight: CELL_HEIGHT,
      margin: GRID_MARGIN,
      float: true,
      // No maxRow: allow partial overhang; we clamp so some cells stay visible.
      draggable: { handle: ".panel-header" },
      resizable: { handles: "e, se, s, sw, w" },
    });

    // GridStack has no first-class overlap option; disable collision resolution.
    if (grid.engine && typeof grid.engine._fixCollisions === "function") {
      grid.engine._fixCollisions = function () {};
    }
    installPartialBoundFix();

    grid.on("change", () => {
      if (clamping) return;
      persist();
    });
    grid.on("dragstop", (_event, el) => {
      const node = el?.gridstackNode;
      if (node) clampNode(node);
      persist();
    });
    grid.on("resizestop", (_event, el) => {
      const node = el?.gridstackNode;
      if (node) clampNode(node);
      persist();
    });
    grid.on("dragstart", (_event, el) => bringToFront(el));
    grid.on("resizestart", (_event, el) => bringToFront(el));
    setupAddMenu();
    document.getElementById("btn-refresh-status").addEventListener("click", refreshStatus);
    window.addEventListener("resize", () => {
      // Defer until layout settles so workspace height is non-zero.
      requestAnimationFrame(() => applyWorkspaceBounds());
    });
    restore();
    requestAnimationFrame(() => applyWorkspaceBounds());
    refreshStatus();
    setInterval(refreshStatus, 8000);
  }

  return { init, addPanel, closePanel, refreshStatus };
})();

document.addEventListener("DOMContentLoaded", () => Dashboard.init());
