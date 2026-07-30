const PANEL_DEFS = {
  "adb-text": {
    id: "adb-text",
    title: "输入",
    w: 5,
    h: 5,
    minW: 3,
    minH: 4,
    x: 0,
    y: 0,
    defaultOpen: false,
  },
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
    defaultOpen: false,
  },
  hdmi: {
    id: "hdmi",
    title: "操作台",
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
    title: "SurfaceFlinger - hwclayers",
    w: 6,
    h: 12,
    minW: 4,
    minH: 8,
    x: 0,
    y: 18,
    defaultOpen: false,
  },
  "hwc-status": {
    id: "hwc-status",
    title: "IComposer - VPU",
    w: 7,
    h: 12,
    minW: 5,
    minH: 8,
    x: 6,
    y: 18,
    defaultOpen: false,
  },
  "sf-events": {
    id: "sf-events",
    title: "SurfaceFlinger - events",
    w: 6,
    h: 10,
    minW: 4,
    minH: 7,
    x: 6,
    y: 18,
    defaultOpen: false,
  },
  "sf-frametimeline": {
    id: "sf-frametimeline",
    title: "SurfaceFlinger - frametimeline",
    w: 8,
    h: 12,
    minW: 5,
    minH: 8,
    x: 0,
    y: 30,
    defaultOpen: false,
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
  let paused = false;
  const pauseListeners = new Set();
  let statusTimer = null;

  function isPaused() {
    return paused;
  }

  function onPauseChange(fn) {
    if (typeof fn !== "function") return () => {};
    pauseListeners.add(fn);
    return () => pauseListeners.delete(fn);
  }

  function setPauseButton() {
    const btn = document.getElementById("btn-pause-toggle");
    if (!btn) return;
    btn.dataset.paused = paused ? "1" : "0";
    btn.textContent = paused ? "继续" : "暂停";
    btn.classList.toggle("btn-ghost", !paused);
  }

  function setPaused(next) {
    const value = !!next;
    if (paused === value) return;
    paused = value;
    setPauseButton();
    pauseListeners.forEach((fn) => {
      try {
        fn(paused);
      } catch (err) {
        console.warn("pause listener", err);
      }
    });
  }

  function togglePaused() {
    setPaused(!paused);
  }

  function isTypingTarget(el) {
    if (!el || !(el instanceof Element)) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return el.isContentEditable;
  }

  function onGlobalKeyDown(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (isTypingTarget(e.target)) return;
    if (e.code !== "Space" && e.key !== " ") return;
    e.preventDefault();
    if (e.repeat) return;
    togglePaused();
  }

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

  function defaultOpenIds() {
    return Object.keys(PANEL_DEFS).filter((id) => PANEL_DEFS[id].defaultOpen !== false);
  }

  function defaultStore() {
    return {
      layouts: {},
      open: defaultOpenIds(),
    };
  }

  function loadStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (raw && typeof raw === "object" && raw.layouts) {
        return {
          layouts: raw.layouts || {},
          open: Array.isArray(raw.open) ? raw.open : defaultOpenIds(),
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
    } else if (panelId === "adb-text") {
      body.appendChild(cloneTemplate("tpl-adb-text"));
    } else if (panelId === "hdmi") {
      body.appendChild(cloneTemplate("tpl-hdmi"));
    } else if (panelId === "ddr") {
      body.appendChild(cloneTemplate("tpl-ddr"));
      const actions = panel.querySelector(".panel-actions");
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.id = "ddr-clear";
      clearBtn.className = "panel-header-btn";
      clearBtn.textContent = "清空曲线";
      clearBtn.title = "清空曲线";
      clearBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
      actions?.insertBefore(clearBtn, actions.firstChild);
    } else if (panelId === "hwc") {
      body.appendChild(cloneTemplate("tpl-hwc"));
    } else if (panelId === "hwc-status") {
      body.appendChild(cloneTemplate("tpl-hwc-status"));
    } else if (panelId === "sf-events") {
      body.appendChild(cloneTemplate("tpl-sf-events"));
      const actions = panel.querySelector(".panel-actions");
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.id = "sf-events-clear";
      clearBtn.className = "panel-header-btn";
      clearBtn.textContent = "清空曲线";
      clearBtn.title = "清空曲线";
      clearBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
      actions?.insertBefore(clearBtn, actions.firstChild);
    } else if (panelId === "sf-frametimeline") {
      body.appendChild(cloneTemplate("tpl-sf-frametimeline"));
    }

    panel.querySelector('[data-action="close"]').addEventListener("click", (e) => {
      e.stopPropagation();
      closePanel(panelId);
    });

    // Click anywhere on the panel (header or body) to raise it above siblings.
    panel.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".panel-actions")) return;
      const item = panel.closest(".grid-stack-item");
      bringToFront(item);
    });

    return panel;
  }

  function addPanel(panelId, opts = {}) {
    if (!PANEL_DEFS[panelId]) return;
    if (openPanels.has(panelId)) {
      const node = grid.engine.nodes.find((n) => n.id === panelId);
      bringToFront(node?.el);
      return;
    }
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
    if (panelId === "adb-text" && window.AdbTextPanel) window.AdbTextPanel.mount(panelEl);
    if (panelId === "hdmi" && window.HdmiPanel) window.HdmiPanel.mount(panelEl);
    if (panelId === "ddr" && window.DdrPanel) window.DdrPanel.mount(panelEl);
    if (panelId === "hwc" && window.HwcPanel) window.HwcPanel.mount(panelEl);
    if (panelId === "hwc-status" && window.HwcStatusPanel) {
      window.HwcStatusPanel.mount(panelEl);
    }
    if (panelId === "sf-events" && window.SfEventsPanel) {
      window.SfEventsPanel.mount(panelEl);
    }
    if (panelId === "sf-frametimeline" && window.SfFrametimelinePanel) {
      window.SfFrametimelinePanel.mount(panelEl);
    }

    const node = grid.engine.nodes.find((n) => n.id === panelId);
    if (node) clampNode(node);
    persist();
  }

  function closePanel(panelId) {
    if (panelId === "hdmi" && window.HdmiPanel) {
      if (window.HdmiPanel.unmount) window.HdmiPanel.unmount();
      else window.HdmiPanel.stop().catch(() => {});
    }
    if (panelId === "remote" && window.RemotePanel?.unmount) {
      window.RemotePanel.unmount();
    }
    if (panelId === "adb-text" && window.AdbTextPanel?.unmount) {
      window.AdbTextPanel.unmount();
    }
    if (panelId === "ddr" && window.DdrPanel?.unmount) {
      window.DdrPanel.unmount();
    }
    if (panelId === "hwc" && window.HwcPanel?.unmount) {
      window.HwcPanel.unmount();
    }
    if (panelId === "hwc-status" && window.HwcStatusPanel?.unmount) {
      window.HwcStatusPanel.unmount();
    }
    if (panelId === "sf-events" && window.SfEventsPanel?.unmount) {
      window.SfEventsPanel.unmount();
    }
    if (panelId === "sf-frametimeline" && window.SfFrametimelinePanel?.unmount) {
      window.SfFrametimelinePanel.unmount();
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
    // If layout was corrupted to an empty open list, fall back to default panels.
    if (!toOpen.length) toOpen = defaultOpenIds();
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
    const buttons = [...menu.querySelectorAll("button[data-panel]")];
    buttons.forEach((b) => {
      const def = PANEL_DEFS[b.dataset.panel];
      if (def?.title) b.textContent = def.title;
    });
    buttons
      .sort((a, b) =>
        a.textContent.trim().localeCompare(b.textContent.trim(), "zh-CN", {
          sensitivity: "base",
          numeric: true,
        })
      )
      .forEach((b) => menu.appendChild(b));

    buttons.forEach((b) => {
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
    const pauseBtn = document.getElementById("btn-pause-toggle");
    if (pauseBtn) {
      pauseBtn.title = "暂停 / 继续（空格）";
      pauseBtn.addEventListener("click", () => togglePaused());
      setPauseButton();
    }
    window.addEventListener("keydown", onGlobalKeyDown, true);
    window.addEventListener("resize", () => {
      // Defer until layout settles so workspace height is non-zero.
      requestAnimationFrame(() => applyWorkspaceBounds());
    });
    restore();
    requestAnimationFrame(() => applyWorkspaceBounds());
    refreshStatus();
    statusTimer = setInterval(() => {
      if (!paused) refreshStatus();
    }, 8000);
  }

  return {
    init,
    addPanel,
    closePanel,
    refreshStatus,
    isPaused,
    setPaused,
    togglePaused,
    onPauseChange,
  };
})();

window.Dashboard = Dashboard;

document.addEventListener("DOMContentLoaded", () => Dashboard.init());
