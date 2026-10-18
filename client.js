/**
 * Client half of the Voice Call bundle.
 *
 * It renders into the `shell.overlay` slot, which covers the whole frame and
 * outlives every panel: the call keeps running and stays visible when you
 * switch sessions. Nothing is appended to `document.body`, and every timer,
 * listener and audio element is released through `ctx.effect` when the bundle
 * unloads.
 *
 * Voice in: microphone → 16 kHz WAV → host `/voice-call/transcribe`.
 * Voice out: assistant turn text → host `/voice-call/tts` → one audio element.
 *
 * @module dsh-voice-call/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-voice-call',
  factory: (require) => {
    const React = require('react');
    const { useEffect, useRef, useState, useSyncExternalStore } = React;
    const h = React.createElement;

    const TOKENS = {
      surface: 'var(--dsw-alias-bg-overlay, #FFFFFF)',
      surfaceSoft: 'var(--dsw-alias-bg-layer-2, #F7F9FC)',
      border: 'var(--dsw-alias-border-l2, #E5E9F2)',
      ink: 'var(--dsw-alias-label-primary, #1F2937)',
      muted: 'var(--dsw-alias-label-secondary, #6B7280)',
      brand: 'var(--dsw-alias-brand-primary, #4D6BFE)',
      brandFill: 'var(--dsw-alias-button-primary-fill, #4D6BFE)',
      brandSoft: 'var(--dsw-alias-bg-multi-select, #EEF3FF)',
      danger: 'var(--dsw-alias-state-error-primary, #DC2626)',
      warn: 'var(--dsw-alias-state-warn-primary, #F59E0B)',
    };

    const FONT = "12px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif";
    const MIC_THRESHOLD = 0.009;
    const SILENCE_MS = 2600;
    const MAX_RECORD_MS = 45000;
    const IDLE_MS = 10000;
    const FIRST_CHUNK = 90;
    const SPEECH_TAIL_MS = 600;

    const DEFAULT_ACCENT = '#4D6BFE';
    const ACCENTS = ['#4D6BFE', '#0EA5E9', '#14B8A6', '#8B5CF6', '#EC4899', '#F97316', '#22C55E', '#1F2937'];

    function normalizeAccent(value) {
      const text = String(value || '').trim();
      return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : DEFAULT_ACCENT;
    }

    function rgba(hex, alpha) {
      const clean = normalizeAccent(hex).slice(1);
      const n = parseInt(clean, 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    }

    let storedAccent = DEFAULT_ACCENT;
    try {
      storedAccent = normalizeAccent(localStorage.getItem('dsh-voice-call-accent') || DEFAULT_ACCENT);
    } catch {}

    const listeners = new Set();
    let call = {
      active: false,
      prepared: false,
      sessionId: null,
      phase: 'idle',
      error: null,
      expanded: true,
      paused: false,
      startedAt: 0,
      lines: [],
      voice: 'Cherry',
      rate: 1,
      configured: false,
      keyMasked: '',
      voices: [],
      usage: null,
      level: 0,
      cleanSpeech: true,
      accent: storedAccent,
    };

    function set(patch) {
      call = { ...call, ...patch };
      for (const listener of listeners) listener();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function useCall() {
      return useSyncExternalStore(subscribe, () => call);
    }

    function appendLine(role, text) {
      set({ lines: [...call.lines, { role, text, at: Date.now() }].slice(-24) });
    }

    let pluginCtx = null;
    let sessionCtx = null;
    let binding = null;
    let reference = null;
    let unsubscribeEvents = null;
    let listening = false;
    let turnDone = false;
    let turnTimer = null;
    let assistantGotText = false;
    let assistantFullText = '';
    let eventStart = 0;
    const liveBlockTypes = new Map();
    let speechQueue = [];
    let speechPumpRunning = false;
    let speechAbort = new AbortController();
    let speechEpoch = 0;
    let ignoreCurrentTurn = false;
    let turnRunning = false;
    let steerNext = false;
    let suppressTurnSpeech = false;
    let audioEl = null;
    let forceStopRecording = null;

    // One utterance pipeline per page: `generation` invalidates every await that
    // started before a teardown, so a stale loop can neither send nor speak.
    let generation = 0;
    // Streaming speech: characters of assistantFullText already turned into
    // speech, plus the cleaned text waiting for a sentence boundary.
    let spokenUpTo = 0;
    let pendingSpeech = '';
    let spokeThisTurn = false;
    let streamFence = false;
    let streamTable = false;
    const INSTANCE = Math.random().toString(36).slice(2, 8);
    let moduleBoot = 1;
    let disposeSlot = null;
    let rate = 1;

    let cleanSpeech = true;
    try {
      cleanSpeech = localStorage.getItem('dsh-voice-call-clean-speech') !== '0';
    } catch {}
    call.cleanSpeech = cleanSpeech;

    /* ------------------------------------------------------------------ *
     * Speech text shaping
     * ------------------------------------------------------------------ */

    function chunkText(chunk) {
      if (!chunk) return '';
      if (typeof chunk === 'string') return chunk;
      if (typeof chunk.type === 'string') {
        if (chunk.type === 'reasoning-delta' || chunk.type === 'reasoning' || chunk.type === 'thinking') {
          return '';
        }
        if (chunk.type === 'text-delta' || chunk.type === 'text') return chunk.text || '';
        if (chunk.type === 'block-end') return chunkText(chunk.block);
        if (
          chunk.type === 'block-start' ||
          chunk.type === 'tool-call-delta' ||
          chunk.type === 'tool-call' ||
          chunk.type === 'usage' ||
          chunk.type === 'finish'
        ) {
          return '';
        }
      }
      if (Array.isArray(chunk.content)) return chunk.content.map(chunkText).join('');
      if (Array.isArray(chunk.parts)) return chunk.parts.map(chunkText).join('');
      return '';
    }

    function messageText(event) {
      const data = event && event.data;
      if (!data) return '';
      if (typeof data.text === 'string') return data.text;
      if (data.message) return chunkText(data.message) || chunkText(data.message.content);
      return chunkText(data.content);
    }

    function lastAssistantText() {
      if (!binding) return '';
      const entries = binding.eventSource.getSnapshot().entries;
      for (let i = entries.length - 1; i >= Math.max(0, eventStart); i--) {
        const entry = entries[i];
        if (entry.type !== 'event') continue;
        const event = entry.event;
        if (event.type === 'assistant/message') {
          const text = messageText(event);
          if (text.trim()) return text;
        }
      }
      return '';
    }

    function setCleanSpeech(value) {
      cleanSpeech = value;
      set({ cleanSpeech: value });
      try {
        localStorage.setItem('dsh-voice-call-clean-speech', value ? '1' : '0');
      } catch {}
    }

    function setAccent(value) {
      const accent = normalizeAccent(value);
      set({ accent });
      try {
        localStorage.setItem('dsh-voice-call-accent', accent);
      } catch {}
    }

    /**
     * Clean one Markdown line for speech, tracking fence and table state across
     * lines. State lives in `streamFence` / `streamTable` so a reply can be
     * cleaned incrementally while it streams.
     */
    function cleanStreamLine(line) {
      if (/^\s*(```|~~~)/.test(line)) {
        streamFence = !streamFence;
        return '';
      }
      if (streamFence) return '';
      const isTableRow = /^\s*\|.*\|\s*$/.test(line);
      const isTableSep = /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('|');
      if (isTableRow || isTableSep) {
        streamTable = true;
        return '';
      }
      if (streamTable) {
        if (/^\s*\|/.test(line)) return '';
        streamTable = false;
      }
      return line
        .replace(/^#{1,6}\s*/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*([-*+]|\d+[.)])\s+/, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/[*_~]{1,3}/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/https?:\/\/\S+/g, '链接')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function enqueueSentence(text) {
      const clean = String(text || '').replace(/\s+/g, ' ').trim();
      if (clean.length < 2) return;
      spokeThisTurn = true;
      enqueueSpeech(clean);
    }

    /**
     * Speak buffered speech as soon as a sentence (or a reasonable chunk) is
     * complete, so the first audio request goes out before the reply finishes.
     */
    function drainSpeech(force) {
      let guard = 0;
      while (pendingSpeech.length && guard++ < 40) {
        let cut = -1;
        for (let i = 0; i < pendingSpeech.length; i++) {
          if ('。！？!?'.includes(pendingSpeech[i])) {
            cut = i;
            break;
          }
        }
        if (cut === -1) {
          if (force) cut = pendingSpeech.length - 1;
          else if (pendingSpeech.length > FIRST_CHUNK) {
            const comma = pendingSpeech.lastIndexOf('，', FIRST_CHUNK);
            cut = comma > 40 ? comma : FIRST_CHUNK - 1;
          } else break;
        }
        const piece = pendingSpeech.slice(0, cut + 1).trim();
        pendingSpeech = pendingSpeech.slice(cut + 1).trimStart();
        if (piece) enqueueSentence(piece);
      }
      if (force && pendingSpeech.trim()) {
        enqueueSentence(pendingSpeech.trim());
        pendingSpeech = '';
      }
    }

    /**
     * Consume speech-ready text from `assistantFullText` since `spokenUpTo`.
     * Complete lines are cleaned whole; a trailing partial line is cut at its
     * last sentence terminator, so the first sentence does not wait for the
     * paragraph (or the turn) to end. `force` flushes whatever is left.
     */
    function flushSpeech(force) {
      if (!call.active || call.paused) return;
      const text = assistantFullText;
      let consumed = spokenUpTo;

      for (;;) {
        const nl = text.indexOf('\n', consumed);
        if (nl === -1) break;
        const line = text.slice(consumed, nl);
        consumed = nl + 1;
        const spoken = cleanSpeech ? cleanStreamLine(line) : line.trim();
        if (spoken) pendingSpeech += (pendingSpeech ? ' ' : '') + spoken;
        drainSpeech(false);
      }

      const tail = text.slice(consumed);
      if (tail) {
        // A partial fence or table row must reach its end before it can be
        // classified; speaking it early would read source code aloud.
        const blocking = /^\s*(```|~~~|\|)/.test(tail);
        let cut = -1;
        if (force) cut = tail.length - 1;
        else if (!blocking) {
          for (let i = 0; i < tail.length; i++) {
            if ('。！？!?'.includes(tail[i])) cut = i;
          }
        }
        if (cut >= 0) {
          const line = tail.slice(0, cut + 1);
          consumed += cut + 1;
          const spoken = cleanSpeech ? cleanStreamLine(line) : line.trim();
          if (spoken) pendingSpeech += (pendingSpeech ? ' ' : '') + spoken;
        }
      }

      spokenUpTo = consumed;
      drainSpeech(force);
    }

    function resetSpeechStream() {
      assistantGotText = false;
      assistantFullText = '';
      spokenUpTo = 0;
      pendingSpeech = '';
      spokeThisTurn = false;
      streamFence = false;
      streamTable = false;
    }

    /* ------------------------------------------------------------------ *
     * Audio out
     * ------------------------------------------------------------------ */

    function stopAudio() {
      if (!audioEl) return;
      try {
        audioEl._finish?.();
        audioEl.pause();
        audioEl.src = '';
      } catch {}
      audioEl = null;
    }

    function resetSpeechPlayback() {
      speechEpoch += 1;
      speechQueue = [];
      speechAbort.abort();
      speechAbort = new AbortController();
      stopAudio();
    }

    function enqueueSpeech(text) {
      const clean = String(text || '').replace(/\s+/g, ' ').trim();
      if (clean.length < 2) return;
      speechQueue.push({ text: clean, promise: null });
      pumpSpeech();
    }

    async function fetchSpeech(text, signal) {
      const response = await fetch(
        '/voice-call/tts?text=' + encodeURIComponent(text) + '&voice=' + encodeURIComponent(call.voice),
        { signal },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'HTTP ' + response.status);
      }
      return await response.blob();
    }

    async function pumpSpeech() {
      if (speechPumpRunning) return;
      speechPumpRunning = true;
      const epoch = speechEpoch;
      try {
        while (speechQueue.length && epoch === speechEpoch && call.active && !call.paused) {
          const item = speechQueue.shift();
          const next = speechQueue[0];
          if (next && !next.promise) next.promise = fetchSpeech(next.text, speechAbort.signal);
          const blob = await (item.promise || fetchSpeech(item.text, speechAbort.signal));
          if (epoch !== speechEpoch || !call.active || call.paused) break;
          await playBlob(blob);
        }
      } catch (err) {
        if (err?.name !== 'AbortError') set({ error: '朗读失败：' + (err?.message || err) });
      } finally {
        speechPumpRunning = false;
        if (epoch === speechEpoch && !speechQueue.length && turnDone && call.active && !call.paused) {
          turnDone = false;
          setTimeout(listenLoop, SPEECH_TAIL_MS);
        }
      }
    }

    async function playBlob(blob) {
      if (!call.active || call.paused) return;
      stopAudio();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.preservesPitch = true;
      audio.playbackRate = rate;
      audioEl = audio;
      try {
        await new Promise((resolve, reject) => {
          let settled = false;
          let timer = null;
          const finish = (error) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (error) {
              try {
                audio.pause();
              } catch {}
              reject(error);
            } else {
              resolve();
            }
          };
          audio._finish = finish;
          timer = setTimeout(() => finish(new Error('朗读超时')), 90000);
          audio.onended = () => finish();
          audio.onerror = () => finish(new Error('音频播放失败'));
          audio.play().catch((error) => finish(error));
        });
      } finally {
        if (audioEl === audio) audioEl = null;
        delete audio._finish;
        URL.revokeObjectURL(url);
      }
    }

    /* ------------------------------------------------------------------ *
     * Session events
     * ------------------------------------------------------------------ */

    function handleEntry(entry) {
      const event = entry.event;
      if (!event) return;
      if (/reasoning|thinking/i.test(String(event.type))) return;
      if (ignoreCurrentTurn) {
        if (event.type === 'turn/end') {
          ignoreCurrentTurn = false;
          turnDone = false;
          set({ phase: 'listening' });
          listenLoop();
        }
        return;
      }
      if (event.type === 'assistant/live-chunk') {
        const chunk = event.data && event.data.chunk;
        if (!chunk) return;
        if (chunk.type === 'block-start') {
          liveBlockTypes.set(chunk.index, chunk.blockType);
          return;
        }
        if (chunk.type === 'block-end') {
          liveBlockTypes.delete(chunk.index);
          return;
        }
        if (chunk.type === 'reasoning-delta') return;
        if (chunk.type === 'text-delta') {
          const blockType = chunk.blockType || liveBlockTypes.get(chunk.index);
          if (blockType === 'reasoning' || blockType === 'thinking') return;
          const text = chunk.text || '';
          if (text) {
            assistantGotText = true;
            assistantFullText += text;
            set({ phase: 'speaking' });
            if (!suppressTurnSpeech) flushSpeech(false);
          }
          return;
        }
        const text = chunkText(chunk);
        if (text) {
          assistantGotText = true;
          assistantFullText += text;
          set({ phase: 'speaking' });
          if (!suppressTurnSpeech) flushSpeech(false);
        }
        return;
      }
      if (event.type === 'turn/end') {
        turnDone = true;
        turnRunning = false;
        liveBlockTypes.clear();
        if (turnTimer) {
          clearTimeout(turnTimer);
          turnTimer = null;
        }
        if (!assistantGotText) {
          const text = lastAssistantText();
          if (text) assistantFullText += text;
        }
        const full = assistantFullText.trim();
        const speak = !suppressTurnSpeech;
        suppressTurnSpeech = false;
        if (speak) flushSpeech(true);
        // A reply with nothing speakable (code or a table only) still gets one
        // short line, so the call never looks stuck.
        if (speak && full && !spokeThisTurn) enqueueSentence('具体内容我放在消息里了。');
        const spoke = spokeThisTurn;
        pendingSpeech = '';
        resetSpeechStream();
        if (full) appendLine('assistant', full);
        if (!full || !speak || !spoke) {
          turnDone = false;
          set({ phase: 'listening' });
          listenLoop();
        }
      }
    }

    function attachEvents() {
      if (!binding) return;
      const source = binding.eventSource;
      let count = source.getSnapshot().entries.length;
      eventStart = count;
      let revision = -1;
      unsubscribeEvents = source.subscribe(() => {
        const snapshot = source.getSnapshot();
        if (snapshot.revision === revision) return;
        revision = snapshot.revision;
        if (snapshot.change && snapshot.change.kind === 'replace') {
          count = snapshot.entries.length;
          eventStart = count;
          return;
        }
        if (snapshot.entries.length < count) count = snapshot.entries.length;
        for (let i = count; i < snapshot.entries.length; i++) handleEntry(snapshot.entries[i]);
        count = snapshot.entries.length;
      });
    }

    /* ------------------------------------------------------------------ *
     * Settings
     * ------------------------------------------------------------------ */

    async function loadConfig() {
      try {
        const response = await fetch('/voice-call/config');
        const data = await response.json();
        rate = Number(data.rate) || rate;
        set({
          configured: Boolean(data.configured),
          keyMasked: data.keyMasked || '',
          voice: data.voice || call.voice,
          rate,
          voices: Array.isArray(data.voices) ? data.voices : [],
          usage: data.usage || null,
        });
      } catch (err) {
        set({ error: '读取语音配置失败：' + (err?.message || err) });
      }
    }

    async function saveKey(key) {
      const response = await fetch('/voice-call/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '保存失败');
      set({ configured: Boolean(data.configured), keyMasked: data.keyMasked || '', error: null });
      if (call.active && !call.paused) {
        set({ phase: 'listening' });
        listenLoop();
      }
    }

    function setVoice(voice) {
      set({ voice });
      fetch('/voice-call/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voice }),
      }).catch(() => {});
    }

    function setRate(next) {
      rate = next;
      set({ rate: next });
      if (audioEl) {
        audioEl.preservesPitch = true;
        audioEl.playbackRate = next;
      }
      fetch('/voice-call/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rate: next }),
      }).catch(() => {});
    }

    /* ------------------------------------------------------------------ *
     * Audio in
     * ------------------------------------------------------------------ */

    function base64(bytes) {
      let binary = '';
      const size = 0x8000;
      for (let i = 0; i < bytes.length; i += size) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + size));
      }
      return btoa(binary);
    }

    function encodeWav(samples, sampleRate) {
      const buffer = new ArrayBuffer(44 + samples.length * 2);
      const view = new DataView(buffer);
      const write = (offset, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
      };
      write(0, 'RIFF');
      view.setUint32(4, 36 + samples.length * 2, true);
      write(8, 'WAVE');
      write(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      write(36, 'data');
      view.setUint32(40, samples.length * 2, true);
      let offset = 44;
      for (let i = 0; i < samples.length; i++) {
        const value = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
        offset += 2;
      }
      return new Uint8Array(buffer);
    }

    function resample(input, inputRate, outputRate) {
      if (inputRate === outputRate) return input;
      const ratio = inputRate / outputRate;
      const length = Math.max(1, Math.round(input.length / ratio));
      const output = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        const position = i * ratio;
        const index = Math.floor(position);
        const next = Math.min(index + 1, input.length - 1);
        const fraction = position - index;
        output[i] = input[index] * (1 - fraction) + input[next] * fraction;
      }
      return output;
    }

    async function recordUtterance() {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境不支持麦克风');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const audioContext = new AudioContext();
      await audioContext.resume();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      // The analyser only produces data while it is pulled by a sink.
      const silent = audioContext.createGain();
      silent.gain.value = 0;
      analyser.connect(silent);
      silent.connect(audioContext.destination);
      const recorder = new MediaRecorder(stream);
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) chunks.push(event.data);
      };
      const stopped = new Promise((resolve) => {
        recorder.onstop = resolve;
      });
      recorder.start(200);
      const started = Date.now();
      let spoken = false;
      let lastVoice = started;
      let aboveSince = 0;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        try {
          recorder.stop();
        } catch {}
      };
      forceStopRecording = () => {
        spoken = true;
        finish();
      };
      const timer = setInterval(() => {
        const data = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const value = (data[i] - 128) / 128;
          sum += value * value;
        }
        const rms = Math.sqrt(sum / data.length);
        const now = Date.now();
        set({ level: Math.min(1, rms * 30) });
        if (now - started > 450) {
          if (rms > MIC_THRESHOLD) {
            if (!aboveSince) aboveSince = now;
            if (now - aboveSince > 220) {
              spoken = true;
              lastVoice = now;
            }
          } else {
            aboveSince = 0;
          }
        }
        if (!spoken && now - started > IDLE_MS) finish();
        else if (spoken && now - lastVoice > SILENCE_MS) finish();
        else if (now - started > MAX_RECORD_MS) finish();
      }, 100);
      await stopped;
      clearInterval(timer);
      forceStopRecording = null;
      stream.getTracks().forEach((track) => track.stop());
      let wav = null;
      if (spoken && chunks.length) {
        const blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' });
        const array = await blob.arrayBuffer();
        const decoded = await audioContext.decodeAudioData(array);
        const samples = resample(decoded.getChannelData(0), decoded.sampleRate, 16000);
        wav = encodeWav(samples, 16000);
      }
      await audioContext.close().catch(() => {});
      set({ level: 0 });
      return wav ? base64(wav) : null;
    }

    async function listenLoop() {
      if (!call.active || call.paused || listening || !binding || !call.configured) return;
      const gen = generation;
      listening = true;
      set({ phase: 'listening', error: null });
      try {
        const audio = await recordUtterance();
        // A teardown, pause or end-call during the recording invalidates this run.
        if (gen !== generation || !call.active || call.paused) {
          listening = false;
          return;
        }
        if (!audio) {
          listening = false;
          if (call.active && !call.paused) setTimeout(listenLoop, 250);
          return;
        }
        set({ phase: 'transcribing' });
        const response = await fetch('/voice-call/transcribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ audioBase64: audio, language: 'zh', instance: INSTANCE, boots: moduleBoot }),
        });
        const data = await response.json().catch(() => ({}));
        if (gen !== generation) {
          listening = false;
          return;
        }
        if (!response.ok) {
          const detail = data.error;
          throw new Error(
            typeof detail === 'string' ? detail : detail?.message || JSON.stringify(detail) || '语音识别失败',
          );
        }
        const raw = data.text;
        const text =
          typeof raw === 'string' ? raw.trim() : String(raw?.text ?? raw?.transcript ?? '').trim();
        if (!text) {
          listening = false;
          if (call.active && !call.paused) setTimeout(listenLoop, 250);
          return;
        }
        appendLine('user', text);
        resetSpeechStream();
        turnDone = false;
        ignoreCurrentTurn = false;
        set({ phase: 'thinking' });
        const useSteer = steerNext && turnRunning;
        if (useSteer) suppressTurnSpeech = false;
        const sent = await binding.session.prompt([{ type: 'text', text }], useSteer ? 'steer' : 'queue');
        if (gen !== generation) return;
        steerNext = false;
        turnRunning = true;
        if (!sent.ok) throw new Error(sent.error?.message || '发送失败');
        turnTimer = setTimeout(() => {
          turnTimer = null;
          if (!call.active) return;
          turnDone = true;
          if (speechQueue.length === 0) {
            turnDone = false;
            listenLoop();
          }
        }, 90000);
      } catch (err) {
        if (gen !== generation) {
          listening = false;
          return;
        }
        set({ phase: 'error', error: String(err?.message || err) });
        listening = false;
        return;
      }
      listening = false;
    }

    /* ------------------------------------------------------------------ *
     * Call lifecycle
     * ------------------------------------------------------------------ */

    function currentSessionId() {
      try {
        const snapshot = (sessionCtx || pluginCtx)?.uiSession?.current?.getSnapshot?.();
        return snapshot?.key || snapshot?.sessionId || null;
      } catch {
        return null;
      }
    }

    function teardown() {
      generation += 1;
      try {
        forceStopRecording?.();
      } catch {}
      stopAudio();
      if (turnTimer) clearTimeout(turnTimer);
      turnTimer = null;
      resetSpeechStream();
      if (unsubscribeEvents) {
        unsubscribeEvents();
        unsubscribeEvents = null;
      }
      try {
        reference?.release();
      } catch {}
      binding = null;
      reference = null;
      listening = false;
      speechQueue = [];
      speechAbort.abort();
      speechAbort = new AbortController();
      forceStopRecording = null;
      call = {
        ...call,
        active: false,
        prepared: false,
        sessionId: null,
        phase: 'idle',
        paused: false,
        expanded: false,
        error: null,
        level: 0,
      };
      for (const listener of listeners) listener();
    }

    function sessionApi() {
      return sessionCtx || pluginCtx;
    }

    /** Open the pre-call panel: configure voice, rate, cleaning and colour. */
    function openPrep() {
      set({ prepared: true, error: null });
      loadConfig();
    }

    function closePrep() {
      set({ prepared: false, error: null });
    }

    let starting = false;

    async function startCall(sessionId) {
      if (call.active || starting || !sessionId) return;
      const api = sessionApi();
      if (!api?.sessions?.retain) {
        set({ prepared: true, error: '会话服务未就绪，无法开始通话' });
        return;
      }
      starting = true;
      try {
        await loadConfig();
        if (!call.configured) {
          set({ prepared: true, error: '先填一个阿里云 API Key，再开始通话' });
          return;
        }
      } finally {
        starting = false;
      }
      generation += 1;
      const gen = generation;
      stopAudio();
      speechQueue = [];
      speechAbort.abort();
      speechAbort = new AbortController();
      resetSpeechStream();
      set({
        active: true,
        prepared: false,
        sessionId,
        phase: 'connecting',
        error: null,
        expanded: true,
        paused: false,
        startedAt: Date.now(),
        lines: [],
        cleanSpeech,
      });
      liveBlockTypes.clear();
      turnRunning = false;
      steerNext = false;
      suppressTurnSpeech = false;
      try {
        reference = api.sessions.retain(sessionId, { source: 'controllerOperation' });
        binding = await reference.ready;
        if (gen !== generation) return;
        attachEvents();
        set({ phase: 'listening' });
        listenLoop();
      } catch (err) {
        if (gen !== generation) return;
        set({ phase: 'error', error: '开始通话失败：' + (err?.message || err) });
      }
    }

    function endCall() {
      generation += 1;
      try {
        forceStopRecording?.();
      } catch {}
      stopAudio();
      if (turnTimer) clearTimeout(turnTimer);
      turnTimer = null;
      resetSpeechStream();
      if (unsubscribeEvents) {
        unsubscribeEvents();
        unsubscribeEvents = null;
      }
      try {
        reference?.release();
      } catch {}
      binding = null;
      reference = null;
      listening = false;
      speechQueue = [];
      speechAbort.abort();
      speechAbort = new AbortController();
      forceStopRecording = null;
      set({
        active: false,
        prepared: false,
        sessionId: null,
        phase: 'idle',
        paused: false,
        expanded: false,
        error: null,
        level: 0,
      });
    }

    function togglePause() {
      const paused = !call.paused;
      set({ paused });
      if (paused) stopAudio();
      else if (call.active) {
        set({ phase: 'listening' });
        listenLoop();
      }
    }

    /** “打断” stops the reply being read out. It never stops the agent. */
    function stopSpeaking() {
      if (!call.active) return;
      resetSpeechPlayback();
      // Drop whatever of this reply has not been spoken yet.
      pendingSpeech = '';
      spokenUpTo = assistantFullText.length;
      turnDone = false;
      if (turnRunning) {
        suppressTurnSpeech = true;
        steerNext = true;
      }
      set({ phase: 'listening', error: null });
      listenLoop();
    }

    /* ------------------------------------------------------------------ *
     * View
     * ------------------------------------------------------------------ */

    const S = {
      wrap: { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 30 },
      launcher: {
        position: 'absolute',
        right: 22,
        bottom: 92,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '9px 14px',
        borderRadius: 999,
        border: '1px solid ' + DEFAULT_ACCENT,
        background: DEFAULT_ACCENT,
        boxShadow: '0 8px 20px rgba(77, 107, 254, 0.35)',
        color: '#FFFFFF',
        font: '600 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif',
        cursor: 'pointer',
        pointerEvents: 'auto',
      },
      pill: {
        position: 'absolute',
        top: 64,
        right: 18,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 999,
        background: TOKENS.surface,
        border: '1px solid ' + TOKENS.border,
        boxShadow: '0 8px 24px rgba(31, 41, 55, 0.14)',
        color: TOKENS.ink,
        font: FONT,
        pointerEvents: 'auto',
      },
      dot: { width: 8, height: 8, borderRadius: 999, flex: '0 0 auto' },
      clock: { color: TOKENS.muted, fontVariantNumeric: 'tabular-nums' },
      card: {
        position: 'absolute',
        top: 110,
        right: 18,
        width: 344,
        maxHeight: '64vh',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
        padding: 12,
        borderRadius: 14,
        background: TOKENS.surface,
        border: '1px solid ' + TOKENS.border,
        boxShadow: '0 16px 40px rgba(31, 41, 55, 0.16)',
        color: TOKENS.ink,
        font: FONT,
        pointerEvents: 'auto',
      },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      btn: {
        border: '1px solid ' + TOKENS.border,
        background: TOKENS.surfaceSoft,
        color: TOKENS.ink,
        borderRadius: 8,
        padding: '3px 9px',
        cursor: 'pointer',
        font: 'inherit',
        whiteSpace: 'nowrap',
      },
      primary: {
        border: '1px solid ' + DEFAULT_ACCENT,
        background: DEFAULT_ACCENT,
        color: '#FFFFFF',
        borderRadius: 8,
        padding: '5px 12px',
        cursor: 'pointer',
        font: 'inherit',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      },
      close: {
        border: 0,
        background: 'transparent',
        color: TOKENS.muted,
        cursor: 'pointer',
        font: 'inherit',
        lineHeight: 1,
      },
      lines: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 210, overflowY: 'auto' },
      line: { padding: '6px 8px', borderRadius: 8, lineHeight: 1.5, whiteSpace: 'pre-wrap' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 9px',
        borderRadius: 8,
        border: '1px solid ' + TOKENS.border,
        background: TOKENS.surfaceSoft,
        color: TOKENS.ink,
        font: 'inherit',
      },
      label: { display: 'flex', alignItems: 'center', gap: 6, color: TOKENS.muted },
      meter: { flex: 1, height: 5, borderRadius: 999, background: TOKENS.brandSoft, overflow: 'hidden' },
      meterFill: { height: '100%', borderRadius: 999, background: DEFAULT_ACCENT, transition: 'width .08s linear' },
      hint: { color: TOKENS.muted, fontSize: 10.5 },
    };

    const PHASES = {
      connecting: '连接会话…',
      listening: '在听…',
      transcribing: '识别中…',
      thinking: '思考中…',
      speaking: '朗读中…',
      'need-key': '需要 API Key',
      error: '出错',
      idle: '空闲',
    };

    function CallCard() {
      const state = useCall();
      const [now, setNow] = useState(Date.now());
      const [key, setKey] = useState('');
      const [busy, setBusy] = useState(false);

      useEffect(() => {
        if (!state.active) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [state.active]);

      if (!state.active) return null;

      const accent = normalizeAccent(state.accent);
      const elapsed = Math.max(0, Math.floor((now - state.startedAt) / 1000));
      const clock = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
      const save = async () => {
        setBusy(true);
        try {
          await saveKey(key.trim());
          setKey('');
        } catch (err) {
          set({ error: String(err.message || err) });
        } finally {
          setBusy(false);
        }
      };

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: S.pill },
          h('span', { style: { ...S.dot, background: state.paused ? TOKENS.warn : accent } }),
          h('span', { style: { fontWeight: 600 } }, state.paused ? '已暂停' : '通话中'),
          h('span', { style: S.clock }, clock),
          h('button', { type: 'button', style: S.btn, onClick: togglePause }, state.paused ? '继续' : '暂停'),
          h(
            'button',
            { type: 'button', style: S.btn, onClick: () => set({ expanded: !state.expanded }) },
            state.expanded ? '收起' : '展开',
          ),
          h('button', { type: 'button', style: S.close, title: '结束通话', onClick: endCall }, '✕'),
        ),
        state.expanded
          ? h(
              'div',
              { style: S.card },
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                h('strong', { style: { fontSize: 13 } }, '语音通话'),
                h('span', { style: { color: accent, fontWeight: 500 } }, PHASES[state.phase] || '空闲'),
              ),
              h('div', { style: S.hint }, '绑定会话 ' + String(state.sessionId || '').slice(0, 18) + '…'),
              state.error ? h('div', { style: { color: TOKENS.danger } }, state.error) : null,
              h(
                'div',
                { style: S.lines },
                state.lines.length
                  ? state.lines.map((line, index) =>
                      h(
                        'div',
                        {
                          key: index,
                          style: {
                            ...S.line,
                            color: line.role === 'user' ? TOKENS.ink : TOKENS.ink,
                            background: line.role === 'user' ? TOKENS.brandSoft : TOKENS.surfaceSoft,
                          },
                        },
                        h(
                          'span',
                          {
                            style: {
                              color: line.role === 'user' ? accent : TOKENS.muted,
                              fontWeight: 600,
                            },
                          },
                          line.role === 'user' ? '你：' : '助手：',
                        ),
                        line.text,
                      ),
                    )
                  : h('div', { style: { color: TOKENS.muted } }, '说话后，转写和回答会显示在这里。'),
              ),
              state.voice || state.voices.length
                ? h(
                    'div',
                    { style: S.row },
                    h('span', { style: { ...S.label, flex: '0 0 auto' } }, '音色'),
                    h(
                      'select',
                      {
                        value: state.voice,
                        onChange: (event) => setVoice(event.target.value),
                        style: { ...S.input, flex: 1 },
                      },
                      state.voices.map((voice) =>
                        h('option', { key: voice.id, value: voice.id }, `${voice.label}（${voice.desc}）`),
                      ),
                    ),
                  )
                : null,
              h(
                'label',
                { style: S.label },
                '语速',
                h('input', {
                  type: 'range',
                  min: 0.7,
                  max: 1.5,
                  step: 0.05,
                  value: state.rate,
                  onChange: (event) => setRate(Number(event.target.value)),
                  style: { flex: 1, accentColor: accent },
                }),
                h('span', { style: { width: 36, textAlign: 'right' } }, Number(state.rate).toFixed(2) + '×'),
              ),
              h(
                'label',
                { style: { ...S.label, justifyContent: 'space-between', cursor: 'pointer' } },
                h('span', null, '朗读清洗（跳过表格/代码）'),
                h('input', {
                  type: 'checkbox',
                  checked: state.cleanSpeech !== false,
                  onChange: (event) => setCleanSpeech(event.target.checked),
                  style: { accentColor: accent },
                }),
              ),
              h(
                'div',
                { style: S.row },
                h('span', { style: S.label }, '麦克风 ' + Math.round((state.level || 0) * 100) + '%'),
                h(
                  'div',
                  { style: S.meter },
                  h('div', {
                    style: {
                      ...S.meterFill,
                      background: accent,
                      width: Math.round((state.level || 0) * 100) + '%',
                    },
                  }),
                ),
                h(
                  'button',
                  { type: 'button', style: S.btn, onClick: () => forceStopRecording?.() },
                  '说完',
                ),
                h('button', { type: 'button', style: S.btn, onClick: stopSpeaking }, '打断'),
              ),
              h(
                'div',
                { style: S.row },
                h('input', {
                  type: 'password',
                  value: key,
                  placeholder: state.configured
                    ? `已配置 ${state.keyMasked}，输入新 Key 可替换`
                    : '阿里云 API Key（sk-...）',
                  onChange: (event) => setKey(event.target.value),
                  style: { ...S.input, flex: 1 },
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    style: { ...S.primary, background: accent, borderColor: accent, opacity: busy ? 0.6 : 1 },
                    disabled: busy,
                    onClick: save,
                  },
                  busy ? '测试中…' : '保存',
                ),
              ),
              state.usage
                ? h(
                    'div',
                    { style: S.hint },
                    `本月 ${state.usage.chars || 0} 字符 ≈ ¥${(((state.usage.chars || 0) / 10000) * 0.8).toFixed(2)}`,
                  )
                : null,
            )
          : null,
      );
    }

    function AccentPicker(props) {
      const accent = normalizeAccent(props.accent);
      return h(
        'div',
        { style: { ...S.row, flexWrap: 'wrap', gap: 6 } },
        h('span', { style: { ...S.label, flex: '0 0 auto' } }, '按钮颜色'),
        ACCENTS.map((color) =>
          h('button', {
            key: color,
            type: 'button',
            title: color,
            'aria-label': color,
            onClick: () => props.onChange(color),
            style: {
              width: 18,
              height: 18,
              padding: 0,
              borderRadius: 999,
              cursor: 'pointer',
              background: color,
              border: color.toLowerCase() === accent ? '2px solid ' + TOKENS.ink : '1px solid ' + TOKENS.border,
            },
          }),
        ),
        h('input', {
          type: 'color',
          value: accent,
          title: '自定义颜色',
          onChange: (event) => props.onChange(event.target.value),
          style: {
            width: 26,
            height: 20,
            padding: 0,
            border: '1px solid ' + TOKENS.border,
            borderRadius: 6,
            background: 'transparent',
            cursor: 'pointer',
          },
        }),
      );
    }

    function PrepPanel() {
      const state = useCall();
      const [key, setKey] = useState('');
      const [busy, setBusy] = useState(false);
      if (!state.prepared || state.active) return null;
      const accent = normalizeAccent(state.accent);
      const sessionId = currentSessionId();

      const save = async () => {
        if (!key.trim()) return;
        setBusy(true);
        try {
          await saveKey(key.trim());
          setKey('');
        } catch (err) {
          set({ error: String(err.message || err) });
        } finally {
          setBusy(false);
        }
      };

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: { ...S.card, width: 360 } },
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('strong', { style: { fontSize: 13 } }, '语音通话'),
            h('span', { style: { color: accent, fontWeight: 500 } }, '准备'),
          ),
          h(
            'div',
            { style: S.hint },
            sessionId ? '将在当前会话开始：' + String(sessionId).slice(0, 18) + '…' : '还没打开会话，先打开一个会话',
          ),
          state.error ? h('div', { style: { color: TOKENS.danger } }, state.error) : null,
          state.voices.length
            ? h(
                'div',
                { style: S.row },
                h('span', { style: { ...S.label, flex: '0 0 auto' } }, '音色'),
                h(
                  'select',
                  {
                    value: state.voice,
                    onChange: (event) => setVoice(event.target.value),
                    style: { ...S.input, flex: 1 },
                  },
                  state.voices.map((voice) =>
                    h('option', { key: voice.id, value: voice.id }, `${voice.label}（${voice.desc}）`),
                  ),
                ),
              )
            : null,
          h(
            'label',
            { style: S.label },
            '语速',
            h('input', {
              type: 'range',
              min: 0.7,
              max: 1.5,
              step: 0.05,
              value: state.rate,
              onChange: (event) => setRate(Number(event.target.value)),
              style: { flex: 1, accentColor: accent },
            }),
            h('span', { style: { width: 36, textAlign: 'right' } }, Number(state.rate).toFixed(2) + '×'),
          ),
          h(
            'label',
            { style: { ...S.label, justifyContent: 'space-between', cursor: 'pointer' } },
            h('span', null, '朗读清洗（跳过表格/代码）'),
            h('input', {
              type: 'checkbox',
              checked: state.cleanSpeech !== false,
              onChange: (event) => setCleanSpeech(event.target.checked),
              style: { accentColor: accent },
            }),
          ),
          h(AccentPicker, { accent, onChange: setAccent }),
          h(
            'div',
            { style: S.row },
            h('input', {
              type: 'password',
              value: key,
              placeholder: state.configured
                ? `已配置 ${state.keyMasked}，输入新 Key 可替换`
                : '阿里云 API Key（sk-...）',
              onChange: (event) => setKey(event.target.value),
              style: { ...S.input, flex: 1 },
            }),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.primary, background: accent, borderColor: accent, opacity: busy ? 0.6 : 1 },
                disabled: busy,
                onClick: save,
              },
              busy ? '测试中…' : '保存',
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 } },
            h('button', { type: 'button', style: S.btn, onClick: closePrep }, '取消'),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.primary, background: accent, borderColor: accent },
                onClick: () => {
                  const id = currentSessionId();
                  if (!id) {
                    set({ error: '先打开一个会话' });
                    return;
                  }
                  startCall(id);
                },
              },
              '开始通话',
            ),
          ),
        ),
      );
    }

    function Launcher() {
      const state = useCall();
      const [notice, setNotice] = useState('');
      useEffect(() => {
        if (!notice) return undefined;
        const timer = setTimeout(() => setNotice(''), 1800);
        return () => clearTimeout(timer);
      }, [notice]);
      if (state.active || state.prepared) return null;
      const accent = normalizeAccent(state.accent);
      return h(
        'div',
        { style: S.wrap },
        notice
          ? h('div', { style: { ...S.pill, bottom: 138, top: 'auto', color: TOKENS.muted } }, notice)
          : null,
        h(
          'button',
          {
            type: 'button',
            style: {
              ...S.launcher,
              background: accent,
              borderColor: accent,
              boxShadow: '0 8px 20px ' + rgba(accent, 0.35),
            },
            title: '打开语音通话设置',
            onClick: () => {
              const api = sessionApi();
              if (!api?.sessions?.retain || !api?.uiSession) {
                setNotice('会话服务未就绪');
                return;
              }
              if (!currentSessionId()) {
                setNotice('先打开一个会话');
                return;
              }
              openPrep();
            },
          },
          h('span', { 'aria-hidden': true }, '🎙'),
          '通话',
        ),
      );
    }

    function Overlay() {
      const state = useCall();
      if (state.active) return h(CallCard);
      if (state.prepared) return h(PrepPanel);
      return h(Launcher);
    }

    return {
      name: 'voice-call',
      // Only the slot registry is required to mount the widget. Session services
      // are captured when present, so a future rename degrades to a message
      // instead of a missing button.
      inject: ['slots'],
      apply(ctx) {
        pluginCtx = ctx;
        moduleBoot = 1;
        try {
          window.__dshVoiceCallBoots = (window.__dshVoiceCallBoots || 0) + 1;
          moduleBoot = window.__dshVoiceCallBoots;
        } catch {}

        // Exactly one live instance may own the microphone and the widget.
        // Hot reload or a stale copy from an earlier install would otherwise
        // record the same sentence twice and send it twice.
        const self = { token: {}, dispose: null };
        self.dispose = () => {
          generation += 1;
          try {
            disposeSlot?.();
          } catch {}
          disposeSlot = null;
          teardown();
          if (window.__dshVoiceCallOwner === self) window.__dshVoiceCallOwner = null;
          if (window.__dshVoiceCallCleanup === self.dispose) window.__dshVoiceCallCleanup = null;
        };
        const previous = window.__dshVoiceCallOwner;
        if (previous && previous !== self && typeof previous.dispose === 'function') {
          try {
            previous.dispose();
          } catch {}
        }
        // Versions before the ownership token exposed this global cleanup.
        try {
          window.__dshVoiceCallCleanup?.();
        } catch {}
        window.__dshVoiceCallOwner = self;
        window.__dshVoiceCallCleanup = self.dispose;

        ctx.effect(() => () => self.dispose(), 'dsh-voice-call: dispose call');
        ctx.inject(['sessions', 'uiSession'], (scoped) => {
          sessionCtx = scoped;
          scoped.effect(
            () => () => {
              if (sessionCtx === scoped) sessionCtx = null;
            },
            'dsh-voice-call: release session services',
          );
        });
        disposeSlot = ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-voice-call', order: 900 }, Overlay),
        );
      },
    };
  },
});
