window.RemotePanel = (() => {
  async function sendKey(key, feedbackEl) {
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
    }
  }

  function mount(panelEl) {
    const root = panelEl.querySelector(".remote");
    if (!root || root.dataset.bound === "1") return;
    root.dataset.bound = "1";
    const feedback = root.querySelector(".remote-feedback");
    root.querySelectorAll("button[data-key]").forEach((btn) => {
      btn.addEventListener("click", () => sendKey(btn.dataset.key, feedback));
    });
  }

  return { mount };
})();
