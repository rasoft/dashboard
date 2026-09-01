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
  let unmuteTimer = null;
  let unmuteGestureHandler = null;
  let keyHandler = null;
  let keySending = false;
  let pauseUnsub = null;
  let delayUnsub = null;
  let mediaPausedByDashboard = false;

  const KEYBOARD_MAP = {
    ArrowUp: "DPAD_UP",
    ArrowDown: "DPAD_DOWN",
    ArrowLeft: "DPAD_LEFT",
    ArrowRight: "DPAD_RIGHT",
    Enter: "DPAD_CENTER",
    NumpadEnter: "DPAD_CENTER",
    Backspace: "BACK",
    AudioVolumeUp: "VOLUME_UP",
    AudioVolumeDown: "VOLUME_DOWN",
    VolumeUp: "VOLUME_UP",
    VolumeDown: "VOLUME_DOWN",
    PageUp: "VOLUME_UP",
    PageDown: "VOLUME_DOWN",
    "+": "VOLUME_UP",
    "=": "VOLUME_UP",
    "-": "VOLUME_DOWN",
    _: "VOLUME_DOWN",
    p: "POWER",
    P: "POWER",
    b: "BOOKMARK",
    B: "BOOKMARK",
    a: "ASSISTANT",
    A: "ASSISTANT",
    s: "SETTINGS",
    S: "SETTINGS",
    h: "HOME",
    H: "HOME",
    m: "MUTE",
    M: "MUTE",
  };

  const CODE_MAP = {
    NumpadAdd: "VOLUME_UP",
    NumpadSubtract: "VOLUME_DOWN",
    Equal: "VOLUME_UP",
    Minus: "VOLUME_DOWN",
  };

  function els() {
    return {
      resolution: root.querySelector("#hdmi-resolution"),
      audio: root.querySelector("#hdmi-audio"),
      toggle: root.querySelector("#hdmi-toggle"),
      delayToggle: root.querySelector("#hdmi-delay-rec"),
      delayMeta: root.querySelector("#hdmi-delay-rec-meta"),
      unmute: root.querySelector("#hdmi-unmute"),
      bandwidth: root.querySelector("#hdmi-bandwidth"),
      video: root.querySelector("#hdmi-video"),
      overlay: root.querySelector("#hdmi-overlay"),
      recBadge: root.querySelector("#hdmi-rec-badge"),
      recBadgeText: root.querySelector("#hdmi-rec-badge-text"),
      status: root.querySelector("#hdmi-status"),
      keyFeedback: root.querySelector("#hdmi-key-feedback"),
    };
  }

  function setKeyFeedback(text, isError = false) {
    const { keyFeedback } = els();
    if (!keyFeedback) return;
    keyFeedback.textContent = text;
    keyFeedback.classList.toggle("error", !!isError);
  }

  function isTypingTarget(el) {
    if (!el || !(el instanceof Element)) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return el.isContentEditable;
  }

  async function sendAdbKey(key) {
    if (!root || !document.body.contains(root)) return;
    if (keySending) return;
    keySending = true;
    setKeyFeedback(`发送 ${key}…`, false);
    try {
      const res = await fetch("/api/remote/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = await res.json();
      if (!data.ok) {
        setKeyFeedback(data.error || "发送失败", true);
        return;
      }
      setKeyFeedback(`已发送 ${key}`);
    } catch (err) {
      setKeyFeedback(String(err.message || err), true);
    } finally {
      keySending = false;
    }
  }

  const REPEATABLE_KEYS = new Set([
    "DPAD_UP",
    "DPAD_DOWN",
    "DPAD_LEFT",
    "DPAD_RIGHT",
    "VOLUME_UP",
    "VOLUME_DOWN",
  ]);

  function onAdbKeyDown(e) {
    if (!root || !document.body.contains(root)) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (isTypingTarget(e.target)) return;

    const mapped = KEYBOARD_MAP[e.key] || CODE_MAP[e.code];
    if (!mapped) return;

    e.preventDefault();
    // Allow OS key-repeat only for D-pad and volume.
    if (e.repeat && !REPEATABLE_KEYS.has(mapped)) return;
    sendAdbKey(mapped);
  }

  function bindKeyboard() {
    if (keyHandler) return;
    keyHandler = onAdbKeyDown;
    window.addEventListener("keydown", keyHandler, true);
  }

  function unbindKeyboard() {
    if (!keyHandler) return;
    window.removeEventListener("keydown", keyHandler, true);
    keyHandler = null;
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

  function formatDelaySec(ms) {
    return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  }

  function syncDelayUi(state) {
    if (!root) return;
    const rec = state || window.HdmiDelayRecord?.getState?.() || {};
    const { delayToggle, delayMeta, recBadge, recBadgeText, toggle } = els();
    const running = toggle?.dataset.running === "1";
    if (delayToggle) {
      delayToggle.disabled = !rec.recording && !running;
      delayToggle.dataset.recording = rec.recording ? "1" : "0";
      delayToggle.textContent = rec.recording ? "停止录制" : "延时录制";
      delayToggle.classList.toggle("btn-ghost", !rec.recording);
    }
    if (delayMeta) {
      if (rec.recording) {
        delayMeta.textContent = `${formatDelaySec(rec.bufferMs)} / 30.0s · ${rec.frameCount} 帧`;
      } else if (rec.hasClip) {
        delayMeta.textContent = `已保存 ${rec.frameCount} 帧 · ${formatDelaySec(rec.bufferMs)}`;
      } else {
        delayMeta.textContent = running ? "未录制" : "先开始采集";
      }
    }
    if (recBadge) recBadge.hidden = !rec.recording;
    if (recBadgeText) recBadgeText.textContent = `REC ${formatDelaySec(rec.bufferMs)}`;
  }

  function onDelayRecClick() {
    const rec = window.HdmiDelayRecord;
    if (!rec) return;
    if (rec.isRecording()) {
      rec.stop();
      setStatus("已停止延时录制，可在录制回放面板查看");
      return;
    }
    const result = rec.start();
    if (!result.ok) {
      setStatus(result.error || "无法开始录制");
      return;
    }
    setStatus("延时录制中（保留最近 30 秒）");
  }

  function setButtons({ running }) {
    const { toggle } = els();
    if (!toggle) return;
    toggle.dataset.running = running ? "1" : "0";
    toggle.textContent = running ? "停止" : "开始";
    toggle.classList.toggle("btn-ghost", !!running);
    toggle.disabled = false;
    syncDelayUi();
  }

  async function onToggleClick() {
    const { toggle } = els();
    if (!toggle) return;
    if (toggle.dataset.running === "1") {
      await stop();
      return;
    }
    if (starting) return;
    await start();
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
    if (window.Dashboard?.isPaused?.()) return;
    statsTimer = setInterval(() => {
      if (window.Dashboard?.isPaused?.()) return;
      updateLiveBandwidth().catch(() => {});
    }, 1000);
    updateLiveBandwidth().catch(() => {});
  }

  /** Freeze local playback; keep WebRTC connected. */
  function pauseMediaForDashboard() {
    const { video } = els();
    if (!video) return;
    mediaPausedByDashboard = true;
    stopStatsMonitor();
    try {
      video.pause();
    } catch {
      /* ignore */
    }
    setOverlay("已暂停", true);
  }

  /**
   * Resume playback and drop frames buffered while paused by
   * re-attaching the live MediaStream (jump to live edge).
   */
  async function resumeMediaForDashboard() {
    const { video } = els();
    if (!video) return;
    mediaPausedByDashboard = false;
    const stream = video.srcObject;
    if (stream instanceof MediaStream) {
      video.srcObject = null;
      // Force the element to drop queued frames, then bind the live stream again.
      await new Promise((r) => requestAnimationFrame(() => r()));
      video.srcObject = stream;
    }
    const playing = await playMuted(video);
    if (playing) setOverlay("", false);
    else setOverlay("已继续（等待画面）", true);

    const { audio } = els();
    if (audio?.checked) {
      startUnmuteAssist();
      tryUnmute(false);
    }
    if (pc && !["closed", "failed"].includes(pc.connectionState)) {
      startStatsMonitor();
    }
  }

  function onDashboardPauseChange(paused) {
    if (!root || !document.body.contains(root)) return;
    if (paused) pauseMediaForDashboard();
    else resumeMediaForDashboard().catch((err) => console.warn("resume media", err));
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

  function stopUnmuteAssist() {
    if (unmuteTimer) {
      clearInterval(unmuteTimer);
      unmuteTimer = null;
    }
    if (unmuteGestureHandler) {
      window.removeEventListener("pointerdown", unmuteGestureHandler, true);
      window.removeEventListener("keydown", unmuteGestureHandler, true);
      window.removeEventListener("touchstart", unmuteGestureHandler, true);
      unmuteGestureHandler = null;
    }
  }

  async function playMuted(video) {
    if (!video) return false;
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute("muted", "");
    video.playsInline = true;
    try {
      await video.play();
      return !video.paused;
    } catch (err) {
      console.warn("muted play failed", err);
      return false;
    }
  }

  async function tryUnmute(showButtonOnFail = false) {
    const { video, unmute, audio } = els();
    if (!video || !audio?.checked) return false;

    // Never leave the player paused: if unmute is blocked, keep muted playback.
    if (video.paused) {
      await playMuted(video);
    }

    const prevMuted = video.muted;
    video.muted = false;
    video.defaultMuted = false;
    video.removeAttribute("muted");
    video.volume = 1;
    try {
      await video.play();
      if (!video.muted && !video.paused) {
        if (unmute) unmute.hidden = true;
        return true;
      }
    } catch (err) {
      console.warn("unmute/play", err);
    }

    // Restore muted autoplay so the picture keeps running.
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute("muted", "");
    if (video.paused) await playMuted(video);
    else if (!prevMuted) {
      /* stay muted while playing */
    }

    if (showButtonOnFail && unmute && !video.paused) unmute.hidden = false;
    return false;
  }

  function startUnmuteAssist() {
    stopUnmuteAssist();
    const { audio, unmute } = els();
    if (!audio?.checked) return;
    if (unmute) unmute.hidden = true;

    let tries = 0;
    unmuteTimer = setInterval(() => {
      tries += 1;
      tryUnmute(false).then((ok) => {
        if (ok) {
          stopUnmuteAssist();
          setStatus("画面已连接（含音频）");
          return;
        }
        // After several silent retries, hint but do not block video.
        if (tries === 5) {
          setStatus("画面播放中；点击页面任意处可开启声音");
          const btn = els().unmute;
          if (btn) btn.hidden = false;
        }
        if (tries >= 12 && unmuteTimer) {
          clearInterval(unmuteTimer);
          unmuteTimer = null;
        }
      });
    }, 500);

    unmuteGestureHandler = () => {
      tryUnmute(false).then((ok) => {
        if (ok) {
          stopUnmuteAssist();
          const btn = els().unmute;
          if (btn) btn.hidden = true;
          setStatus("已自动开启声音");
        }
      });
    };
    window.addEventListener("pointerdown", unmuteGestureHandler, true);
    window.addEventListener("keydown", unmuteGestureHandler, true);
    window.addEventListener("touchstart", unmuteGestureHandler, true);
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
    if (!pc || !msg) return;
    // Empty / missing candidate => end-of-candidates for this m-line.
    const isEnd = !msg.candidate;
    const candidate = isEnd
      ? null
      : new RTCIceCandidate({
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
        startUnmuteAssist();
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
    if (window.HdmiDelayRecord?.isRecording()) {
      window.HdmiDelayRecord.stop();
    }
    stopStatsMonitor();
    stopUnmuteAssist();
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
      video.muted = true;
      video.defaultMuted = true;
      video.setAttribute("muted", "");
    }
  }

  async function loadIceServers() {
    try {
      const res = await fetch("/api/hdmi/ice-servers");
      const data = await res.json();
      if (data.ok && Array.isArray(data.iceServers) && data.iceServers.length) {
        return data.iceServers;
      }
    } catch (err) {
      console.warn("load ice servers", err);
    }
    return [{ urls: "stun:stun.l.google.com:19302" }];
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

    const iceServers = await loadIceServers();
    pc = new RTCPeerConnection({ iceServers });

    pc.addTransceiver("video", { direction: "recvonly" });
    if (enableAudio) {
      pc.addTransceiver("audio", { direction: "recvonly" });
    }

    pc.ontrack = (ev) => {
      if (!video.srcObject) {
        video.srcObject = new MediaStream();
      }
      video.srcObject.addTrack(ev.track);

      if (window.Dashboard?.isPaused?.()) {
        mediaPausedByDashboard = true;
        try {
          video.pause();
        } catch {
          /* ignore */
        }
        setOverlay("已暂停", true);
        if (ev.track.kind === "video") {
          setStatus("画面已连接（全局已暂停）");
        }
        return;
      }

      // Always start muted so autoplay works on page reload without a gesture.
      playMuted(video).then((playing) => {
        if (playing) {
          setOverlay("", false);
        }
        if (enableAudio) {
          startUnmuteAssist();
          // One immediate unmute attempt; if blocked, muted video already plays.
          tryUnmute(false);
        } else {
          stopUnmuteAssist();
          const { unmute } = els();
          if (unmute) unmute.hidden = true;
        }
      });

      if (ev.track.kind === "video") {
        setOverlay("", false);
        setStatus(enableAudio ? "画面已连接（尝试开启声音）" : "画面已连接");
        startStatsMonitor();
      }
      if (ev.track.kind === "audio") {
        if (enableAudio) tryUnmute(false);
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
      if (pc.connectionState === "connected") {
        if (window.Dashboard?.isPaused?.()) {
          pauseMediaForDashboard();
          return;
        }
        startStatsMonitor();
        startUnmuteAssist();
      }
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
    starting = false;
    const wasRec = !!window.HdmiDelayRecord?.isRecording?.();
    const sock = ensureSocket();
    if (sock.connected) sock.emit("hdmi:stop", {});
    cleanupPc();
    setButtons({ running: false });
    setOverlay("已停止", true);
    setStatus(wasRec ? "已停止监测；延时录制已保存，可回放" : "已停止监测");
    await refreshEstimateBandwidth();
  }

  function mount(panelEl) {
    root = panelEl.querySelector(".hdmi");
    if (!root) return;

    if (root.dataset.bound !== "1") {
      root.dataset.bound = "1";
      const { resolution, audio, toggle, unmute, delayToggle } = els();
      resolution.addEventListener("change", () => {
        if (!pc) refreshEstimateBandwidth();
      });
      audio.addEventListener("change", () => {
        if (!pc) refreshEstimateBandwidth();
      });
      toggle.addEventListener("click", () => onToggleClick());
      delayToggle?.addEventListener("click", () => onDelayRecClick());
      if (unmute) {
        unmute.addEventListener("click", () => {
          tryUnmute(false).then((ok) => {
            if (ok) {
              stopUnmuteAssist();
              setStatus("已取消静音");
            }
          });
        });
      }
    }

    if (window.HdmiDelayRecord) {
      window.HdmiDelayRecord.attach(els().video);
      if (!delayUnsub) {
        delayUnsub = window.HdmiDelayRecord.subscribe((state) => syncDelayUi(state));
      }
    }

    setKeyFeedback("键盘：方向/确认/返回/音量 · P电源 B列表 A助手 S设置 H主页 M静音");
    bindKeyboard();
    if (!pauseUnsub && window.Dashboard?.onPauseChange) {
      pauseUnsub = window.Dashboard.onPauseChange(onDashboardPauseChange);
    }
    if (window.Dashboard?.isPaused?.()) {
      pauseMediaForDashboard();
    }
    refreshEstimateBandwidth();
    ensureSocket();
    start().catch((err) => console.warn("auto start hdmi", err));
  }

  function unmount() {
    unbindKeyboard();
    if (pauseUnsub) {
      pauseUnsub();
      pauseUnsub = null;
    }
    if (delayUnsub) {
      delayUnsub();
      delayUnsub = null;
    }
    if (window.HdmiDelayRecord) window.HdmiDelayRecord.detach();
    mediaPausedByDashboard = false;
    starting = false;
    try {
      const sock = ensureSocket();
      if (sock.connected) sock.emit("hdmi:stop", {});
    } catch {
      /* ignore */
    }
    try {
      cleanupPc();
    } catch {
      /* ignore */
    }
    root = null;
  }

  return { mount, unmount, start, stop };
})();
