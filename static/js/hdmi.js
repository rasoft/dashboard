window.HdmiPanel = (() => {
  let socket = null;
  let pc = null;
  let starting = false;
  let root = null;
  let pendingRemoteIce = [];
  let pendingLocalIce = [];
  let remoteDescriptionSet = false;
  let offerSent = false;
  let statsTimer = null;
  let lastStats = null;

  function els() {
    return {
      resolution: root.querySelector("#hdmi-resolution"),
      audio: root.querySelector("#hdmi-audio"),
      start: root.querySelector("#hdmi-start"),
      stop: root.querySelector("#hdmi-stop"),
      unmute: root.querySelector("#hdmi-unmute"),
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

  function setBandwidthText(text) {
    const { bandwidth } = els();
    if (bandwidth) bandwidth.textContent = text;
  }

  async function refreshEstimateBandwidth() {
    const { resolution, audio } = els();
    if (!resolution) return;
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
      setBandwidthText(`预计 ${data.text || "无法估算"}`);
    } catch (err) {
      setBandwidthText(`带宽估算失败：${err}`);
    }
  }

  function stopStatsMonitor() {
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
    lastStats = null;
  }

  function startStatsMonitor() {
    stopStatsMonitor();
    statsTimer = setInterval(() => {
      updateLiveBandwidth().catch(() => {});
    }, 1000);
    updateLiveBandwidth().catch(() => {});
  }

  async function updateLiveBandwidth() {
    const { resolution } = els();
    if (!pc || ["closed", "failed"].includes(pc.connectionState)) {
      await refreshEstimateBandwidth();
      return;
    }

    try {
      const report = await pc.getStats();
      let videoBytes = 0;
      let audioBytes = 0;
      let framesPerSecond = null;
      let frameWidth = null;
      let frameHeight = null;

      report.forEach((stat) => {
        if (stat.type !== "inbound-rtp") return;
        const kind = stat.kind || stat.mediaType;
        if (kind === "video") {
          videoBytes += stat.bytesReceived || 0;
          if (stat.framesPerSecond != null) framesPerSecond = stat.framesPerSecond;
          if (stat.frameWidth) frameWidth = stat.frameWidth;
          if (stat.frameHeight) frameHeight = stat.frameHeight;
        } else if (kind === "audio") {
          audioBytes += stat.bytesReceived || 0;
        }
      });

      const now = performance.now();
      if (!lastStats) {
        lastStats = { ts: now, videoBytes, audioBytes };
        setBandwidthText("实时带宽测量中…");
        return;
      }

      const dt = (now - lastStats.ts) / 1000;
      if (dt <= 0.2) return;

      const videoMbps = (((videoBytes - lastStats.videoBytes) * 8) / dt) / 1e6;
      const audioKbps = (((audioBytes - lastStats.audioBytes) * 8) / dt) / 1e3;
      const totalMbps = videoMbps + audioKbps / 1000;
      lastStats = { ts: now, videoBytes, audioBytes };

      const resLabel =
        frameWidth && frameHeight ? `${frameWidth}×${frameHeight}` : resolution?.value || "";
      const fpsLabel =
        framesPerSecond != null && Number.isFinite(framesPerSecond)
          ? ` @${Math.round(framesPerSecond)}fps`
          : "";

      setBandwidthText(
        `实时带宽 ${Math.max(0, totalMbps).toFixed(2)} Mbps` +
          `（视频 ${Math.max(0, videoMbps).toFixed(2)} Mbps` +
          ` + 音频 ${Math.max(0, audioKbps).toFixed(0)} kbps）` +
          (resLabel ? ` · ${resLabel}${fpsLabel}` : "")
      );
    } catch (err) {
      setBandwidthText(`实时带宽读取失败：${err}`);
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
        startStatsMonitor();
      }
      if (state === "failed" || state === "closed") {
        cleanupPc();
        setButtons({ running: false });
        setOverlay(state === "closed" ? "已停止" : "连接失败", true);
        refreshEstimateBandwidth();
      }
    });
    socket.on("hdmi:error", (msg) => {
      starting = false;
      setStatus(msg.error || "HDMI 错误");
      setOverlay(msg.error || "错误", true);
      setButtons({ running: false });
      cleanupPc();
      refreshEstimateBandwidth();
    });
    return socket;
  }

  function cleanupPc() {
    stopStatsMonitor();
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
    const { video, unmute } = els();
    if (unmute) unmute.hidden = true;
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

    await refreshEstimateBandwidth();
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
      video.muted = !enableAudio;
      const { unmute } = els();
      if (unmute) unmute.hidden = !enableAudio || !video.muted;
      video
        .play()
        .then(() => {
          if (enableAudio && video.muted) {
            video.muted = false;
            if (unmute) unmute.hidden = true;
          }
        })
        .catch((err) => {
          console.warn("video.play", err);
          video.muted = true;
          video.play().catch(() => {});
          if (unmute && enableAudio) unmute.hidden = false;
          setStatus("浏览器限制自动播放声音，请点击「取消静音」");
        });
      if (ev.track.kind === "video") {
        setOverlay("", false);
        setStatus(enableAudio ? "画面已连接（含音频）" : "画面已连接");
        startStatsMonitor();
      }
      if (ev.track.kind === "audio") {
        setStatus("已收到音频轨道");
      }
    };

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
      if (pc.connectionState === "connected") startStatsMonitor();
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
    await refreshEstimateBandwidth();
  }

  function mount(panelEl) {
    root = panelEl.querySelector(".hdmi");
    if (!root || root.dataset.bound === "1") return;
    root.dataset.bound = "1";

    const { resolution, audio, start: startBtn, stop: stopBtn, unmute } = els();
    resolution.addEventListener("change", () => {
      if (!pc) refreshEstimateBandwidth();
    });
    audio.addEventListener("change", () => {
      if (!pc) refreshEstimateBandwidth();
    });
    startBtn.addEventListener("click", () => start());
    stopBtn.addEventListener("click", () => stop());
    if (unmute) {
      unmute.addEventListener("click", () => {
        const { video } = els();
        if (!video) return;
        video.muted = false;
        video.play().catch(() => {});
        unmute.hidden = true;
        setStatus("已取消静音");
      });
    }
    refreshEstimateBandwidth();
    ensureSocket();
    start().catch((err) => console.warn("auto start hdmi", err));
  }

  return { mount, start, stop };
})();
