window.AdbTextPanel = (() => {
  let root = null;
  let sending = false;

  function els() {
    return {
      input: root.querySelector("#adb-text-input"),
      send: root.querySelector("#adb-text-send"),
      status: root.querySelector("#adb-text-status"),
    };
  }

  function setStatus(text, isError = false) {
    const { status } = els();
    if (!status) return;
    status.textContent = text;
    status.classList.toggle("error", !!isError);
  }

  async function sendText() {
    const { input, send } = els();
    if (!input || sending) return;
    const text = input.value;
    if (!text) {
      setStatus("请输入要发送的文本", true);
      return;
    }

    sending = true;
    if (send) send.disabled = true;
    setStatus("发送中…");
    try {
      const res = await fetch("/api/remote/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatus(data.error || "发送失败", true);
        return;
      }
      setStatus(`已发送：${text.length > 48 ? `${text.slice(0, 45)}…` : text}`);
    } catch (err) {
      setStatus(String(err.message || err), true);
    } finally {
      sending = false;
      if (send) send.disabled = false;
      input?.focus();
    }
  }

  function mount(panelEl) {
    root = panelEl.querySelector(".adb-text");
    if (!root) return;

    if (root.dataset.bound !== "1") {
      root.dataset.bound = "1";
      const { input, send } = els();
      send?.addEventListener("click", () => sendText());
      input?.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          sendText();
        }
      });
    }

    setStatus("输入文本后点发送，或按 Enter");
    els().input?.focus();
  }

  function unmount() {
    root = null;
  }

  return { mount, unmount };
})();
