window.RemotePanel = (() => {
  let activeRoot = null;
  let feedbackEl = null;
  let sending = false;
  let keyHandler = null;

  const KEYBOARD_MAP = {
    ArrowUp: "DPAD_UP",
    ArrowDown: "DPAD_DOWN",
    ArrowLeft: "DPAD_LEFT",
    ArrowRight: "DPAD_RIGHT",
    Enter: "DPAD_CENTER",
    NumpadEnter: "DPAD_CENTER",
    Backspace: "BACK",
    // Media keys (when the OS/browser exposes them)
    AudioVolumeUp: "VOLUME_UP",
    AudioVolumeDown: "VOLUME_DOWN",
    VolumeUp: "VOLUME_UP",
    VolumeDown: "VOLUME_DOWN",
    PageUp: "VOLUME_UP",
    PageDown: "VOLUME_DOWN",
    // Volume: + / - (main and numpad)
    "+": "VOLUME_UP",
    "=": "VOLUME_UP", // same physical key as + without Shift
    "-": "VOLUME_DOWN",
    "_": "VOLUME_DOWN",
  };

  const CODE_MAP = {
    NumpadAdd: "VOLUME_UP",
    NumpadSubtract: "VOLUME_DOWN",
    Equal: "VOLUME_UP",
    Minus: "VOLUME_DOWN",
  };

  function isTypingTarget(el) {
    if (!el || !(el instanceof Element)) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return el.isContentEditable;
  }

  async function sendKey(key) {
    if (!feedbackEl) return;
    if (sending) return;
    sending = true;
    feedbackEl.textContent = `发送 ${key}…`;
    feedbackEl.classList.remove("error");
    try {
      const res = await fetch("/api/remote/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = await res.json();
      if (!data.ok) {
        feedbackEl.textContent = data.error || "发送失败";
        feedbackEl.classList.add("error");
        return;
      }
      feedbackEl.textContent = `已发送 ${key}`;
    } catch (err) {
      feedbackEl.textContent = String(err);
      feedbackEl.classList.add("error");
    } finally {
      sending = false;
    }
  }

  function onKeyDown(e) {
    if (!activeRoot || !document.body.contains(activeRoot)) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (isTypingTarget(e.target)) return;

    const mapped = KEYBOARD_MAP[e.key] || CODE_MAP[e.code];
    if (!mapped) return;

    e.preventDefault();
    if (e.repeat) return; // avoid key-repeat flooding adb
    sendKey(mapped);
  }

  function bindKeyboard() {
    if (keyHandler) return;
    keyHandler = onKeyDown;
    window.addEventListener("keydown", keyHandler, true);
  }

  function unbindKeyboard() {
    if (!keyHandler) return;
    window.removeEventListener("keydown", keyHandler, true);
    keyHandler = null;
  }

  function mount(panelEl) {
    const root = panelEl.querySelector(".remote");
    if (!root) return;
    feedbackEl = root.querySelector(".remote-feedback");
    activeRoot = root;

    if (root.dataset.bound !== "1") {
      root.dataset.bound = "1";
      root.querySelectorAll("button[data-key]").forEach((btn) => {
        btn.addEventListener("click", () => sendKey(btn.dataset.key));
      });
    }

    bindKeyboard();
  }

  function unmount() {
    activeRoot = null;
    feedbackEl = null;
    unbindKeyboard();
  }

  return { mount, unmount, sendKey };
})();
