/**
 * Host half of the Voice Call bundle.
 *
 * It owns three jobs and nothing else:
 *   1. speech-to-text through the profile's own `speechController`
 *      (the shipped local SenseVoice provider),
 *   2. text-to-speech through Alibaba DashScope,
 *   3. non-secret preferences (voice, rate, monthly characters).
 *
 * The DashScope key never lives in this file's settings document when a
 * credential store is mounted: it is kept in the profile credential store under
 * `DASHSCOPE_API_KEY`, and a key left in the old settings document is migrated
 * on first use.
 *
 * Everything is registered through `ctx.effect`, so unloading the bundle takes
 * the routes with it.
 *
 * @module dsh-voice-call
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { splitWav } from './wav.js';

export const name = 'voice-call';

/**
 * Only the HTTP carrier is required. The recognizer is optional so the bundle
 * still installs and mounts on a profile that has not enabled the experimental
 * voice-input bundle; `/transcribe` then explains what is missing instead of the
 * whole plugin silently never activating.
 */
export const inject = ['webServer'];

let speechController = null;

const MODEL = 'qwen3-tts-flash';
const ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const CREDENTIAL = 'DASHSCOPE_API_KEY';
const SPEECH_PROVIDER = 'sensevoice-local';

const DATA_DIR = process.env.DSH_HOME || join(homedir(), '.dsh');
const SETTINGS_FILE = join(DATA_DIR, 'voice-call.json');

const VOICES = [
  ['Cherry', '芊悦', '阳光亲切的女声', 'Sunny, friendly female'],
  ['Serena', '苏瑶', '温柔女声', 'Gentle female'],
  ['Ethan', '晨煦', '温暖男声', 'Warm male'],
  ['Chelsie', '千雪', '二次元女声', 'Anime-style female'],
  ['Momo', '茉兔', '俏皮女声', 'Playful female'],
  ['Vivian', '十三', '可爱小暴躁', 'Feisty, cute female'],
  ['Moon', '月白', '率性男声', 'Casual male'],
  ['Maia', '四月', '知性温柔', 'Calm, thoughtful female'],
  ['Kai', '凯', '低沉男声', 'Deep male'],
  ['Nofish', '不吃鱼', '设计师男声', 'Designer male'],
  ['Bella', '萌宝', '萝莉音', 'Childlike female'],
  ['Jennifer', '詹妮弗', '电影质感女声', 'Cinematic female'],
].map(([id, label, desc, descEn]) => ({ id, label, desc, descEn }));

function monthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

let settingsCache = null;
let credentials = null;

/**
 * Small in-memory trace of the speech pipeline. It survives nothing and is only
 * read from `/voice-call/diagnostics`, which is how a duplicated send or a
 * duplicated recorder shows up as separate entries instead of a guess.
 */
const diagnostics = { applies: 0, transcribes: [], tts: [] };

function trace(bucket, entry) {
  bucket.push({ at: Date.now(), ...entry });
  if (bucket.length > 40) bucket.splice(0, bucket.length - 40);
}

async function loadSettings() {
  if (settingsCache) return settingsCache;
  settingsCache = { voice: 'Cherry', rate: 1, usage: { month: monthKey(), chars: 0 } };
  try {
    const raw = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'));
    settingsCache = {
      ...settingsCache,
      voice: typeof raw.voice === 'string' ? raw.voice : settingsCache.voice,
      rate: Number(raw.rate) || settingsCache.rate,
      usage: { ...settingsCache.usage, ...(raw.usage || {}) },
      // Kept only long enough to migrate into the credential store.
      legacyApiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    };
  } catch {}
  if (settingsCache.usage.month !== monthKey()) {
    settingsCache.usage = { month: monthKey(), chars: 0 };
  }
  return settingsCache;
}

async function saveSettings() {
  const { legacyApiKey, ...rest } = settingsCache || {};
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(rest, null, 2), 'utf8');
  settingsCache = { ...rest };
}

function mask(key) {
  if (!key) return '';
  return key.length <= 8 ? '****' : `${key.slice(0, 3)}****${key.slice(-4)}`;
}

/**
 * Resolve the DashScope key without ever returning it to the page.
 * Order: credential store → legacy settings document → environment.
 */
async function resolveKey() {
  if (credentials) {
    try {
      const hit = await credentials.resolve(CREDENTIAL);
      if (hit?.value) return hit.value;
    } catch {}
  }
  const settings = await loadSettings();
  const legacy = settings.legacyApiKey;
  if (legacy) {
    if (credentials) {
      try {
        await credentials.set(CREDENTIAL, legacy);
        settings.legacyApiKey = '';
        await saveSettings();
        return legacy;
      } catch {}
    }
    return legacy;
  }
  return process.env[CREDENTIAL] || '';
}

async function storeKey(key) {
  if (credentials) {
    await credentials.set(CREDENTIAL, key);
    return;
  }
  // No credential store in this composition: keep the old local document.
  const settings = await loadSettings();
  settings.legacyApiKey = key;
  await saveSettings();
}

async function clearKey() {
  settingsCache = settingsCache || (await loadSettings());
  settingsCache.legacyApiKey = '';
  await saveSettings();
  if (credentials) {
    try {
      await credentials.unset(CREDENTIAL);
    } catch {}
  }
}

function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true; // same-document fetch or no browser origin
  const host = req.headers?.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function synthesize(text, voice, key) {
  if (!key) {
    const error = new Error('未配置阿里云 API Key');
    error.code = 'NOT_CONFIGURED';
    throw error;
  }
  const clean = String(text || '').trim();
  if (!clean) throw new Error('empty text');
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        input: { text: clean.slice(0, 600), voice, language_type: 'Auto' },
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`连接阿里云失败：${err.message}`);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {}
  if (!response.ok || data?.code) {
    const message = data?.message || data?.code || `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403 || /invalid.*key|apikey/i.test(message)) {
      throw new Error(`API Key 无效或无权限：${message}`);
    }
    if (response.status === 429) throw new Error('阿里云限流，请稍后再试');
    throw new Error(`阿里云返回错误：${message}`);
  }
  const audio = data?.output?.audio;
  if (audio?.data) {
    return { buffer: Buffer.from(audio.data, 'base64'), contentType: 'audio/wav' };
  }
  if (audio?.url) {
    const file = await fetch(audio.url, { signal: AbortSignal.timeout(15000) });
    if (!file.ok) throw new Error(`下载云端音频失败：HTTP ${file.status}`);
    return {
      buffer: Buffer.from(await file.arrayBuffer()),
      contentType: file.headers.get('content-type') || 'audio/wav',
    };
  }
  throw new Error('阿里云没有返回音频');
}

/** Read the recognizer result across provider shapes (string or `{ text }`). */
function transcriptText(transcript) {
  if (typeof transcript === 'string') return transcript;
  const nested = transcript?.text ?? transcript?.transcript;
  if (typeof nested === 'string') return nested;
  if (nested && typeof nested === 'object') {
    return String(nested.text ?? nested.transcript ?? '');
  }
  return '';
}

export function apply(ctx) {
  diagnostics.applies += 1;
  ctx.effect(
    () => () => {
      diagnostics.applies -= 1;
    },
    'dsh-voice-call: route lifetime',
  );

  // Optional: the credential store is present in the shipped compositions but a
  // custom one may omit it, and the plugin must still activate.
  ctx.inject(['credentials'], (scoped) => {
    credentials = scoped.credentials;
    return () => {
      credentials = null;
    };
  });

  // Optional: the local recognizer lives in the experimental voice-input bundle.
  ctx.inject(['speechController'], (scoped) => {
    speechController = scoped.speechController;
    return () => {
      speechController = null;
    };
  });

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/voice-call',
        handler: async (req, res) => {
          if (!sameOrigin(req)) {
            sendJson(res, 403, { error: 'cross-origin request refused' });
            return;
          }
          try {
            const url = new URL(req.url || '/', 'http://localhost');
            const sub = url.pathname.replace(/^\/voice-call/, '') || '/';

            if (req.method === 'GET' && sub === '/health') {
              sendJson(res, 200, {
                ok: true,
                plugin: 'dsh-voice-call',
                stt: Boolean(speechController),
              });
              return;
            }

            if (req.method === 'GET' && sub === '/config') {
              const [settings, key] = [await loadSettings(), await resolveKey()];
              sendJson(res, 200, {
                configured: Boolean(key),
                keyMasked: mask(key),
                model: MODEL,
                voice: settings.voice,
                rate: settings.rate,
                voices: VOICES,
                usage: settings.usage,
              });
              return;
            }

            if (req.method === 'POST' && sub === '/config') {
              const body = JSON.parse((await readBody(req)) || '{}');
              if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
                const key = body.apiKey.trim();
                // Validate before persisting so a bad key never replaces a good one.
                await synthesize('你好', 'Cherry', key);
                await storeKey(key);
              }
              if (body.clearKey) await clearKey();
              const settings = await loadSettings();
              if (typeof body.voice === 'string' && VOICES.some((voice) => voice.id === body.voice)) {
                settings.voice = body.voice;
              }
              if (body.rate) {
                settings.rate = Math.min(1.5, Math.max(0.7, Number(body.rate) || 1));
              }
              await saveSettings();
              const key = await resolveKey();
              sendJson(res, 200, {
                ok: true,
                configured: Boolean(key),
                keyMasked: mask(key),
                voice: settings.voice,
                rate: settings.rate,
              });
              return;
            }

            if (req.method === 'POST' && sub === '/transcribe') {
              const body = JSON.parse((await readBody(req, 64 * 1024 * 1024)) || '{}');
              if (!body.audioBase64) throw new Error('empty audio');
              if (!speechController) {
                const error = new Error(
                  '语音识别没有就绪：请在这个 profile 里启用「实验性语音输入」组合包（sensevoice-local）。',
                );
                error.code = 'NO_STT';
                throw error;
              }
              if (typeof speechController.prepare === 'function') {
                await speechController.prepare(SPEECH_PROVIDER);
              }
              // The speech bundle rejects audio longer than its configured limit
              // (120 s by default), so a long utterance is recognized in pieces.
              const segments = splitWav(body.audioBase64) || [body.audioBase64];
              const parts = [];
              for (const audioBase64 of segments) {
                const transcript = await speechController.transcribe(
                  {
                    audioBase64,
                    providerId: SPEECH_PROVIDER,
                    language: body.language || 'zh',
                  },
                  AbortSignal.timeout(120000),
                );
                const piece = transcriptText(transcript).trim();
                if (piece) parts.push(piece);
              }
              const text = parts.join(' ').trim();
              trace(diagnostics.transcribes, {
                bytes: body.audioBase64.length,
                segments: segments.length,
                instance: typeof body.instance === 'string' ? body.instance : '',
                boots: Number(body.boots) || 0,
                chars: text.length,
                head: text.slice(0, 12),
              });
              sendJson(res, 200, { text });
              return;
            }

            if (req.method === 'GET' && sub === '/diagnostics') {
              sendJson(res, 200, {
                plugin: 'dsh-voice-call',
                applies: diagnostics.applies,
                transcribes: diagnostics.transcribes,
                tts: diagnostics.tts,
              });
              return;
            }

            if (req.method === 'GET' && sub === '/tts') {
              const settings = await loadSettings();
              const text = url.searchParams.get('text') || '';
              const voice = url.searchParams.get('voice') || settings.voice || 'Cherry';
              let audio;
              try {
                audio = await synthesize(text, voice, await resolveKey());
              } catch (error) {
                trace(diagnostics.tts, {
                  ok: false,
                  chars: String(text).length,
                  voice,
                  head: String(text).slice(0, 12),
                  error: String(error?.message || error).slice(0, 120),
                });
                throw error;
              }
              trace(diagnostics.tts, {
                ok: true,
                chars: String(text).length,
                voice,
                head: String(text).slice(0, 12),
              });
              settings.usage.month = monthKey();
              settings.usage.chars = Number(settings.usage.chars || 0) + String(text).length;
              await saveSettings();
              res.writeHead(200, {
                'content-type': audio.contentType || 'audio/wav',
                'content-length': audio.buffer.length,
                'cache-control': 'no-store',
              });
              res.end(audio.buffer);
              return;
            }

            sendJson(res, 404, { error: 'not found' });
          } catch (err) {
            const status = err?.code === 'NOT_CONFIGURED' || err?.code === 'NO_STT' ? 400 : 502;
            sendJson(res, status, { error: String(err?.message || err) });
          }
        },
      }),
    'dsh-voice-call: /voice-call routes',
  );
}
