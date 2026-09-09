window.HdmiDelayRecord = (() => {
  const MAX_MS = 30000;
  const listeners = new Set();

  let video = null;
  let sock = null;
  let socketBound = false;
  let recording = false;
  let clip = null;
  let remote = { bufferMs: 0, frameCount: 0, fps: 0, maxMs: MAX_MS };
  let pendingOpenPanel = false;

  function getState() {
    const dur = recording ? remote.bufferMs || 0 : clip?.durationMs || 0;
    const count = recording ? remote.frameCount || 0 : clip?.frames?.length || 0;
    let fps = recording ? remote.fps || 0 : 0;
    if (!recording && clip?.frames?.length > 1 && clip.durationMs > 200) {
      fps = ((clip.frames.length - 1) * 1000) / clip.durationMs;
    }
    return {
      recording,
      hasVideo: !!(video && video.srcObject),
      bufferMs: dur,
      frameCount: count,
      fps,
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

  function applyRemote(s, reason) {
    if (!s) return;
    if (s.ok === false && s.error) {
      recording = false;
      notify("sync");
      return;
    }
    remote = {
      bufferMs: s.bufferMs || 0,
      frameCount: s.frameCount || 0,
      fps: s.fps || 0,
      maxMs: s.maxMs || MAX_MS,
    };
    if (typeof s.recording === "boolean") recording = s.recording;
    notify(reason || "progress");
  }

  function unpackHdly(buffer) {
    const data = new DataView(buffer);
    if (data.byteLength < 20) return null;
    const magic = String.fromCharCode(
      data.getUint8(0),
      data.getUint8(1),
      data.getUint8(2),
      data.getUint8(3)
    );
    if (magic !== "HDLY") return null;
    const count = data.getUint32(8, true);
    const width = data.getUint32(12, true);
    const height = data.getUint32(16, true);
    let offset = 20;
    const frames = [];
    for (let i = 0; i < count; i += 1) {
      if (offset + 8 > data.byteLength) break;
      const t = data.getUint32(offset, true);
      const size = data.getUint32(offset + 4, true);
      offset += 8;
      if (size < 32 || offset + size > data.byteLength) break;
      const slice = buffer.slice(offset, offset + size);
      offset += size;
      frames.push({ t, blob: new Blob([slice], { type: "image/jpeg" }), w: width, h: height });
    }
    if (!frames.length) return null;
    return {
      frames,
      durationMs: frames[frames.length - 1].t || 0,
      width,
      height,
    };
  }

  async function finishStopped(s) {
    recording = false;
    applyRemote({ ...s, recording: false }, "progress");
    if (!s || !s.ok || !s.hasClip) {
      if (!clip) clip = null;
      notify("stop");
      return;
    }
    try {
      const res = await fetch("/api/hdmi/delay-clip");
      if (!res.ok) throw new Error("无法读取录制数据");
      const buf = await res.arrayBuffer();
      clip = unpackHdly(buf);
    } catch (err) {
      console.warn("hdmi-delay fetch clip", err);
      clip = null;
    }
    notify("stop");
    if (pendingOpenPanel && clip?.frames?.length && window.Dashboard?.addPanel) {
      window.Dashboard.addPanel("hdmi-delay");
    }
    pendingOpenPanel = false;
  }

  function bindSocket(next) {
    sock = next || sock;
    if (!sock || socketBound) return;
    socketBound = true;
    sock.on("hdmi:delay-progress", (s) => applyRemote(s, "progress"));
    sock.on("hdmi:delay-state", (s) => {
      if (s && s.ok === false && s.error) {
        recording = false;
        notify("sync");
        return;
      }
      applyRemote(s, s?.recording ? "start" : "sync");
    });
    sock.on("hdmi:delay-stopped", (s) => {
      finishStopped(s).catch((err) => console.warn("hdmi-delay stop", err));
    });
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
    if (!sock) return { ok: false, error: "信令未连接" };
    clip = null;
    pendingOpenPanel = false;
    remote = { bufferMs: 0, frameCount: 0, fps: 0, maxMs: MAX_MS };
    sock.emit("hdmi:delay-start");
    return { ok: true };
  }

  function stop(opts = {}) {
    pendingOpenPanel = opts.openPanel !== false;
    if (!recording) {
      if (pendingOpenPanel && clip?.frames?.length && window.Dashboard?.addPanel) {
        window.Dashboard.addPanel("hdmi-delay");
      }
      return { ok: true, clip };
    }
    if (sock) sock.emit("hdmi:delay-stop");
    else recording = false;
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
    bindSocket,
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
      saveImageBtn: root.querySelector("#hdmi-delay-save-image"),
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
    const { playBtn, pauseBtn, prev, next, saveImageBtn, saveBtn, pos, seek, seekCur, seekDur } = els();
    const rec = window.HdmiDelayRecord?.getState?.() || {};
    const frames = clipFrames();
    const n = frames.length;
    const has = n > 0 && !rec.recording;
    const dur = clipDurationMs();
    if (playBtn) playBtn.disabled = !has || playing || saving;
    if (pauseBtn) pauseBtn.disabled = !has || !playing || saving;
    if (prev) prev.disabled = !has || index <= 0 || saving;
    if (next) next.disabled = !has || index >= n - 1 || saving;
    if (saveImageBtn) saveImageBtn.disabled = !has || saving;
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

  function stampName(ext) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `hdmi-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${ext}`;
  }

  function defaultSaveName() {
    return stampName(".mp4");
  }

  function defaultImageName() {
    return stampName(`-f${index + 1}.jpg`);
  }

  async function pickSaveHandle(filename, type) {
    if (typeof window.showSaveFilePicker !== "function") return null;
    return window.showSaveFilePicker({
      suggestedName: filename,
      types: [
        type || {
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

  async function onSaveImageClick() {
    if (saving) return;
    const frames = clipFrames();
    const frame = frames[index];
    if (!frame?.blob) {
      setStatus("没有可保存的画面");
      return;
    }
    if (playing) pause();
    const filename = defaultImageName();
    let handle = null;
    try {
      handle = await pickSaveHandle(filename, {
        description: "JPEG 图片",
        accept: { "image/jpeg": [".jpg", ".jpeg"] },
      });
    } catch (err) {
      if (err && (err.name === "AbortError" || err.name === "NotAllowedError")) {
        setStatus("已取消保存");
        return;
      }
      handle = null;
    }
    try {
      const blob =
        frame.blob.type === "image/jpeg"
          ? frame.blob
          : new Blob([frame.blob], { type: "image/jpeg" });
      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        setStatus(`已保存 ${filename}`);
      } else {
        downloadBlob(blob, filename);
        setStatus(`已开始下载 ${filename}`);
      }
    } catch (err) {
      setStatus(`保存失败：${err.message || err}`);
    }
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
        `环形缓冲 ${formatTime(state.bufferMs)} / ${formatTime(state.maxMs)} · ${state.frameCount} 帧` +
          (state.fps > 0 ? ` · ${state.fps.toFixed(1)}fps` : "") +
          "（超出 30 秒将丢弃更早画面）"
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

  function ensureSaveImageBtn() {
    if (!root || root.querySelector("#hdmi-delay-save-image")) return;
    const saveBtn = root.querySelector("#hdmi-delay-save");
    if (!saveBtn) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.id = "hdmi-delay-save-image";
    btn.textContent = "保存图片";
    btn.disabled = true;
    saveBtn.before(btn);
  }

  function mount(panelEl) {
    root = panelEl.querySelector(".hdmi-delay");
    if (!root) return;
    ensureSaveImageBtn();

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

    const { saveImageBtn } = els();
    if (saveImageBtn && saveImageBtn.dataset.bound !== "1") {
      saveImageBtn.dataset.bound = "1";
      saveImageBtn.addEventListener("click", () => onSaveImageClick());
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
