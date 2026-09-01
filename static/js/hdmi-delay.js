window.HdmiDelayRecord = (() => {
  const MAX_MS = 30000;
  const MAX_FRAMES = 1800;
  const JPEG_QUALITY = 0.68;
  const listeners = new Set();

  let video = null;
  let recording = false;
  let frames = [];
  let clip = null;
  let canvas = null;
  let ctx = null;
  let encoding = false;
  let rvfcId = null;
  let rafId = null;
  let lastNotifyAt = 0;
  let captureWidth = 0;
  let captureHeight = 0;

  function nowMs() {
    return performance.now();
  }

  function bufferDurationMs() {
    if (frames.length < 2) return frames.length ? 0 : 0;
    return Math.max(0, frames[frames.length - 1].t - frames[0].t);
  }

  function getState() {
    const dur = recording ? bufferDurationMs() : clip?.durationMs || 0;
    const count = recording ? frames.length : clip?.frames?.length || 0;
    return {
      recording,
      hasVideo: !!(video && video.srcObject),
      bufferMs: dur,
      frameCount: count,
      maxMs: MAX_MS,
      hasClip: !!(clip && clip.frames.length),
    };
  }

  function getClip() {
    return clip;
  }

  function isRecording() {
    return recording;
  }

  function subscribe(fn) {
    listeners.add(fn);
    try {
      fn(getState(), "sync");
    } catch (err) {
      console.warn("hdmi-delay subscribe", err);
    }
    return () => listeners.delete(fn);
  }

  function notify(reason) {
    const state = getState();
    listeners.forEach((fn) => {
      try {
        fn(state, reason);
      } catch (err) {
        console.warn("hdmi-delay notify", err);
      }
    });
  }

  function notifyProgress() {
    const t = nowMs();
    if (t - lastNotifyAt < 200 && frames.length > 1) return;
    lastNotifyAt = t;
    notify("progress");
  }

  function ensureCanvas(w, h) {
    if (!canvas) {
      canvas = document.createElement("canvas");
      ctx = canvas.getContext("2d", { alpha: false });
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function prune(now) {
    const cutoff = now - MAX_MS;
    while (frames.length && frames[0].t < cutoff) {
      frames.shift();
    }
    while (frames.length > MAX_FRAMES) {
      frames.shift();
    }
  }

  function clearLiveFrames() {
    frames = [];
    captureWidth = 0;
    captureHeight = 0;
  }

  function clearClip() {
    clip = null;
  }

  function freezeClip() {
    if (!frames.length) {
      clip = null;
      return;
    }
    const t0 = frames[0].t;
    clip = {
      frames: frames.map((f) => ({ t: f.t - t0, blob: f.blob, w: f.w, h: f.h })),
      durationMs: frames[frames.length - 1].t - t0,
      width: captureWidth || frames[0].w,
      height: captureHeight || frames[0].h,
    };
    frames = [];
  }

  function cancelSchedule() {
    if (video && rvfcId != null && typeof video.cancelVideoFrameCallback === "function") {
      try {
        video.cancelVideoFrameCallback(rvfcId);
      } catch {
        /* ignore */
      }
    }
    rvfcId = null;
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function canCapture() {
    if (!recording || !video) return false;
    if (window.Dashboard?.isPaused?.()) return false;
    if (video.paused || video.ended) return false;
    if (!video.srcObject) return false;
    if (!video.videoWidth || !video.videoHeight) return false;
    if (video.readyState < 2) return false;
    return true;
  }

  function blobFromCanvas() {
    if (canvas.convertToBlob) {
      return canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
    }
    return new Promise((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY);
    });
  }

  async function captureFrame(t) {
    if (encoding || !canCapture()) return;
    encoding = true;
    try {
      const srcW = video.videoWidth;
      const srcH = video.videoHeight;
      const maxW = 1920;
      const scale = srcW > maxW ? maxW / srcW : 1;
      const w = Math.max(1, Math.round(srcW * scale));
      const h = Math.max(1, Math.round(srcH * scale));
      let bmp;
      try {
        bmp = await createImageBitmap(video);
      } catch (err) {
        console.warn("hdmi-delay bitmap", err);
        return;
      }
      if (!recording) {
        bmp.close();
        return;
      }
      ensureCanvas(w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      const blob = await blobFromCanvas();
      if (!recording || !blob || blob.size < 32) return;
      captureWidth = w;
      captureHeight = h;
      frames.push({ t, blob, w, h });
      prune(t);
      notifyProgress();
    } catch (err) {
      console.warn("hdmi-delay capture", err);
    } finally {
      encoding = false;
    }
  }

  function onVideoFrame(_now, _meta) {
    rvfcId = null;
    if (!recording) return;
    captureFrame(nowMs());
    scheduleNext();
  }

  function onRaf() {
    rafId = null;
    if (!recording) return;
    captureFrame(nowMs());
    scheduleNext();
  }

  function scheduleNext() {
    if (!recording || !video) return;
    if (typeof video.requestVideoFrameCallback === "function") {
      rvfcId = video.requestVideoFrameCallback(onVideoFrame);
      return;
    }
    rafId = requestAnimationFrame(onRaf);
  }

  function attach(videoEl) {
    video = videoEl || null;
    notify("attach");
  }

  function detach() {
    if (recording) stop({ openPanel: true });
    video = null;
    notify("detach");
  }

  function start() {
    if (recording) return { ok: true };
    if (!video || !video.srcObject) {
      return { ok: false, error: "请先开始 HDMI 采集" };
    }
    clearClip();
    clearLiveFrames();
    recording = true;
    lastNotifyAt = 0;
    notify("start");
    scheduleNext();
    return { ok: true };
  }

  function stop(opts = {}) {
    if (!recording) return { ok: true, clip };
    recording = false;
    cancelSchedule();
    freezeClip();
    notify("stop");
    const openPanel = opts.openPanel !== false && clip && clip.frames.length;
    if (openPanel && window.Dashboard?.addPanel) {
      window.Dashboard.addPanel("hdmi-delay");
    }
    return { ok: true, clip };
  }

  async function packClip() {
    if (!clip?.frames?.length) return null;
    const header = new ArrayBuffer(20);
    const view = new DataView(header);
    view.setUint8(0, 0x48);
    view.setUint8(1, 0x44);
    view.setUint8(2, 0x4c);
    view.setUint8(3, 0x59);
    view.setUint32(4, 1, true);
    view.setUint32(8, clip.frames.length, true);
    view.setUint32(12, clip.width || clip.frames[0].w || 0, true);
    view.setUint32(16, clip.height || clip.frames[0].h || 0, true);
    const parts = [header];
    for (const frame of clip.frames) {
      const meta = new ArrayBuffer(8);
      const mv = new DataView(meta);
      mv.setUint32(0, Math.max(0, Math.round(frame.t)), true);
      mv.setUint32(4, frame.blob.size, true);
      parts.push(meta, frame.blob);
    }
    return new Blob(parts, { type: "application/octet-stream" });
  }

  return {
    MAX_MS,
    attach,
    detach,
    start,
    stop,
    isRecording,
    getState,
    getClip,
    packClip,
    subscribe,
  };
})();

window.HdmiDelayPanel = (() => {
  let root = null;
  let unsub = null;
  let index = 0;
  let playing = false;
  let rafId = null;
  let playOriginWall = 0;
  let playOriginMedia = 0;
  let drawGen = 0;
  const SEEK_MAX = 10000;
  let seeking = false;
  let seekRaf = null;
  let pendingSeekIndex = null;
  let seekPointerBound = false;
  let saving = false;
  let saveXhr = null;

  function els() {
    return {
      playBtn: root.querySelector("#hdmi-delay-play"),
      pauseBtn: root.querySelector("#hdmi-delay-pause"),
      prev: root.querySelector("#hdmi-delay-prev"),
      next: root.querySelector("#hdmi-delay-next"),
      saveBtn: root.querySelector("#hdmi-delay-save"),
      pos: root.querySelector("#hdmi-delay-pos"),
      seek: root.querySelector("#hdmi-delay-seek"),
      seekCur: root.querySelector("#hdmi-delay-seek-cur"),
      seekDur: root.querySelector("#hdmi-delay-seek-dur"),
      canvas: root.querySelector("#hdmi-delay-canvas"),
      overlay: root.querySelector("#hdmi-delay-overlay"),
      status: root.querySelector("#hdmi-delay-status"),
    };
  }

  function formatTime(ms) {
    const s = Math.max(0, ms) / 1000;
    return `${s.toFixed(2)}s`;
  }

  function clipFrames() {
    return window.HdmiDelayRecord?.getClip()?.frames || [];
  }

  function clipDurationMs() {
    const frames = clipFrames();
    if (!frames.length) return 0;
    return frames[frames.length - 1].t || 0;
  }

  function frameIndexAtTime(ms) {
    const frames = clipFrames();
    if (!frames.length) return 0;
    const t = Math.max(0, Math.min(ms, frames[frames.length - 1].t));
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frames[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function indexToSeekValue(i) {
    const frames = clipFrames();
    const dur = clipDurationMs();
    if (!frames.length || dur <= 0) return 0;
    const t = frames[i]?.t || 0;
    return Math.round((t / dur) * SEEK_MAX);
  }

  function seekValueToIndex(raw) {
    const dur = clipDurationMs();
    const ratio = Math.max(0, Math.min(1, Number(raw) / SEEK_MAX));
    return frameIndexAtTime(ratio * dur);
  }

  function paintSeekFill(value) {
    const { seek } = els();
    if (!seek) return;
    const pct = (Math.max(0, Math.min(SEEK_MAX, Number(value) || 0)) / SEEK_MAX) * 100;
    seek.style.setProperty("--seek-pct", `${pct}%`);
  }

  function setOverlay(text, show) {
    const { overlay } = els();
    if (!overlay) return;
    overlay.textContent = text;
    overlay.classList.toggle("hidden", !show);
  }

  function setStatus(text) {
    const { status } = els();
    if (status) status.textContent = text;
  }

  function syncControls() {
    if (!root) return;
    const { playBtn, pauseBtn, prev, next, saveBtn, pos, seek, seekCur, seekDur } = els();
    const rec = window.HdmiDelayRecord?.getState?.() || {};
    const frames = clipFrames();
    const n = frames.length;
    const has = n > 0 && !rec.recording;
    const dur = clipDurationMs();
    if (playBtn) playBtn.disabled = !has || playing || saving;
    if (pauseBtn) pauseBtn.disabled = !has || !playing || saving;
    if (prev) prev.disabled = !has || index <= 0 || saving;
    if (next) next.disabled = !has || index >= n - 1 || saving;
    if (saveBtn) {
      saveBtn.disabled = !has || saving;
      saveBtn.textContent = saving ? "保存中…" : "保存视频";
    }
    if (seek) {
      seek.disabled = !has;
      seek.max = String(SEEK_MAX);
      if (!seeking) {
        const v = has ? indexToSeekValue(index) : 0;
        seek.value = String(v);
        paintSeekFill(v);
      } else {
        paintSeekFill(seek.value);
      }
    }
    if (seekCur) {
      const t = has ? frames[index]?.t || 0 : 0;
      seekCur.textContent = formatTime(t);
    }
    if (seekDur) seekDur.textContent = formatTime(has ? dur : 0);
    if (pos) {
      if (rec.recording) {
        pos.textContent = `录制中 ${formatTime(rec.bufferMs)} / ${formatTime(rec.maxMs)} · ${rec.frameCount} 帧`;
      } else if (has) {
        const t = frames[index]?.t || 0;
        pos.textContent = `第 ${index + 1} / ${n} 帧 · ${formatTime(t)} / ${formatTime(dur)}`;
      } else {
        pos.textContent = "尚未录制";
      }
    }
  }

  function pause(opts = {}) {
    playing = false;
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (opts.sync !== false) syncControls();
  }

  async function drawIndex(i) {
    const frames = clipFrames();
    if (!frames.length || !root) return;
    index = Math.max(0, Math.min(i, frames.length - 1));
    const frame = frames[index];
    const { canvas } = els();
    if (!canvas || !frame) return;
    const gen = ++drawGen;
    try {
      const bmp = await createImageBitmap(frame.blob);
      if (gen !== drawGen || !root) {
        bmp.close();
        return;
      }
      if (canvas.width !== frame.w || canvas.height !== frame.h) {
        canvas.width = frame.w;
        canvas.height = frame.h;
      }
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      setOverlay("", false);
    } catch (err) {
      console.warn("hdmi-delay draw", err);
    }
    if (root) syncControls();
  }

  function playTick() {
    rafId = null;
    if (!playing) return;
    const frames = clipFrames();
    if (!frames.length) {
      pause();
      return;
    }
    const mediaT = playOriginMedia + (performance.now() - playOriginWall);
    let i = index;
    while (i + 1 < frames.length && frames[i + 1].t <= mediaT) i += 1;
    if (i !== index) drawIndex(i);
    if (mediaT >= frames[frames.length - 1].t) {
      drawIndex(frames.length - 1);
      pause();
      setStatus("已播完");
      return;
    }
    rafId = requestAnimationFrame(playTick);
  }

  function startPlayback() {
    const frames = clipFrames();
    if (!frames.length || playing) return;
    if (index >= frames.length - 1) index = 0;
    playing = true;
    playOriginWall = performance.now();
    playOriginMedia = frames[index].t;
    setStatus("回放中");
    drawIndex(index);
    syncControls();
    rafId = requestAnimationFrame(playTick);
  }

  function step(delta) {
    pause();
    const frames = clipFrames();
    if (!frames.length) return;
    drawIndex(index + delta);
    setStatus("逐帧");
  }

  function defaultSaveName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `hdmi-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.mp4`;
  }

  async function pickSaveHandle(filename) {
    if (typeof window.showSaveFilePicker !== "function") return null;
    return window.showSaveFilePicker({
      suggestedName: filename,
      types: [
        {
          description: "MP4 视频",
          accept: { "video/mp4": [".mp4"] },
        },
      ],
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportMp4(pack) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      saveXhr = xhr;
      xhr.open("POST", "/api/hdmi/delay-export");
      xhr.responseType = "blob";
      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return;
        const pct = Math.round((ev.loaded / ev.total) * 100);
        setStatus(`正在上传 ${pct}%`);
      };
      xhr.onload = async () => {
        saveXhr = null;
        const blob = xhr.response;
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(blob);
          return;
        }
        let message = "导出失败";
        try {
          const text = await blob.text();
          const json = JSON.parse(text);
          if (json.error) message = json.error;
        } catch {
          /* ignore */
        }
        reject(new Error(message));
      };
      xhr.onerror = () => {
        saveXhr = null;
        reject(new Error("网络错误"));
      };
      xhr.onabort = () => {
        saveXhr = null;
        reject(new Error("已取消"));
      };
      setStatus("正在导出视频…");
      xhr.send(pack);
    });
  }

  async function onSaveClick() {
    if (saving) return;
    const clip = window.HdmiDelayRecord?.getClip?.();
    if (!clip?.frames?.length) {
      setStatus("没有可保存的录制");
      return;
    }
    pause({ sync: false });
    const filename = defaultSaveName();
    let handle = null;
    try {
      handle = await pickSaveHandle(filename);
    } catch (err) {
      if (err && (err.name === "AbortError" || err.name === "NotAllowedError")) {
        setStatus("已取消保存");
        return;
      }
      handle = null;
    }

    saving = true;
    syncControls();
    try {
      setStatus("正在打包录制数据…");
      const pack = await window.HdmiDelayRecord.packClip();
      if (!pack) throw new Error("没有可保存的录制");
      const video = await exportMp4(pack);
      if (handle) {
        setStatus("正在写入文件…");
        const writable = await handle.createWritable();
        await writable.write(video);
        await writable.close();
        setStatus(`已保存 ${filename}`);
      } else {
        downloadBlob(video, filename);
        setStatus(`已开始下载 ${filename}`);
      }
    } catch (err) {
      if (err && err.message === "已取消") {
        setStatus("已取消保存");
      } else {
        setStatus(`保存失败：${err.message || err}`);
      }
    } finally {
      saving = false;
      saveXhr = null;
      syncControls();
    }
  }

  function previewSeekIndex(i, statusText) {
    const frames = clipFrames();
    if (!frames.length) return;
    index = Math.max(0, Math.min(i, frames.length - 1));
    const { seekCur, pos, seek } = els();
    const dur = clipDurationMs();
    const t = frames[index]?.t || 0;
    if (seekCur) seekCur.textContent = formatTime(t);
    if (pos) pos.textContent = `第 ${index + 1} / ${frames.length} 帧 · ${formatTime(t)} / ${formatTime(dur)}`;
    if (seek) paintSeekFill(seek.value);
    pendingSeekIndex = index;
    if (seekRaf != null) return;
    seekRaf = requestAnimationFrame(() => {
      seekRaf = null;
      const target = pendingSeekIndex;
      pendingSeekIndex = null;
      if (target != null) {
        drawIndex(target);
        if (statusText) setStatus(statusText);
      }
    });
  }

  function onSeekInput(e) {
    e?.stopPropagation?.();
    const { seek } = els();
    if (!seek || seek.disabled) return;
    const raw = seek.value;
    if (playing) pause({ sync: false });
    previewSeekIndex(seekValueToIndex(raw), "已定位");
  }

  function onSeekPointerDown(e) {
    e.stopPropagation();
    seeking = true;
    if (playing) pause({ sync: false });
    if (!seekPointerBound) {
      seekPointerBound = true;
      window.addEventListener("pointerup", onSeekPointerUp, true);
      window.addEventListener("pointercancel", onSeekPointerUp, true);
    }
  }

  function onSeekPointerUp(e) {
    e?.stopPropagation?.();
    window.removeEventListener("pointerup", onSeekPointerUp, true);
    window.removeEventListener("pointercancel", onSeekPointerUp, true);
    seekPointerBound = false;
    seeking = false;
    if (seekRaf != null) {
      cancelAnimationFrame(seekRaf);
      seekRaf = null;
    }
    pendingSeekIndex = null;
    const { seek } = els();
    if (seek && !seek.disabled) {
      drawIndex(seekValueToIndex(seek.value));
      setStatus("已定位");
    } else {
      syncControls();
    }
  }

  function applyRecordState(state, reason) {
    if (!root) return;
    if (state.recording) {
      pause();
      setOverlay("正在录制，停止后可回放", true);
      setStatus(
        `环形缓冲 ${formatTime(state.bufferMs)} / ${formatTime(state.maxMs)} · ${state.frameCount} 帧（超出 30 秒将丢弃更早画面）`
      );
      syncControls();
      return;
    }
    const frames = clipFrames();
    if (!frames.length) {
      pause();
      index = 0;
      setOverlay(state.hasVideo ? "尚未录制" : "在操作台开始 HDMI 采集后即可录制并回放", true);
      setStatus("在操作台点击「延时录制」；最长保留最近 30 秒");
      syncControls();
      return;
    }
    if (reason === "stop" || reason === "sync") {
      pause();
      index = 0;
      drawIndex(0);
      setStatus(`已载入 ${frames.length} 帧 · ${formatTime(frames[frames.length - 1].t)}，可回放或逐帧查看`);
    }
    syncControls();
  }

  function mount(panelEl) {
    root = panelEl.querySelector(".hdmi-delay");
    if (!root) return;

    if (root.dataset.bound !== "1") {
      root.dataset.bound = "1";
      const { playBtn, pauseBtn, prev, next, saveBtn, seek } = els();
      playBtn?.addEventListener("click", () => startPlayback());
      pauseBtn?.addEventListener("click", () => {
        if (!playing) return;
        pause();
        setStatus("已暂停");
      });
      prev?.addEventListener("click", () => step(-1));
      next?.addEventListener("click", () => step(1));
      saveBtn?.addEventListener("click", () => onSaveClick());
      if (seek) {
        const seekRow = root.querySelector(".hdmi-delay-seek-row");
        seekRow?.addEventListener("pointerdown", (e) => e.stopPropagation());
        seek.addEventListener("pointerdown", onSeekPointerDown);
        seek.addEventListener("mousedown", (e) => e.stopPropagation());
        seek.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
        seek.addEventListener("input", onSeekInput);
        seek.addEventListener("change", onSeekInput);
      }
    }

    if (!unsub && window.HdmiDelayRecord?.subscribe) {
      unsub = window.HdmiDelayRecord.subscribe((state, reason) => applyRecordState(state, reason));
    } else {
      applyRecordState(window.HdmiDelayRecord?.getState?.() || {}, "sync");
    }
  }

  function unmount() {
    pause();
    if (saveXhr) {
      try {
        saveXhr.abort();
      } catch {
        /* ignore */
      }
      saveXhr = null;
    }
    saving = false;
    window.removeEventListener("pointerup", onSeekPointerUp, true);
    window.removeEventListener("pointercancel", onSeekPointerUp, true);
    seekPointerBound = false;
    seeking = false;
    if (seekRaf != null) {
      cancelAnimationFrame(seekRaf);
      seekRaf = null;
    }
    pendingSeekIndex = null;
    if (unsub) {
      unsub();
      unsub = null;
    }
    root = null;
  }

  return { mount, unmount };
})();
