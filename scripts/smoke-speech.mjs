// Behaviour test for the speech pipeline and the single-owner guard.
// It runs the real client bundle against stubbed React, DOM, fetch and audio.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, '..', 'client.js'), 'utf8');

const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children: children.length ? children : undefined } };
  },
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------- stubs */

const calls = [];
const failingTexts = new Set();
globalThis.fetch = async (url, init) => {
  const target = String(url);
  calls.push({ url: target, body: init?.body ? JSON.parse(init.body) : null });
  if (target.includes('/voice-call/config')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ configured: true, voice: 'Cherry', rate: 1, voices: [{ id: 'Cherry', label: 'A', desc: 'B' }] }),
    };
  }
  if (target.includes('/voice-call/transcribe')) {
    return { ok: true, status: 200, json: async () => ({ text: '你好' }) };
  }
  if (target.includes('/voice-call/tts')) {
    const text = new URL(target, 'http://x').searchParams.get('text') || '';
    if ([...failingTexts].some((needle) => text.includes(needle))) {
      return { ok: false, status: 502, json: async () => ({ error: 'bad gateway' }) };
    }
    return { ok: true, status: 200, blob: async () => new Blob(['audio']) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
globalThis.Audio = class {
  constructor() {
    this.preservesPitch = true;
    this.playbackRate = 1;
    this.src = '';
  }
  play() {
    setTimeout(() => this.onended && this.onended(), 0);
    return Promise.resolve();
  }
  pause() {}
};
globalThis.URL.createObjectURL = () => 'blob:test';
globalThis.URL.revokeObjectURL = () => {};
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.window = {};
globalThis.navigator.mediaDevices = undefined;

/* ------------------------------------------------------------- harness */

let loaded = null;
globalThis.window.__ModuleLoader__ = {
  load(definition) {
    loaded = definition;
  },
};

function instantiate() {
  new Function(source)();
  const plugin = loaded.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected import ${name}`);
  });
  return plugin;
}

function makeContext(registrations, disposerState) {
  const ctx = {
    effect: (callback) => callback(),
    inject: (_deps, callback) => callback(ctx),
    slots: {
      inject: (_key, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {
          disposerState.disposed += 1;
        };
      },
    },
    sessions: {
      retain: () => {
        disposerState.retained += 1;
        return { ready: Promise.resolve(disposerState.binding), release() {} };
      },
    },
    uiSession: { current: { getSnapshot: () => ({ key: 'session-test' }) } },
  };
  return ctx;
}

function render(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(render);
  if (typeof node.type === 'function') return render(node.type(node.props));
  const children = node.props?.children;
  return {
    type: node.type,
    props: {
      ...node.props,
      children: children === undefined ? undefined : [].concat(children).map(render),
    },
  };
}

function walk(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  for (const child of [].concat(node.props?.children ?? [])) walk(child, predicate, out);
  return out;
}

function findButton(tree, text) {
  return walk(
    tree,
    (node) => node.type === 'button' && JSON.stringify(node.props?.children ?? '').includes(text),
  )[0];
}

function ttsTexts() {
  return calls
    .filter((call) => call.url.includes('/voice-call/tts'))
    .map((call) => new URL(call.url, 'http://x').searchParams.get('text'));
}

/* -------------------------------------------------------- first instance */

const events = [];
let revision = 0;
let listener = null;
const binding = {
  eventSource: {
    getSnapshot: () => ({ revision, entries: events.slice(), change: null }),
    subscribe: (callback) => {
      listener = callback;
      return () => {
        listener = null;
      };
    },
  },
  session: {
    prompt: async () => ({ ok: true }),
    cancel: async () => {},
  },
};

const regs1 = [];
const state1 = { disposed: 0, retained: 0, binding };
const plugin1 = instantiate();
plugin1.apply(makeContext(regs1, state1));
if (regs1.length !== 1) throw new Error('first instance did not register');

const launcherButton = findButton(render(regs1[0].component()), '通话');
if (!launcherButton) throw new Error('launcher button missing');
launcherButton.props.onClick();
const startButton = findButton(render(regs1[0].component()), '开始通话');
if (!startButton) throw new Error('start-call button missing');
startButton.props.onClick();
await sleep(20);
if (state1.retained !== 1) throw new Error('call did not start');

function push(event) {
  events.push({ type: 'event', event });
  revision += 1;
  listener?.();
}

// Streaming speech: the first sentence must be requested before the turn ends.
push({ type: 'assistant/live-chunk', data: { chunk: { type: 'text-delta', index: 0, text: '第一句话。' } } });
await sleep(20);
if (!ttsTexts().some((text) => text && text.includes('第一句话'))) {
  throw new Error(`no TTS request for the first sentence: ${JSON.stringify(ttsTexts())}`);
}

push({ type: 'assistant/live-chunk', data: { chunk: { type: 'text-delta', index: 0, text: '第二句话。' } } });
await sleep(20);
const beforeEnd = ttsTexts().length;
if (beforeEnd < 2) throw new Error(`second sentence not spoken while streaming: ${JSON.stringify(ttsTexts())}`);

push({ type: 'turn/end', data: {} });
await sleep(20);
const afterEnd = ttsTexts();
if (afterEnd.length !== beforeEnd) {
  throw new Error(`turn/end re-spoke already spoken text: ${JSON.stringify(afterEnd)}`);
}

// The transcript keeps the full assistant reply.
const card = render(regs1[0].component());
const flat = JSON.stringify(card);
if (!flat.includes('第一句话。第二句话。')) throw new Error('assistant line missing from the widget transcript');

/* ------------------------------------------- a failed chunk does not stop */

failingTexts.add('这一句会失败');
push({ type: 'assistant/live-chunk', data: { chunk: { type: 'text-delta', index: 0, text: '这一句会失败。' } } });
await sleep(30);
push({ type: 'assistant/live-chunk', data: { chunk: { type: 'text-delta', index: 0, text: '这一句必须还在。' } } });
await sleep(120);

const afterFailure = ttsTexts();
const failedCalls = afterFailure.filter((text) => text && text.includes('这一句会失败')).length;
if (failedCalls !== 2) throw new Error(`expected one retry for the failed chunk, saw ${failedCalls} calls`);
if (!afterFailure.some((text) => text && text.includes('这一句必须还在'))) {
  throw new Error(`a failed chunk silenced the rest of the reply: ${JSON.stringify(afterFailure)}`);
}
const afterFailureCard = JSON.stringify(render(regs1[0].component()));
if (!afterFailureCard.includes('没读出来')) throw new Error('the widget did not report the skipped chunk');

/* ------------------------------------------------------- second instance */

const regs2 = [];
const state2 = { disposed: 0, retained: 0, binding };
const plugin2 = instantiate();
plugin2.apply(makeContext(regs2, state2));

if (state1.disposed !== 1) throw new Error('previous instance was not disposed when a new one applied');
if (window.__dshVoiceCallBoots !== 2) throw new Error(`boot counter is ${window.__dshVoiceCallBoots}`);
if (regs2.length !== 1) throw new Error('second instance did not register');

console.log('speech pipeline OK');
console.log('  tts requests   :', afterEnd.length, JSON.stringify(afterEnd));
console.log('  first chunk    :', afterEnd[0]?.length, 'chars');
console.log('  boots          :', window.__dshVoiceCallBoots);
console.log('  old disposed   :', state1.disposed === 1);
