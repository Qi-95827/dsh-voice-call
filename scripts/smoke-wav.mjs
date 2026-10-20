// Checks the WAV splitter used for long dictation.
import { splitWav, MAX_SEGMENT_SECONDS } from '../wav.js';

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS = 16;

function buildWav(seconds, { quietEvery = 10 } = {}) {
  const frames = SAMPLE_RATE * seconds;
  const dataLength = frames * CHANNELS * (BITS / 8);
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
  buffer.writeUInt16LE(CHANNELS * 2, 32);
  buffer.writeUInt16LE(BITS, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataLength, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / SAMPLE_RATE;
    // Loud tone, with a short dip every `quietEvery` seconds.
    const inDip = Math.abs(t % quietEvery) < 0.05;
    const value = inDip ? 0 : Math.round(Math.sin(2 * Math.PI * 220 * t) * 8000);
    buffer.writeInt16LE(value, 44 + i * 2);
  }
  return buffer;
}

function durationOf(base64) {
  const buffer = Buffer.from(base64, 'base64');
  const dataLength = buffer.readUInt32LE(40);
  return dataLength / (SAMPLE_RATE * CHANNELS * (BITS / 8));
}

// Short audio is left alone.
if (splitWav(buildWav(30).toString('base64')) !== null) throw new Error('short audio must not be split');

// 300 s becomes segments below the provider limit, and nothing is lost.
const long = buildWav(300).toString('base64');
const segments = splitWav(long);
if (!segments || segments.length < 3) throw new Error(`expected at least 3 segments, got ${segments?.length}`);
const durations = segments.map(durationOf);
for (const seconds of durations) {
  if (seconds > MAX_SEGMENT_SECONDS + 0.1) throw new Error(`segment too long: ${seconds}s`);
}
const total = durations.reduce((sum, value) => sum + value, 0);
if (Math.abs(total - 300) > 2) throw new Error(`segments cover ${total}s instead of 300s`);

// Every segment must be a valid WAV the provider will accept.
for (const segment of segments) {
  const buffer = Buffer.from(segment, 'base64');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('segment is not a WAV');
  if (buffer.readUInt32LE(40) !== buffer.length - 44) throw new Error('segment data size mismatch');
  if (buffer.toString('base64') !== segment) throw new Error('segment is not canonical base64');
}

// Unknown input falls back to the caller's single-shot path.
if (splitWav(Buffer.from('not a wav').toString('base64')) !== null) throw new Error('invalid audio must not split');

console.log('wav splitter OK');
console.log('  segments      :', segments.length, '→', durations.map((s) => s.toFixed(1) + 's').join(', '));
console.log('  covered       :', total.toFixed(1) + 's');
