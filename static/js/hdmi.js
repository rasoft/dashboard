window.HdmiPanel = (() => {
  let socket = null;
  let pc = null;
  let starting = false;
  let root = null;
  let pendingRemoteIce = [];
  let pendingLocalIce = [];
  let remoteDescriptionSet = false;
  let offerSent = false;

  function els() {
    return {
      resolution: root.querySelector("#hdmi-resolution"),
      audio: root.querySelector("#hdmi-audio"),
      start: root.querySelector("#hdmi-start"),
      stop: root.querySelector("#hdmi-stop"),
      bandwidth: root.querySelector("#hdmi-bandwidth"),
      video: root.querySelector("#hdmi-video"),
      overlay: root.querySelector("#hdmi-overlay"),
      status: root.querySelector("#hdmi-status"),
    };
  }

  function setStatus(text) {
    const { status } = els();
    if (status) status.textContent = text;
  }

  function setOverlay(text, show) {
    const { overlay } = els();
    if (!overlay) return;
    overlay.textContent = text;
    overlay.classList.toggle("hidden", !show);
  }

  function setButtons({ running }) {
    const { start, stop } = els();
    if (start) start.disabled = running;
    if (stop) stop.disabled = !running;
  }

  async function refreshBandwidth() {
    const { resolution, audio, bandwidth } = els();
    if (!resolution || !bandwidth) return;
    const [width, height] = resolution.value.split("x").map(Number);
    const params = new URLSearchParams({
      width: String(width),
      height: String(height),
      fps: "30",
      audio: audio.checked ? "1" : "0",
    });
    try {
      const res = await fetch(`/api/hdmi/bandwidth?${params}`);
      const data = await res.json();
      bandwidth.textContent = data.text || "无法估算带宽";
    } catch (err) {
      bandwidth.textContent = `带宽估算失败：${err}`;
    }
  }

  function waitConnected(sock, timeoutMs = 8000) {
    if (sock.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Socket.IO 连接超时"));
      }, timeoutMs);
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const cleanup = () => {
        clearTimeout(timer);
        sock.off("connect", onConnect);
        sock.off("connect_error", onError);
      };
      sock.on("connect", onConnect);
      sock.on("connect_error", onError);
    });
  }

  function flushLocalIce(sock) {
    if (!offerSent) return;
    for (const msg of pendingLocalIce) {
      sock.emit("hdmi:ice", msg);
    }
    pendingLocalIce = [];
  }

  async function applyRemoteIce(msg) {
    if (!pc || !msg?.candidate) return;
    const candidate = new RTCIceCandidate({
      candidate: msg.candidate,
      sdpMid: msg.sdpMid,
      sdpMLineIndex: msg.sdpMLineIndex,
    });
    if (!remoteDescriptionSet) {
      pendingRemoteIce.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn("addIceCandidate", err);
    }
  }

  function ensureSocket() {
    if (socket) return socket;
    socket = io({
      transports: ["websocket", "polling"],
      reconnection: true,
    });
    socket.on("connect", () => setStatus(`信令已连接 (${socket.id})`));
    socket.on("disconnect", () => setStatus("信令断开"));
    socket.on("hdmi:answer", async (msg) => {
      try {
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(msg));
        remoteDescriptionSet = true;
        for (const c of pendingRemoteIce) {
          try {
            await pc.addIceCandidate(c);
          } catch (err) {
            console.warn("flush ice", err);
          }
        }
        pendingRemoteIce = [];
        setStatus("已收到 Answer，正在连接…");
      } catch (err) {
        setStatus(`设置远端描述失败：${err}`);
        setOverlay("连接失败", true);
        setButtons({ running: false });
      }
    });
    socket.on("hdmi:ice", (msg) => {
      applyRemoteIce(msg);
    });
    socket.on("hdmi:ice-nack", (msg) => {
      console.warn("ICE nack", msg);
    });
    socket.on("hdmi:state", (msg) => {
      const state = msg.state || "unknown";
      setStatus(`连接状态：${state}`);
      if (state === "connected") {
        setOverlay("", false);
        setButtons({ running: true });
      }
      if (state === "failed" || state === "closed") {
        cleanupPc();
        setButtons({ running: false });
        setOverlay(state === "closed" ? "已停止" : "连接失败", true);
      }
    });
    socket.on("hdmi:error", (msg) => {
      starting = false;
      setStatus(msg.error || "HDMI 错误");
      setOverlay(msg.error || "错误", true);
      setButtons({ running: false });
      cleanupPc();
    });
    return socket;
  }

  function cleanupPc() {
    remoteDescriptionSet = false;
    offerSent = false;
    pendingRemoteIce = [];
    pendingLocalIce = [];
    if (pc) {
      try {
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        pc.close();
      } catch {
        /* ignore */
      }
      pc = null;
    }
    const { video } = els();
    if (video) {
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      video.srcObject = null;
    }
  }

  async function start() {
    if (starting) return;
    starting = true;
    const { resolution, audio, video } = els();
    setButtons({ running: true });

    await refreshBandwidth();
    const [width, height] = resolution.value.split("x").map(Number);
    const enableAudio = audio.checked;

    setOverlay("正在建立 WebRTC…", true);
    setStatus("连接信令…");

    cleanupPc();
    const sock = ensureSocket();

    try {
      await waitConnected(sock);
    } catch (err) {
      setStatus(`信令连接失败：${err}`);
      setOverlay("信令连接失败", true);
      setButtons({ running: false });
      starting = false;
      return;
    }

    pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.addTransceiver("video", { direction: "recvonly" });
    if (enableAudio) {
      pc.addTransceiver("audio", { direction: "recvonly" });
    }

    pc.ontrack = (ev) => {
      if (!video.srcObject) {
        video.srcObject = new MediaStream();
      }
      video.srcObject.addTrack(ev.track);
      video.muted = true;
      video
        .play()
        .then(() => {
          if (enableAudio) video.muted = false;
        })
        .catch((err) => console.warn("video.play", err));
      if (ev.track.kind === "video") {
        setOverlay("", false);
        setStatus("画面已连接");
      }
    };

    // Buffer local ICE until offer is sent, so the server always has a session/reservation.
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const msg = {
        candidate: ev.candidate.candidate,
        sdpMid: ev.candidate.sdpMid,
        sdpMLineIndex: ev.candidate.sdpMLineIndex,
      };
      if (!offerSent) {
        pendingLocalIce.push(msg);
        return;
      }
      sock.emit("hdmi:ice", msg);
    };

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      setStatus(`连接状态：${pc.connectionState}`);
    };

    pc.oniceconnectionstatechange = () => {
      if (!pc) return;
      setStatus(`ICE：${pc.iceConnectionState} / PC：${pc.connectionState}`);
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sock.emit("hdmi:offer", {
        sdp: offer.sdp,
        type: offer.type,
        width,
        height,
        fps: 30,
        audio: enableAudio,
      });
      offerSent = true;
      flushLocalIce(sock);
      setStatus("已发送 Offer，等待 Answer…");
    } catch (err) {
      setStatus(`启动失败：${err}`);
      setOverlay("启动失败", true);
      setButtons({ running: false });
      cleanupPc();
    } finally {
      starting = false;
    }
  }

  async function stop() {
    const sock = ensureSocket();
    if (sock.connected) sock.emit("hdmi:stop", {});
    cleanupPc();
    setButtons({ running: false });
    setOverlay("已停止", true);
    setStatus("已停止监测");
  }

  function mount(panelEl) {
    root = panelEl.querySelector(".hdmi");
    if (!root || root.dataset.bound === "1") return;
    root.dataset.bound = "1";

    const { resolution, audio, start: startBtn, stop: stopBtn } = els();
    resolution.addEventListener("change", refreshBandwidth);
    audio.addEventListener("change", refreshBandwidth);
    startBtn.addEventListener("click", () => start());
    stopBtn.addEventListener("click", () => stop());
    refreshBandwidth();
    ensureSocket();
  }

  return { mount, start, stop };
})();
