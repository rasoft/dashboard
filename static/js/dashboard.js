const PANEL_DEFS = {
  "adb-text": {
    id: "adb-text",
    title: "输入",
    w: 5,
    h: 5,
    minW: 4,
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
    minW: 4,
    minH: 7,
    x: 3,
    y: 0,
  },
  "hdmi-delay": {
    id: "hdmi-delay",
    title: "录制回放",
    w: 9,
    h: 14,
    minW: 4,
    minH: 7,
    x: 12,
    y: 0,
    defaultOpen: false,
  },
  ddr: {
    id: "ddr",
    title: "内存带宽 - 吞吐量",
    w: 9,
    h: 16,
    minW: 4,
    minH: 10,
    x: 3,
    y: 14,
  },
  "ddr-eff": {
    id: "ddr-eff",
    title: "内存带宽 - 效率",
    w: 9,
    h: 16,
    minW: 4,
    minH: 10,
    x: 3,
    y: 14,
    defaultOpen: false,
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
    minW: 4,
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
    minW: 4,
    minH: 8,
    x: 0,
    y: 30,
    defaultOpen: false,
  },
  "proc-meminfo": {
    id: "proc-meminfo",
    title: "proc - meminfo",
    w: 7,
    h: 10,
    minW: 4,
    minH: 7,
    x: 0,
    y: 18,
    defaultOpen: false,
  },
  "proc-diskstats": {
    id: "proc-diskstats",
    title: "proc - diskstats",
    w: 9,
    h: 12,
    minW: 4,
    minH: 8,
    x: 0,
    y: 18,
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
  let printing = false;
  let restoring = false;
  let suppressPersist = false;
  const pauseListeners = new Set();
  let statusTimer = null;
  let savedGridHeight = null;
  let savedStageStyles = null;
  const PRINT_STAGE_H = 560;
  /** panelId -> geometry/constraints to restore after leaving fullscreen */
  const fullscreenRestore = new Map();

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
    if (e.key === "Escape" && fullscreenRestore.size) {
      e.preventDefault();
      if (e.repeat) return;
      const ids = [...fullscreenRestore.keys()];
      exitFullscreen(ids[ids.length - 1]);
      return;
    }
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

    engine.nodeBoundFix = function (node) {
      if (node.maxW) node.w = Math.min(node.w, node.maxW);
      if (node.maxH) node.h = Math.min(node.h, node.maxH);
      if (node.minW && node.minW <= this.column) node.w = Math.max(node.w, node.minW);
      if (node.minH) node.h = Math.max(node.h, node.minH);
      if (node.w > this.column) node.w = this.column;
      if (node.w < 1) node.w = 1;
      if (node.h < 1) node.h = 1;

      // Only pin to the top-left; never pull panels upward/left based on the
      // current viewport. Clamping to availableRows() here runs on addWidget
      // during restore and permanently overwrites saved layouts via persist().
      if (node.x < 0) node.x = 0;
      if (node.y < 0) node.y = 0;
      return this;
    };
  }

  /**
   * Dashboard panels are allowed to overlap. GridStack still rejects a drag when
   * the drop cell intersects another widget and directionCollideCoverage finds
   * no clear push target — the item then snaps back on mouseup. Neutralize
   * collision checks so free placement works.
   */
  function installOverlapFix() {
    const engine = grid.engine;
    if (!engine || engine._overlapFixInstalled) return;
    engine._overlapFixInstalled = true;
    engine.collide = function () {
      return undefined;
    };
    engine.collideAll = function () {
      return [];
    };
    engine._fixCollisions = function () {
      return false;
    };
  }

  function applyWorkspaceBounds() {
    if (!grid) return;
    grid.opts.maxRow = 0;
    if (grid.engine) grid.engine.maxRow = 0;
    installPartialBoundFix();
    installOverlapFix();
    syncFullscreenPanels();
    // Do not clampAllPanels() here — window resize / init must not rewrite
    // saved positions into localStorage.
  }

  function workspaceGridSize() {
    return {
      cols: grid?.getColumn?.() || 12,
      rows: availableRows(),
    };
  }

  function layoutForPersist(node) {
    const def = PANEL_DEFS[node.id];
    const saved = fullscreenRestore.get(node.id);
    if (saved) {
      return {
        x: Number(saved.x) || 0,
        y: Number(saved.y) || 0,
        w: def?.lockedSize ? def.w : Math.max(1, Number(saved.w) || def?.w || 1),
        h: def?.lockedSize ? def.h : Math.max(1, Number(saved.h) || def?.h || 1),
      };
    }
    return {
      x: Number(node.x) || 0,
      y: Number(node.y) || 0,
      w: def?.lockedSize ? def.w : Math.max(1, Number(node.w) || def?.w || 1),
      h: def?.lockedSize ? def.h : Math.max(1, Number(node.h) || def?.h || 1),
    };
  }

  function setFullscreenButton(panel, on) {
    const btn = panel?.querySelector('[data-action="fullscreen"]');
    if (!btn) return;
    btn.dataset.fullscreen = on ? "1" : "0";
    btn.title = on ? "退出全屏（Esc）" : "全屏";
    btn.setAttribute("aria-label", btn.title);
    btn.textContent = on ? "❐" : "⛶";
  }

  function notifyPanelResize() {
    // Prefer dashboard:redraw — a window "resize" would let GridStack rewrite geometry.
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent("dashboard:redraw"));
    });
  }

  function syncFullscreenPanels() {
    if (!grid || !fullscreenRestore.size) return;
    const { cols, rows } = workspaceGridSize();
    let changed = false;
    fullscreenRestore.forEach((_saved, panelId) => {
      const node = grid.engine.nodes.find((n) => n.id === panelId);
      if (!node?.el) return;
      if (node.x === 0 && node.y === 0 && node.w === cols && node.h === rows) return;
      clamping = true;
      try {
        grid.update(node.el, { x: 0, y: 0, w: cols, h: rows });
        changed = true;
      } finally {
        clamping = false;
      }
    });
    if (changed) notifyPanelResize();
  }

  function enterFullscreen(panelId) {
    if (!grid || !PANEL_DEFS[panelId] || fullscreenRestore.has(panelId)) return;
    // Only one panel fills the workspace at a time.
    [...fullscreenRestore.keys()].forEach((id) => {
      if (id !== panelId) exitFullscreen(id);
    });

    const node = grid.engine.nodes.find((n) => n.id === panelId);
    if (!node?.el) return;

    fullscreenRestore.set(panelId, {
      x: Number(node.x) || 0,
      y: Number(node.y) || 0,
      w: Math.max(1, Number(node.w) || 1),
      h: Math.max(1, Number(node.h) || 1),
      maxW: node.maxW,
      maxH: node.maxH,
      noResize: !!node.noResize,
      noMove: !!node.noMove,
    });

    const { cols, rows } = workspaceGridSize();
    node.maxW = undefined;
    node.maxH = undefined;
    node.noResize = true;
    node.noMove = true;

    clamping = true;
    try {
      grid.update(node.el, {
        x: 0,
        y: 0,
        w: cols,
        h: Math.max(rows, 8),
        noResize: true,
        noMove: true,
      });
    } finally {
      clamping = false;
    }

    bringToFront(node.el);
    const panel = node.el.querySelector(".panel");
    panel?.classList.add("is-fullscreen");
    setFullscreenButton(panel, true);
    notifyPanelResize();
  }

  function exitFullscreen(panelId) {
    const saved = fullscreenRestore.get(panelId);
    if (!saved) return;

    const node = grid.engine.nodes.find((n) => n.id === panelId);
    fullscreenRestore.delete(panelId);
    if (!node?.el) return;

    const def = PANEL_DEFS[panelId];
    const w = def?.lockedSize ? def.w : saved.w;
    const h = def?.lockedSize ? def.h : saved.h;
    node.maxW = def?.maxW ?? saved.maxW;
    node.maxH = def?.maxH ?? saved.maxH;
    node.noResize = def?.lockedSize ? true : !!saved.noResize;
    node.noMove = !!saved.noMove;

    clamping = true;
    try {
      grid.update(node.el, {
        x: saved.x,
        y: saved.y,
        w,
        h,
        maxW: node.maxW,
        maxH: node.maxH,
        noResize: node.noResize,
        noMove: node.noMove,
      });
    } finally {
      clamping = false;
    }

    const panel = node.el.querySelector(".panel");
    panel?.classList.remove("is-fullscreen");
    setFullscreenButton(panel, false);
    notifyPanelResize();
  }

  function toggleFullscreen(panelId) {
    if (fullscreenRestore.has(panelId)) exitFullscreen(panelId);
    else enterFullscreen(panelId);
  }

  function sanitizeGeometry(panelId, geo) {
    const def = PANEL_DEFS[panelId];
    const cols = 12;
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
    // Do not clamp Y to the current viewport height here — that would crush
    // saved layouts on load when availableRows() is still small, then persist
    // the damaged positions. Drag/resize clamping handles on-screen visibility.
    x = Math.max(0, Math.min(x, cols - 1));
    y = Math.max(0, y);
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
    } else if (panelId === "hdmi-delay") {
      body.appendChild(cloneTemplate("tpl-hdmi-delay"));
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
    } else if (panelId === "ddr-eff") {
      body.appendChild(cloneTemplate("tpl-ddr-eff"));
      const actions = panel.querySelector(".panel-actions");
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.id = "ddr-eff-clear";
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
    } else if (panelId === "proc-meminfo") {
      body.appendChild(cloneTemplate("tpl-meminfo"));
      const actions = panel.querySelector(".panel-actions");
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.id = "meminfo-clear";
      clearBtn.className = "panel-header-btn";
      clearBtn.textContent = "清空曲线";
      clearBtn.title = "清空曲线";
      clearBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
      actions?.insertBefore(clearBtn, actions.firstChild);
    } else if (panelId === "proc-diskstats") {
      body.appendChild(cloneTemplate("tpl-diskstats"));
      const actions = panel.querySelector(".panel-actions");
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.id = "diskstats-clear";
      clearBtn.className = "panel-header-btn";
      clearBtn.textContent = "清空曲线";
      clearBtn.title = "清空曲线";
      clearBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
      actions?.insertBefore(clearBtn, actions.firstChild);
    }

    panel.querySelector('[data-action="close"]').addEventListener("click", (e) => {
      e.stopPropagation();
      closePanel(panelId);
    });
    panel.querySelector('[data-action="fullscreen"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFullscreen(panelId);
    });
    panel.querySelector('[data-action="fullscreen"]')?.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
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

    // Re-assert geometry after prepareNode/nodeBoundFix so restored sizes stick.
    if (widget && (geo.w !== widget.gridstackNode?.w || geo.h !== widget.gridstackNode?.h
        || geo.x !== widget.gridstackNode?.x || geo.y !== widget.gridstackNode?.y)) {
      clamping = true;
      try {
        grid.update(widget, { x: geo.x, y: geo.y, w: geo.w, h: geo.h });
      } finally {
        clamping = false;
      }
    }

    const contentHost = widget.querySelector(".grid-stack-item-content");
    contentHost.classList.add(`panel-host-${panelId}`);
    contentHost.innerHTML = "";
    const panelEl = buildPanelContent(panelId);
    contentHost.appendChild(panelEl);

    openPanels.add(panelId);
    if (panelId === "remote" && window.RemotePanel) window.RemotePanel.mount(panelEl);
    if (panelId === "adb-text" && window.AdbTextPanel) window.AdbTextPanel.mount(panelEl);
    if (panelId === "hdmi" && window.HdmiPanel) window.HdmiPanel.mount(panelEl);
    if (panelId === "hdmi-delay" && window.HdmiDelayPanel) {
      window.HdmiDelayPanel.mount(panelEl);
    }
    if (panelId === "ddr" && window.DdrPanel) window.DdrPanel.mount(panelEl);
    if (panelId === "ddr-eff" && window.DdrEffPanel) window.DdrEffPanel.mount(panelEl);
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
    if (panelId === "proc-meminfo" && window.MeminfoPanel) {
      window.MeminfoPanel.mount(panelEl);
    }
    if (panelId === "proc-diskstats" && window.DiskstatsPanel) {
      window.DiskstatsPanel.mount(panelEl);
    }

    const node = grid.engine.nodes.find((n) => n.id === panelId);
    if (node && !restoring) clampNode(node);
    if (!restoring) persist();
  }

  function closePanel(panelId) {
    if (panelId === "hdmi" && window.HdmiPanel) {
      if (window.HdmiPanel.unmount) window.HdmiPanel.unmount();
      else window.HdmiPanel.stop().catch(() => {});
    }
    if (panelId === "hdmi-delay" && window.HdmiDelayPanel?.unmount) {
      window.HdmiDelayPanel.unmount();
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
    if (panelId === "ddr-eff" && window.DdrEffPanel?.unmount) {
      window.DdrEffPanel.unmount();
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
    if (panelId === "proc-meminfo" && window.MeminfoPanel?.unmount) {
      window.MeminfoPanel.unmount();
    }
    if (panelId === "proc-diskstats" && window.DiskstatsPanel?.unmount) {
      window.DiskstatsPanel.unmount();
    }

    // Remember last size/position before removing from the grid.
    const node = grid.engine.nodes.find((n) => n.id === panelId);
    if (node) {
      const store = loadStore();
      store.layouts[panelId] = layoutForPersist(node);
      saveStore(store);
    }

    fullscreenRestore.delete(panelId);

    if (node?.el) grid.removeWidget(node.el);
    openPanels.delete(panelId);
    persist();
  }

  function persist() {
    if (printing || restoring || suppressPersist || clamping) return;
    const store = loadStore();
    // Read from engine.nodes directly. grid.save() strips `w`/`h` when they
    // equal minW/minH (GridStack removeInternalForSave), which made refresh
    // fall back to PANEL_DEFS default sizes.
    (grid.engine?.nodes || []).forEach((node) => {
      if (!node?.id) return;
      store.layouts[node.id] = layoutForPersist(node);
    });
    store.open = [...openPanels];
    saveStore(store);
  }

  function restore() {
    restoring = true;
    try {
      const store = loadStore();
      let toOpen = (store.open || []).filter((id) => PANEL_DEFS[id]);
      // If layout was corrupted to an empty open list, fall back to default panels.
      if (!toOpen.length) toOpen = defaultOpenIds();
      toOpen.forEach((id) => addPanel(id));
    } finally {
      restoring = false;
    }
    persist();
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

  function redrawPrintCanvases() {
    // Do NOT dispatch window "resize": GridStack listens to it and may rewrite
    // panel geometry, which would then get persisted over the user's layout.
    window.dispatchEvent(new CustomEvent("dashboard:redraw"));
  }

  function forcePrintStageSize() {
    const stages = document.querySelectorAll(".hwc-stage, .hwc-st-stage");
    savedStageStyles = [];
    stages.forEach((el) => {
      savedStageStyles.push({
        el,
        height: el.style.height,
        minHeight: el.style.minHeight,
        maxHeight: el.style.maxHeight,
      });
      el.style.height = `${PRINT_STAGE_H}px`;
      el.style.minHeight = `${PRINT_STAGE_H}px`;
      el.style.maxHeight = "none";
    });
  }

  function restorePrintStageSize() {
    if (!savedStageStyles) return;
    savedStageStyles.forEach(({ el, height, minHeight, maxHeight }) => {
      el.style.height = height || "";
      el.style.minHeight = minHeight || "";
      el.style.maxHeight = maxHeight || "";
    });
    savedStageStyles = null;
  }

  function preparePrintLayout() {
    if (printing) {
      // Already expanded (e.g. matchMedia + beforeprint both fired); still redraw.
      redrawPrintCanvases();
      return;
    }
    printing = true;
    document.body.classList.add("is-printing");
    const host = document.getElementById("dashboard-grid");
    if (host) {
      savedGridHeight = {
        height: host.style.height,
        maxHeight: host.style.maxHeight,
        minHeight: host.style.minHeight,
      };
      host.style.height = "auto";
      host.style.maxHeight = "none";
      host.style.minHeight = "0";
    }
    // Inline stage size so canvas clientHeight is correct even before print CSS settles.
    forcePrintStageSize();
    // Force layout so stages have final print width before canvas measure/redraw.
    void document.body.offsetHeight;
    // beforeprint must redraw synchronously; rAF often misses the print snapshot.
    redrawPrintCanvases();
    requestAnimationFrame(() => redrawPrintCanvases());
  }

  function restoreAfterPrint() {
    if (!printing) return;
    printing = false;
    document.body.classList.remove("is-printing");
    restorePrintStageSize();
    const host = document.getElementById("dashboard-grid");
    if (host && savedGridHeight) {
      host.style.height = savedGridHeight.height || "";
      host.style.maxHeight = savedGridHeight.maxHeight || "";
      host.style.minHeight = savedGridHeight.minHeight || "";
      savedGridHeight = null;
    }
    // Restore screen layout without writing print-time geometry to localStorage.
    suppressPersist = true;
    try {
      applyWorkspaceBounds();
    } finally {
      suppressPersist = false;
    }
    requestAnimationFrame(() => redrawPrintCanvases());
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

    // GridStack has no first-class overlap option; disable collision checks so
    // panels can stack freely without snapping back on drop.
    installOverlapFix();
    installPartialBoundFix();

    grid.on("change", () => {
      if (clamping || printing || restoring || suppressPersist) return;
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
      if (printing) return;
      // Defer until layout settles so workspace height is non-zero.
      requestAnimationFrame(() => applyWorkspaceBounds());
    });
    window.addEventListener("beforeprint", preparePrintLayout);
    window.addEventListener("afterprint", restoreAfterPrint);
    // Chrome sometimes applies print media before beforeprint; keep layout in sync.
    if (typeof window.matchMedia === "function") {
      const mql = window.matchMedia("print");
      const onPrintMql = (e) => {
        if (e.matches) preparePrintLayout();
        else restoreAfterPrint();
      };
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", onPrintMql);
      } else if (typeof mql.addListener === "function") {
        mql.addListener(onPrintMql);
      }
    }
    restore();
    // Install bound/overlap fixes without clamping — early availableRows() can be
    // too small and would crush saved Y positions, then persist them permanently.
    requestAnimationFrame(() => {
      if (!grid) return;
      grid.opts.maxRow = 0;
      if (grid.engine) grid.engine.maxRow = 0;
      installPartialBoundFix();
      installOverlapFix();
    });
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
