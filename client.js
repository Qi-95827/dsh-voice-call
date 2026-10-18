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
    // Voice barge-in: ignore the first moments of playback, then require a
    // sustained voice before stopping the reading.
    const BARGE_GRACE_MS = 400;
    const BARGE_FRAMES = 5;
    const BARGE_CONFIRM_MS = 2500;

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

    /**
     * Widget copy. `zh` is the fallback for any key missing from `en`, so a new
     * string never renders as a bare key.
     */
    const STRINGS = {
      zh: {
        'app.title': '语音通话',
        'app.setup': '准备',
        'lang': '语言',
        'launcher.label': '通话',
        'launcher.title': '打开语音通话设置',
        'notice.noService': '会话服务未就绪',
        'notice.noSession': '先打开一个会话',
        'prep.session': '将在当前会话开始：{id}…',
        'prep.noSession': '还没打开会话，先打开一个会话',
        'voice': '音色',
        'rate': '语速',
        'clean': '朗读清洗（跳过表格/代码）',
        'bargeIn': '语音打断（我说话就停止朗读）',
        'settings': '配置',
        'settings.hide': '收起配置',
        'color': '按钮颜色',
        'color.custom': '自定义颜色',
        'key.configured': '已配置 {mask}',
        'key.hint': '粘贴新 Key 可替换',
        'key.placeholder': '阿里云 API Key（sk-...）',
        'key.testing': '测试中…',
        'save': '保存',
        'cancel': '取消',
        'start': '开始通话',
        'call.active': '通话中',
        'call.paused': '已暂停',
        'pause': '暂停',
        'resume': '继续',
        'collapse': '收起',
        'expand': '展开',
        'end': '结束通话',
        'session.bound': '绑定会话 {id}…',
        'lines.empty': '说话后，转写和回答会显示在这里。',
        'role.user': '你：',
        'role.assistant': '助手：',
        'mic': '麦克风 {n}%',
        'send': '说完',
        'interrupt': '打断',
        'usage': '本月 {n} 字符 ≈ ¥{cost}',
        'speech.fallback': '具体内容我放在消息里了。',
        'speech.link': '链接',
        'phase.connecting': '连接会话…',
        'phase.listening': '在听…',
        'phase.transcribing': '识别中…',
        'phase.thinking': '思考中…',
        'phase.speaking': '朗读中…',
        'phase.error': '出错',
        'phase.idle': '空闲',
        'error.tts': '朗读失败：{message}',
        'error.ttsTimeout': '朗读超时',
        'error.audio': '音频播放失败',
        'error.config': '读取语音配置失败：{message}',
        'error.save': '保存失败',
        'error.mic': '当前环境不支持麦克风',
        'error.asr': '语音识别失败',
        'error.send': '发送失败',
        'error.start': '开始通话失败：{message}',
        'error.noService': '会话服务未就绪，无法开始通话',
        'error.needKey': '先填一个阿里云 API Key，再开始通话',
      },
      en: {
        'app.title': 'Voice call',
        'app.setup': 'Setup',
        'lang': 'Language',
        'launcher.label': 'Call',
        'launcher.title': 'Open voice call settings',
        'notice.noService': 'Session service is not ready',
        'notice.noSession': 'Open a session first',
        'prep.session': 'Starts in this session: {id}…',
        'prep.noSession': 'No session open — open one first',
        'voice': 'Voice',
        'rate': 'Rate',
        'clean': 'Skip code and tables when reading',
        'bargeIn': 'Stop reading when I speak',
        'settings': 'Settings',
        'settings.hide': 'Hide settings',
        'color': 'Button colour',
        'color.custom': 'Custom colour',
        'key.configured': 'Key set: {mask}',
        'key.hint': 'Paste a new key to replace',
        'key.placeholder': 'Alibaba Cloud API key (sk-...)',
        'key.testing': 'Testing…',
        'save': 'Save',
        'cancel': 'Cancel',
        'start': 'Start call',
        'call.active': 'In call',
        'call.paused': 'Paused',
        'pause': 'Pause',
        'resume': 'Resume',
        'collapse': 'Collapse',
        'expand': 'Expand',
        'end': 'End call',
        'session.bound': 'Bound session {id}…',
        'lines.empty': 'Speak, and the transcript appears here.',
        'role.user': 'You: ',
        'role.assistant': 'Assistant: ',
        'mic': 'Mic {n}%',
        'send': 'Done',
        'interrupt': 'Stop reading',
        'usage': '{n} chars this month ≈ ¥{cost}',
        'speech.fallback': "I've put the details in the message.",
        'speech.link': 'link',
        'phase.connecting': 'Connecting…',
        'phase.listening': 'Listening…',
        'phase.transcribing': 'Transcribing…',
        'phase.thinking': 'Thinking…',
        'phase.speaking': 'Reading aloud…',
        'phase.error': 'Error',
        'phase.idle': 'Idle',
        'error.tts': 'Speech failed: {message}',
        'error.ttsTimeout': 'Speech timed out',
        'error.audio': 'Audio playback failed',
        'error.config': 'Failed to read voice settings: {message}',
        'error.save': 'Save failed',
        'error.mic': 'This environment has no microphone',
        'error.asr': 'Speech recognition failed',
        'error.send': 'Failed to send',
        'error.start': 'Could not start the call: {message}',
        'error.noService': 'Session service is not ready, cannot start the call',
        'error.needKey': 'Add an Alibaba Cloud API key before starting the call',
      },
    };

    let storedLang = 'zh';
    try {
      storedLang = localStorage.getItem('dsh-voice-call-lang') === 'en' ? 'en' : 'zh';
    } catch {}

    function t(key, vars) {
      const table = STRINGS[call.lang] || STRINGS.zh;
      let text = table[key];
      if (text === undefined) text = STRINGS.zh[key];
      if (text === undefined) return key;
      if (vars) {
        for (const name of Object.keys(vars)) {
          text = text.split('{' + name + '}').join(String(vars[name]));
        }
      }
      return text;
    }

    function setLang(value) {
      const lang = value === 'en' ? 'en' : 'zh';
      set({ lang });
      try {
        localStorage.setItem('dsh-voice-call-lang', lang);
      } catch {}
    }

    let storedBargeIn = false;
    try {
      storedBargeIn = localStorage.getItem('dsh-voice-call-barge-in') === '1';
    } catch {}

    function setBargeIn(value) {
      set({ bargeIn: Boolean(value) });
      try {
        localStorage.setItem('dsh-voice-call-barge-in', value ? '1' : '0');
      } catch {}
      if (!value) stopBargeWatch();
    }

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
      configReady: false,
      keyMasked: '',
      voices: [],
      usage: null,
      level: 0,
      cleanSpeech: true,
      accent: storedAccent,
      lang: storedLang,
      bargeIn: storedBargeIn,
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
        .replace(/https?:\/\/\S+/g, t('speech.link'))
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
      speechSuspended = false;
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

    /* ------------------------------------------------------------------ *
     * Voice barge-in
     * ------------------------------------------------------------------ */

    let speechSuspended = false;
    let resumeAfterSilence = false;
    let bargeWatcher = null;
    let echoFloor = 0;
    let aboveFrames = 0;

    function stopBargeWatch() {
      if (bargeWatcher) {
        clearInterval(bargeWatcher);
        bargeWatcher = null;
      }
      aboveFrames = 0;
    }

    function startBargeWatch() {
      if (!call.bargeIn || bargeWatcher) return;
      if (!mic) {
        ensureMic()
          .then(() => {
            if (call.bargeIn && !bargeWatcher && mic) startBargeWatch();
          })
          .catch(() => {});
        return;
      }
      const startedAt = Date.now();
      echoFloor = 0;
      aboveFrames = 0;
      bargeWatcher = setInterval(() => {
        if (!call.active || call.paused || !call.bargeIn || speechSuspended) {
          if (!call.active || call.paused || !call.bargeIn) stopBargeWatch();
          return;
        }
        // Nothing queued and nothing playing means this speech round is over.
        if (!audioEl && !speechQueue.length) {
          stopBargeWatch();
          return;
        }
        if (Date.now() - startedAt < BARGE_GRACE_MS) return;
        if (!mic) return;
        const rms = readRms(mic.analyser);
        // During playback the echo of our own voice raises the floor; requiring
        // several frames well above it favours missing a barge-in over
        // stopping on playback alone.
        const threshold = Math.max(MIC_THRESHOLD * 1.8, echoFloor * 2.5);
        if (rms > threshold) {
          aboveFrames += 1;
          if (aboveFrames >= BARGE_FRAMES) onBargeIn();
        } else {
          aboveFrames = 0;
          echoFloor = echoFloor * 0.9 + rms * 0.1;
        }
      }, 50);
    }

    /** Pause the current chunk but keep the queue, so a false trigger resumes. */
    function suspendSpeech() {
      if (!speechQueue.length && !audioEl) return false;
      speechSuspended = true;
      if (audioEl) {
        try {
          audioEl.pause();
        } catch {}
      }
      return true;
    }

    function resumeSpeech() {
      if (!call.active || call.paused) return;
      speechSuspended = false;
      if (audioEl) {
        audioEl.play().catch(() => {});
        return;
      }
      if (speechQueue.length) pumpSpeech();
    }

    function dropSuspendedSpeech() {
      speechSuspended = false;
      resumeAfterSilence = false;
      resetSpeechPlayback();
    }

    /** The user started speaking while the reply was being read. */
    function onBargeIn() {
      if (!call.active || call.paused || listening) return;
      stopBargeWatch();
      if (!suspendSpeech()) return;
      resumeAfterSilence = true;
      if (turnRunning) {
        suppressTurnSpeech = true;
        steerNext = true;
      }
      set({ phase: 'listening', error: null });
      listenLoop({ confirm: BARGE_CONFIRM_MS });
    }

    async function pumpSpeech() {
      if (speechPumpRunning) return;
      speechPumpRunning = true;
      const epoch = speechEpoch;
      if (!call.bargeIn) releaseMic();
      else startBargeWatch();
      try {
        while (speechQueue.length && epoch === speechEpoch && call.active && !call.paused) {
          if (speechSuspended) break;
          // Keep the item in the queue until it is really about to play, so a
          // suspension during the fetch does not lose a chunk.
          const item = speechQueue[0];
          const next = speechQueue[1];
          if (next && !next.promise) next.promise = fetchSpeech(next.text, speechAbort.signal);
          const blob = await (item.promise || fetchSpeech(item.text, speechAbort.signal));
          if (epoch !== speechEpoch || !call.active || call.paused || speechSuspended) break;
          speechQueue.shift();
          await playBlob(blob);
        }
      } catch (err) {
        if (err?.name !== 'AbortError') set({ error: t('error.tts', { message: err?.message || err }) });
      } finally {
        speechPumpRunning = false;
        stopBargeWatch();
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
          timer = setTimeout(() => finish(new Error(t('error.ttsTimeout'))), 90000);
          audio.onended = () => finish();
          audio.onerror = () => finish(new Error(t('error.audio')));
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
        if (speak && full && !spokeThisTurn) enqueueSentence(t('speech.fallback'));
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
          configReady: true,
          keyMasked: data.keyMasked || '',
          voice: data.voice || call.voice,
          rate,
          voices: Array.isArray(data.voices) ? data.voices : [],
          usage: data.usage || null,
        });
      } catch (err) {
        set({ error: t('error.config', { message: err?.message || err }), configReady: true });
      }
    }

    async function saveKey(key) {
      const response = await fetch('/voice-call/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || t('error.save'));
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

    /* ------------------------------------------------------------------ *
     * Microphone
     * ------------------------------------------------------------------ */

    // One stream and one AudioContext for the whole call: it removes the
    // 100-300 ms device setup from every turn and gives the barge-in watcher an
    // analyser to read while audio is playing.
    let mic = null;

    async function ensureMic() {
      if (mic) {
        if (mic.context.state === 'suspended') await mic.context.resume().catch(() => {});
        return mic;
      }
      if (!navigator.mediaDevices?.getUserMedia) throw new Error(t('error.mic'));
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const context = new AudioContext();
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      // The analyser only produces data while it is pulled by a sink.
      const sink = context.createGain();
      sink.gain.value = 0;
      analyser.connect(sink);
      sink.connect(context.destination);
      mic = { stream, context, analyser, source, sink };
      return mic;
    }

    function releaseMic() {
      stopBargeWatch();
      if (!mic) return;
      try {
        mic.stream.getTracks().forEach((track) => track.stop());
      } catch {}
      try {
        mic.context.close();
      } catch {}
      mic = null;
    }

    function readRms(analyser) {
      const data = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const value = (data[i] - 128) / 128;
        sum += value * value;
      }
      return Math.sqrt(sum / data.length);
    }

    async function recordUtterance(idleMs = IDLE_MS, silenceMs = SILENCE_MS) {
      const { stream, context, analyser } = await ensureMic();
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
        const rms = readRms(analyser);
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
        if (!spoken && now - started > idleMs) finish();
        else if (spoken && now - lastVoice > silenceMs) finish();
        else if (now - started > MAX_RECORD_MS) finish();
      }, 100);
      await stopped;
      clearInterval(timer);
      forceStopRecording = null;
      let wav = null;
      if (spoken && chunks.length) {
        const blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' });
        const array = await blob.arrayBuffer();
        const decoded = await context.decodeAudioData(array);
        const samples = resample(decoded.getChannelData(0), decoded.sampleRate, 16000);
        wav = encodeWav(samples, 16000);
      }
      set({ level: 0 });
      return wav ? base64(wav) : null;
    }

    async function listenLoop(options = {}) {
      if (!call.active || call.paused || listening || !binding || !call.configured) return;
      const gen = generation;
      listening = true;
      set({ phase: 'listening', error: null });
      try {
        const audio = await recordUtterance(options.confirm || IDLE_MS);
        // A teardown, pause or end-call during the recording invalidates this run.
        if (gen !== generation || !call.active || call.paused) {
          listening = false;
          return;
        }
        if (!audio) {
          listening = false;
          if (resumeAfterSilence) {
            // A false trigger: nothing was said, so keep reading where we stopped.
            resumeAfterSilence = false;
            resumeSpeech();
            return;
          }
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
            typeof detail === 'string' ? detail : detail?.message || JSON.stringify(detail) || t('error.asr'),
          );
        }
        const raw = data.text;
        const text =
          typeof raw === 'string' ? raw.trim() : String(raw?.text ?? raw?.transcript ?? '').trim();
        if (!text) {
          listening = false;
          if (resumeAfterSilence) {
            resumeAfterSilence = false;
            resumeSpeech();
            return;
          }
          if (call.active && !call.paused) setTimeout(listenLoop, 250);
          return;
        }
        // A real utterance replaced the suspended reading: drop the rest of it.
        resumeAfterSilence = false;
        if (speechSuspended) dropSuspendedSpeech();
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
        if (!sent.ok) throw new Error(sent.error?.message || t('error.send'));
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
      stopBargeWatch();
      releaseMic();
      speechSuspended = false;
      resumeAfterSilence = false;
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
        set({ prepared: true, error: t('error.noService') });
        return;
      }
      starting = true;
      try {
        await loadConfig();
        if (!call.configured) {
          set({ prepared: true, error: t('error.needKey') });
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
        set({ phase: 'error', error: t('error.start', { message: err?.message || err }) });
      }
    }

    function endCall() {
      generation += 1;
      try {
        forceStopRecording?.();
      } catch {}
      stopAudio();
      stopBargeWatch();
      releaseMic();
      speechSuspended = false;
      resumeAfterSilence = false;
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
      stopBargeWatch();
      resumeAfterSilence = false;
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

    function phaseText(phase) {
      return t('phase.' + (phase || 'idle'));
    }

    /* ------------------------------------------------------------------ *
     * Settings block
     * ------------------------------------------------------------------ */

    function settingsOpen(state) {
      // A missing key always shows the form, so a first run cannot hide it.
      // Wait for the config read so a configured profile does not flash open.
      return Boolean(state.settingsOpen) || (state.configReady && !state.configured);
    }

    function toggleSettings() {
      set({ settingsOpen: !call.settingsOpen });
    }

    function voiceRow(state) {
      if (!state.voices.length) return null;
      return h(
        'div',
        { style: S.row },
        h('span', { style: { ...S.label, flex: '0 0 auto' } }, t('voice')),
        h(
          'select',
          {
            value: state.voice,
            onChange: (event) => setVoice(event.target.value),
            style: { ...S.input, flex: 1 },
          },
          state.voices.map((voice) =>
            h(
              'option',
              { key: voice.id, value: voice.id },
              state.lang === 'en'
                ? voice.descEn
                  ? `${voice.id} — ${voice.descEn}`
                  : voice.id
                : `${voice.label}（${voice.desc}）`,
            ),
          ),
        ),
      );
    }

    function rateRow(state, accent) {
      return h(
        'label',
        { style: S.label },
        t('rate'),
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
      );
    }

    function cleanRow(state, accent) {
      return h(
        'label',
        { style: { ...S.label, justifyContent: 'space-between', cursor: 'pointer' } },
        h('span', null, t('clean')),
        h('input', {
          type: 'checkbox',
          checked: state.cleanSpeech !== false,
          onChange: (event) => setCleanSpeech(event.target.checked),
          style: { accentColor: accent },
        }),
      );
    }

    function bargeRow(state, accent) {
      return h(
        'label',
        { style: { ...S.label, justifyContent: 'space-between', cursor: 'pointer' } },
        h('span', null, t('bargeIn')),
        h('input', {
          type: 'checkbox',
          checked: Boolean(state.bargeIn),
          onChange: (event) => setBargeIn(event.target.checked),
          style: { accentColor: accent },
        }),
      );
    }

    function keyRow(state, accent, keyCtl) {
      return h(
        'div',
        { style: S.row },
        h('input', {
          type: 'password',
          value: keyCtl.key,
          placeholder: state.configured
            ? t('key.configured', { mask: state.keyMasked })
            : t('key.placeholder'),
          title: t('key.hint'),
          onChange: (event) => keyCtl.setKey(event.target.value),
          style: { ...S.input, flex: 1 },
        }),
        h(
          'button',
          {
            type: 'button',
            style: { ...S.primary, background: accent, borderColor: accent, opacity: keyCtl.busy ? 0.6 : 1 },
            disabled: keyCtl.busy,
            onClick: keyCtl.save,
          },
          keyCtl.busy ? t('key.testing') : t('save'),
        ),
      );
    }

    function usageRow(state) {
      if (!state.usage) return null;
      return h(
        'div',
        { style: S.hint },
        t('usage', {
          n: state.usage.chars || 0,
          cost: (((state.usage.chars || 0) / 10000) * 0.8).toFixed(2),
        }),
      );
    }

    function settingsBody(state, accent, keyCtl, withColor) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        voiceRow(state),
        rateRow(state, accent),
        cleanRow(state, accent),
        bargeRow(state, accent),
        withColor ? h(AccentPicker, { accent, onChange: setAccent }) : null,
        keyRow(state, accent, keyCtl),
        usageRow(state),
      );
    }

    function settingsButton(state, accent) {
      // While the config read is in flight the button stays available; it only
      // disappears when the host reports that no key is configured yet.
      if (state.configReady && !state.configured) return null;
      const open = settingsOpen(state);
      return h(
        'div',
        { style: S.row },
        h(
          'button',
          {
            type: 'button',
            onClick: toggleSettings,
            style: {
              ...S.btn,
              borderColor: open ? accent : TOKENS.border,
              color: open ? accent : TOKENS.ink,
            },
          },
          '⚙ ' + (open ? t('settings.hide') : t('settings')),
        ),
      );
    }

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
      const keyCtl = { key, setKey, busy, save };

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: S.pill },
          h('span', { style: { ...S.dot, background: state.paused ? TOKENS.warn : accent } }),
          h('span', { style: { fontWeight: 600 } }, state.paused ? t('call.paused') : t('call.active')),
          h('span', { style: S.clock }, clock),
          h('button', { type: 'button', style: S.btn, onClick: togglePause }, state.paused ? t('resume') : t('pause')),
          h(
            'button',
            { type: 'button', style: S.btn, onClick: () => set({ expanded: !state.expanded }) },
            state.expanded ? t('collapse') : t('expand'),
          ),
          h('button', { type: 'button', style: S.close, title: t('end'), onClick: endCall }, '✕'),
        ),
        state.expanded
          ? h(
              'div',
              { style: S.card },
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                h('strong', { style: { fontSize: 13 } }, t('app.title')),
                h('span', { style: { color: accent, fontWeight: 500 } }, phaseText(state.phase)),
              ),
              h('div', { style: S.hint }, t('session.bound', { id: String(state.sessionId || '').slice(0, 18) })),
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
                            color: TOKENS.ink,
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
                          line.role === 'user' ? t('role.user') : t('role.assistant'),
                        ),
                        line.text,
                      ),
                    )
                  : h('div', { style: { color: TOKENS.muted } }, t('lines.empty')),
              ),
              h(
                'div',
                { style: S.row },
                h('span', { style: S.label }, t('mic', { n: Math.round((state.level || 0) * 100) })),
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
                  t('send'),
                ),
                h('button', { type: 'button', style: S.btn, onClick: stopSpeaking }, t('interrupt')),
              ),
              settingsButton(state, accent),
              settingsOpen(state) ? settingsBody(state, accent, keyCtl, false) : null,
            )
          : null,
      );
    }

    function langButton(state, accent, value, label) {
      const active = state.lang === value;
      return h(
        'button',
        {
          key: value,
          type: 'button',
          onClick: () => setLang(value),
          style: {
            ...S.btn,
            flex: '0 0 auto',
            ...(active
              ? { borderColor: accent, color: accent, background: rgba(accent, 0.08) }
              : { color: TOKENS.muted }),
          },
        },
        label,
      );
    }

    function AccentPicker(props) {
      const accent = normalizeAccent(props.accent);
      return h(
        'div',
        { style: { ...S.row, flexWrap: 'wrap', gap: 6 } },
        h('span', { style: { ...S.label, flex: '0 0 auto' } }, t('color')),
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
          title: t('color.custom'),
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
      const keyCtl = { key, setKey, busy, save };

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: { ...S.card, width: 360 } },
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('strong', { style: { fontSize: 13 } }, t('app.title')),
            h('span', { style: { color: accent, fontWeight: 500 } }, t('app.setup')),
          ),
          h(
            'div',
            { style: S.hint },
            sessionId ? t('prep.session', { id: String(sessionId).slice(0, 18) }) : t('prep.noSession'),
          ),
          h(
            'div',
            { style: S.row },
            h('span', { style: { ...S.label, flex: '0 0 auto' } }, t('lang')),
            langButton(state, accent, 'zh', '中文'),
            langButton(state, accent, 'en', 'English'),
          ),
          state.error ? h('div', { style: { color: TOKENS.danger } }, state.error) : null,
          settingsButton(state, accent),
          settingsOpen(state) ? settingsBody(state, accent, keyCtl, true) : null,
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 } },
            h('button', { type: 'button', style: S.btn, onClick: closePrep }, t('cancel')),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.primary, background: accent, borderColor: accent },
                onClick: () => {
                  const id = currentSessionId();
                  if (!id) {
                    set({ error: t('notice.noSession') });
                    return;
                  }
                  startCall(id);
                },
              },
              t('start'),
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
            title: t('launcher.title'),
            onClick: () => {
              const api = sessionApi();
              if (!api?.sessions?.retain || !api?.uiSession) {
                setNotice(t('notice.noService'));
                return;
              }
              if (!currentSessionId()) {
                setNotice(t('notice.noSession'));
                return;
              }
              openPrep();
            },
          },
          h('span', { 'aria-hidden': true }, '🎙'),
          t('launcher.label'),
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
