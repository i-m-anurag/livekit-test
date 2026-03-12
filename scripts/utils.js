/**
 * stats.js — Shared statistics helpers
 */

/**
 * Compute percentile/summary stats from an array of numbers.
 * @param {number[]} values
 * @returns {{ min, avg, p50, p95, p99, max }}
 */
export function computeStats(values) {
  if (!values || values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const avg = s.reduce((a, b) => a + b, 0) / n;
  return {
    min: round(s[0]),
    avg: round(avg),
    p50: round(s[Math.floor(n * 0.50)]),
    p95: round(s[Math.min(Math.floor(n * 0.95), n - 1)]),
    p99: round(s[Math.min(Math.floor(n * 0.99), n - 1)]),
    max: round(s[n - 1]),
  };
}

export function round(v, decimals = 2) {
  return Math.round(v * 10 ** decimals) / 10 ** decimals;
}

/**
 * Print a separator line.
 */
export function printSep(char = "=", width = 55) {
  console.log(char.repeat(width));
}

/**
 * Sleep for ms milliseconds.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a 16-bit PCM sine wave tone as a Buffer.
 * @param {number} sampleRate
 * @param {number} freq - Hz
 * @param {number} durationMs - milliseconds
 * @returns {Buffer} Int16 PCM samples
 */
export function generateTone(sampleRate, freq, durationMs) {
  const totalSamples = Math.floor((sampleRate * durationMs) / 1000);
  const buf = Buffer.alloc(totalSamples * 2); // 2 bytes per Int16 sample
  for (let i = 0; i < totalSamples; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 32767 * 0.8);
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

/**
 * Generate silence as a Buffer of zero-filled Int16 PCM samples.
 */
export function generateSilence(sampleRate, durationMs) {
  const totalSamples = Math.floor((sampleRate * durationMs) / 1000);
  return Buffer.alloc(totalSamples * 2);
}

/**
 * Split a Buffer into frames of frameSamples samples (Int16).
 */
export function splitIntoFrames(buf, frameSamples) {
  const frameBytes = frameSamples * 2;
  const frames = [];
  for (let offset = 0; offset < buf.length; offset += frameBytes) {
    const slice = buf.slice(offset, offset + frameBytes);
    if (slice.length < frameBytes) {
      // Pad last frame with silence
      const padded = Buffer.alloc(frameBytes);
      slice.copy(padded);
      frames.push(padded);
    } else {
      frames.push(slice);
    }
  }
  return frames;
}
