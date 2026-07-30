window.RemotePanel = (() => {
  let activeRoot = null;
  let feedbackEl = null;
  let sending = false;

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
  }

  function unmount() {
    activeRoot = null;
    feedbackEl = null;
  }

  return { mount, unmount, sendKey };
})();
