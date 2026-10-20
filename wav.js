/**
 * Long utterances are split before they reach the speech provider, because the
 * experimental speech-to-text bundle rejects audio longer than its configured
 * limit (120 s by default). Each piece is re-wrapped in its own WAV header.
 */

export const MAX_SEGMENT_SECONDS = 100;

function parseWav(buffer) {
  if (buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= buffer.length) {
      format = {
        kind: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = { offset: body, length: Math.min(size, buffer.length - body) };
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format || !data || !format.sampleRate || !format.channels || !format.bits) return null;
  return { format, data };
}

function wavHeader(format, dataLength) {
  const blockAlign = format.channels * (format.bits / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format.kind, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(Math.round(format.sampleRate * blockAlign), 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(format.bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return header;
}

/** Cut near the target, at the quietest 20 ms frame, so a word is not split. */
function quietCut(pcm, target, windowBytes, format) {
  if (format.kind !== 1 || format.bits !== 16) return target;
  const blockAlign = format.channels * 2;
  const frameBytes = Math.max(blockAlign, Math.floor(format.sampleRate * 0.02) * blockAlign);
  const from = Math.max(0, target - windowBytes);
  const to = Math.min(pcm.length, target + windowBytes);
  let best = target;
  let bestRms = Infinity;
  for (let pos = from; pos + frameBytes <= to; pos += frameBytes) {
    let sum = 0;
    for (let i = pos; i + 1 < pos + frameBytes; i += 2) {
      const value = pcm.readInt16LE(i) / 32768;
      sum += value * value;
    }
    const rms = sum / (frameBytes / 2);
    if (rms < bestRms) {
      bestRms = rms;
      best = pos;
    }
  }
  return best - (best % blockAlign);
}

/**
 * Returns null when the audio already fits (caller sends it unchanged), or an
 * array of base64 WAV segments each shorter than `maxSeconds`.
 */
export function splitWav(base64, maxSeconds = MAX_SEGMENT_SECONDS) {
  const buffer = Buffer.from(String(base64 || ''), 'base64');
  const parsed = parseWav(buffer);
  if (!parsed) return null;
  const { format, data } = parsed;
  const bytesPerSecond = format.sampleRate * format.channels * (format.bits / 8);
  if (!bytesPerSecond) return null;
  const totalSeconds = data.length / bytesPerSecond;
  if (totalSeconds <= maxSeconds) return null;

  const pcm = buffer.subarray(data.offset, data.offset + data.length);
  const segments = [];
  let start = 0;
  while (start < pcm.length) {
    let end = pcm.length;
    if ((pcm.length - start) / bytesPerSecond > maxSeconds) {
      const target = start + Math.floor(maxSeconds * bytesPerSecond);
      end = quietCut(pcm, target, Math.floor(1.5 * bytesPerSecond), format);
      if (end <= start) end = target;
    }
    const slice = pcm.subarray(start, end);
    segments.push(Buffer.concat([wavHeader(format, slice.length), slice]).toString('base64'));
    start = end;
  }
  return segments;
}
