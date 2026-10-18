// Contract smoke test for the client bundle, without a browser or React.
// It loads client.js with a stubbed module loader, checks the slot registration,
// opens the pre-call panel, starts the call, and renders the active card.
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

const sleep = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
    },
  },
};
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.fetch = async (url) => {
  if (String(url).includes('/voice-call/config')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ configured: true, voice: 'Cherry', rate: 1, voices: [] }),
    };
  }
  return { ok: false, status: 0, json: async () => ({}) };
};
globalThis.Audio = function Audio() {};
globalThis.URL.createObjectURL = () => 'blob:test';
globalThis.URL.revokeObjectURL = () => {};
globalThis.navigator.mediaDevices = undefined;

new Function(source)();

if (!loaded) throw new Error('module loader was not called');
if (loaded.id !== 'dsh-voice-call') throw new Error(`unexpected module id: ${loaded.id}`);
if (loaded.factory.length !== 1) throw new Error('factory must take exactly one argument (require)');

const require = (name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected runtime import: ${name}`);
};

const plugin = loaded.factory(require);
if (typeof plugin.apply !== 'function') throw new Error('plugin.apply missing');
if (plugin.name !== 'voice-call') throw new Error(`unexpected plugin name: ${plugin.name}`);
if (!Array.isArray(plugin.inject) || !plugin.inject.includes('slots')) throw new Error('plugin.inject missing slots');

const registrations = [];
const effects = [];
let retained = null;

const ctx = {
  effect: (callback, label) => {
    effects.push(label);
    return callback();
  },
  inject: (deps, callback) => {
    effects.push('inject:' + deps.join('+'));
    return callback(ctx);
  },
  slots: {
    inject: (key, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    },
  },
  sessions: {
    retain: (sessionId, options) => {
      retained = { sessionId, options };
      return { ready: Promise.resolve({}), release() {} };
    },
  },
  uiSession: { current: { getSnapshot: () => ({ key: 'session-test' }) } },
};

plugin.apply(ctx);

if (registrations.length !== 1) throw new Error(`expected 1 slot registration, got ${registrations.length}`);
const [{ options, component }] = registrations;
if (options.name !== 'shell.overlay') throw new Error(`registered into ${options.name}`);
if (options.id !== 'dsh-voice-call') throw new Error(`registration id ${options.id}`);
if (typeof options.order !== 'number') throw new Error('registration order missing');

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

function findToggle(tree, text) {
  const label = walk(
    tree,
    (node) => node.type === 'label' && JSON.stringify(node.props?.children ?? '').includes(text),
  )[0];
  if (!label) return null;
  return [].concat(label.props.children || []).find((child) => child && child.type === 'input') || null;
}

/* ------------------------------------------------------------- launcher */

const launcher = render(component());
if (launcher.props.style.pointerEvents !== 'none') throw new Error('overlay wrapper must be pointer-events:none');
const launcherButton = findButton(launcher, '通话');
if (!launcherButton) throw new Error('launcher button not rendered');
if (launcherButton.props.title !== '打开语音通话设置') throw new Error('unexpected launcher title');
if (launcherButton.props.style.pointerEvents !== 'auto') throw new Error('launcher button must accept pointer events');
if (launcherButton.props.style.background !== '#4d6bfe') {
  throw new Error(`default accent not applied: ${launcherButton.props.style.background}`);
}

launcherButton.props.onClick();
if (retained) throw new Error('opening the panel must not start a call yet');

/* --------------------------------------------------------------- pre-call */

const prep = render(component());
if (!JSON.stringify(prep).includes('开始通话')) throw new Error('pre-call panel did not render');
if (!JSON.stringify(prep).includes('按钮颜色')) throw new Error('pre-call panel has no colour picker');

// Voice barge-in exists, defaults to off, and can be turned on.
const bargeToggle = findToggle(prep, '语音打断');
if (!bargeToggle) throw new Error('barge-in toggle missing');
if (bargeToggle.props.checked !== false) throw new Error('barge-in must default to off');
bargeToggle.props.onChange({ target: { checked: true } });
const prepBargeOn = render(component());
if (findToggle(prepBargeOn, '语音打断')?.props.checked !== true) throw new Error('barge-in toggle did not stick');

// Language switcher: English copy replaces the Chinese one, and the layout stays.
const englishButton = findButton(prep, 'English');
if (!englishButton) throw new Error('language switcher missing');
englishButton.props.onClick();
const prepEn = render(component());
if (!JSON.stringify(prepEn).includes('Start call')) throw new Error('English copy not applied');
if (JSON.stringify(prepEn).includes('开始通话')) throw new Error('Chinese copy still present after switching');

const startButton = findButton(prepEn, 'Start call');
if (!startButton) throw new Error('start-call button missing');
startButton.props.onClick();
await sleep(20);

if (!retained) throw new Error('start-call did not retain the current session');
if (retained.sessionId !== 'session-test') throw new Error(`retained ${retained.sessionId}`);
if (retained.options?.source !== 'controllerOperation') throw new Error('unexpected retain source');

/* ------------------------------------------------------------ active card */

const card = render(component());
const cardChildren = [].concat(card.props.children).filter(Boolean);
if (cardChildren.length < 2) throw new Error('active card did not render pill and panel');
const pill = cardChildren[0];
if (!JSON.stringify(pill.props.children).includes('In call')) throw new Error('pill does not show the English call state');
if (JSON.stringify(card).includes('按钮颜色')) throw new Error('active card must not offer the colour picker');

console.log('client contract OK');
console.log('  module id      :', loaded.id);
console.log('  plugin         :', plugin.name, JSON.stringify(plugin.inject));
console.log('  slot           :', options.name, 'id=' + options.id, 'order=' + options.order);
console.log('  accent         :', launcherButton.props.style.background);
console.log('  retained       :', retained.sessionId, '(' + retained.options.source + ')');
console.log('  effects        :', effects.join(', '));
