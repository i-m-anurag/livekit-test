/**
 * TEST: TTFB — Time to First Audio Byte
 * =======================================
 * Measures:
 *   1. TTFB — user stops talking -> first audio byte from agent (STT + LLM + TTS combined)
 *
 * Also provides TTFBInstrumentation class to embed in your agent code
 * for per-stage breakdown:
 *   - STT latency (VAD silence -> transcription complete)
 *   - LLM time to first token
 *   - TTS time to first audio chunk
 *
 * Usage:
 *   node scripts/test_ttfb.js
 *   node scripts/test_ttfb.js --runs 15 --url wss://your-server
 */

// ═══════════════════════════════════════════════════════════════════
// PART A — Agent-side instrumentation (import into your agent code)
// ═══════════════════════════════════════════════════════════════════

import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

import { computeStats, round } from "./utils.js";

/**
 * TTFBInstrumentation — Add to your agent code for per-stage timing.
 *
 * Usage:
 *   import { TTFBInstrumentation } from "./test_ttfb.js";
 *   const instr = new TTFBInstrumentation();
 *
 *   const turn = instr.startTurn();
 *   turn.sttStartAt       = performance.now();
 *   turn.sttEndAt         = performance.now();
 *   turn.llmStartAt       = performance.now();
 *   turn.llmFirstTokenAt  = performance.now();
 *   turn.ttsStartAt       = performance.now();
 *   turn.ttsFirstChunkAt  = performance.now();
 *   turn.firstAudioSentAt = performance.now();
 *   instr.finishTurn(turn);
 */
export class TTFBInstrumentation {
  constructor(logFile = "results/ttfb_agent.jsonl") {
    this.logFile = logFile;
    this.turns = [];
    mkdirSync("results", { recursive: true });
  }

  startTurn() {
    return {
      turnId: `turn_${Date.now()}`,
      vadSilenceDetectedAt: performance.now(),
      sttStartAt: null,
      sttEndAt: null,
      sttDurationMs: null,
      llmStartAt: null,
      llmFirstTokenAt: null,
      llmFirstTokenMs: null,
      ttsStartAt: null,
      ttsFirstChunkAt: null,
      ttsFirstChunkMs: null,
      firstAudioSentAt: null,
      ttfbMs: null,
    };
  }

  finishTurn(timing) {
    if (timing.sttEndAt && timing.sttStartAt) {
      timing.sttDurationMs = round(timing.sttEndAt - timing.sttStartAt);
    }
    if (timing.llmFirstTokenAt && timing.llmStartAt) {
      timing.llmFirstTokenMs = round(timing.llmFirstTokenAt - timing.llmStartAt);
    }
    if (timing.ttsFirstChunkAt && timing.ttsStartAt) {
      timing.ttsFirstChunkMs = round(timing.ttsFirstChunkAt - timing.ttsStartAt);
    }
    if (timing.firstAudioSentAt && timing.vadSilenceDetectedAt) {
      timing.ttfbMs = round(timing.firstAudioSentAt - timing.vadSilenceDetectedAt);
    }

    this.turns.push(timing);
    console.log(
      `[TTFB] ${timing.turnId} | STT=${timing.sttDurationMs}ms | LLM=${timing.llmFirstTokenMs}ms | TTS=${timing.ttsFirstChunkMs}ms | TTFB=${timing.ttfbMs}ms`
    );

    appendFileSync(this.logFile, JSON.stringify(timing) + "\n");
  }

  printSummary() {
    const completed = this.turns.filter((t) => t.ttfbMs !== null);
    if (!completed.length) {
      console.log("No completed turns.");
      return;
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`  TTFB PIPELINE SUMMARY (${completed.length} turns)`);
    console.log("=".repeat(60));

    for (const [label, key] of [
      ["STT duration (ms)", "sttDurationMs"],
      ["LLM first token (ms)", "llmFirstTokenMs"],
      ["TTS first chunk (ms)", "ttsFirstChunkMs"],
      ["TTFB total (ms)", "ttfbMs"],
    ]) {
      const vals = completed.map((t) => t[key]).filter((v) => v !== null);
      if (!vals.length) continue;
      const s = computeStats(vals);
      console.log(
        `  ${label.padEnd(25)} min=${s.min}  avg=${s.avg}  p50=${s.p50}  p95=${s.p95}  max=${s.max}`
      );
    }
    console.log("=".repeat(60));
  }
}

// ═══════════════════════════════════════════════════════════════════
// PART B — Standalone TTFB probe bot (client-side measurement)
// ═══════════════════════════════════════════════════════════════════

import {
  Room,
  RoomEvent,
  TrackKind,
  AudioSource,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
  AudioFrame,
} from "@livekit/rtc-node";
import minimist from "minimist";

import { loadEnv, getEnv, getEnvInt } from "./env.js";
import { getToken } from "./token_generator.js";
import { sleep, generateTone, generateSilence, splitIntoFrames, printSep } from "./utils.js";

loadEnv();

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const SAMPLES_PER_FRAME = 960;
const RESPONSE_TIMEOUT_MS = 20000;

async function runTTFBProbe(url, token, runs) {
  const results = [];

  for (let runId = 1; runId <= runs; runId++) {
    const room = new Room();
    let firstAudioTime = 0;
    let firstAudioReceived = false;
    let resolveFirstAudio;
    const firstAudioPromise = new Promise((res) => {
      resolveFirstAudio = res;
    });

    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === TrackKind.KIND_AUDIO) {
        (async () => {
          for await (const _frame of track.stream) {
            if (!firstAudioReceived) {
              firstAudioReceived = true;
              firstAudioTime = performance.now();
              resolveFirstAudio();
            }
            break;
          }
        })();
      }
    });

    try {
      await room.connect(url, token);

      const source = new AudioSource(SAMPLE_RATE, CHANNELS);
      const track = LocalAudioTrack.createAudioTrack("probe", source);
      const opts = new TrackPublishOptions();
      opts.source = TrackSource.SOURCE_MICROPHONE;
      await room.localParticipant.publishTrack(track, opts);

      // Warmup silence (1s)
      for (const buf of splitIntoFrames(generateSilence(SAMPLE_RATE, 1000), SAMPLES_PER_FRAME)) {
        await source.captureFrame(new AudioFrame(buf, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME));
        await sleep(Math.floor((SAMPLES_PER_FRAME / SAMPLE_RATE) * 1000));
      }

      // Speech burst (1.5s tone to trigger VAD)
      for (const buf of splitIntoFrames(generateTone(SAMPLE_RATE, 440, 1500), SAMPLES_PER_FRAME)) {
        await source.captureFrame(new AudioFrame(buf, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME));
        await sleep(Math.floor((SAMPLES_PER_FRAME / SAMPLE_RATE) * 1000));
      }

      // Mark speech end + trailing silence
      const speechEndAt = performance.now();
      for (const buf of splitIntoFrames(generateSilence(SAMPLE_RATE, 500), SAMPLES_PER_FRAME)) {
        await source.captureFrame(new AudioFrame(buf, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME));
        await sleep(Math.floor((SAMPLES_PER_FRAME / SAMPLE_RATE) * 1000));
      }

      // Wait for agent response
      const winner = await Promise.race([
        firstAudioPromise.then(() => "packet"),
        sleep(RESPONSE_TIMEOUT_MS).then(() => "timeout"),
      ]);

      if (winner === "packet") {
        const ttfbMs = firstAudioTime - speechEndAt;
        results.push({ runId, ttfbMs: round(ttfbMs), speechEndAt, firstAudioTime });
        console.log(`  Run ${runId}: TTFB = ${ttfbMs.toFixed(1)}ms`);
      } else {
        console.log(`  Run ${runId}: TIMED OUT`);
      }
    } catch (err) {
      console.log(`  Run ${runId}: ERROR - ${err.message}`);
    } finally {
      await room.disconnect();
      await sleep(2000);
    }
  }

  if (results.length) {
    const ttfbValues = results.map((r) => r.ttfbMs);
    const s = computeStats(ttfbValues);

    console.log();
    printSep();
    console.log(`  TTFB RESULTS (${results.length} successful runs)`);
    printSep();
    for (const [k, v] of Object.entries(s)) {
      console.log(`  ${k.padEnd(6)} ${v.toFixed(1)} ms`);
    }

    mkdirSync("results", { recursive: true });
    const outPath = resolve("results", "test_ttfb.json");
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          test: "ttfb",
          timestamp: new Date().toISOString(),
          summary: s,
          runs: results,
        },
        null,
        2
      )
    );
    console.log(`\n  Results saved -> ${outPath}`);
  }
}

// CLI
if (process.argv[1].endsWith("test_ttfb.js")) {
  const args = minimist(process.argv.slice(2), {
    string: ["url", "token", "api-key", "api-secret", "room", "agent-name"],
    default: {
      url: getEnv("LIVEKIT_URL"),
      token: getEnv("LIVEKIT_TOKEN"),
      "api-key": getEnv("LIVEKIT_API_KEY"),
      "api-secret": getEnv("LIVEKIT_API_SECRET"),
      room: getEnv("LIVEKIT_ROOM", "latency-test-room"),
      "agent-name": getEnv("LIVEKIT_AGENT_NAME"),
      runs: getEnvInt("TEST_RUNS", 10),
    },
  });

  if (!args.url) {
    console.error("ERROR: --url required (or set LIVEKIT_URL in .env)");
    process.exit(1);
  }

  printSep();
  console.log("  TEST: TTFB (Time to First Audio Byte)");
  console.log(`  Server : ${args.url}`);
  console.log(`  Runs   : ${args.runs}`);
  printSep();

  try {
    const token = await getToken({
      cliToken: args.token,
      apiKey: args["api-key"],
      apiSecret: args["api-secret"],
      room: args.room,
      agentName: args["agent-name"],
    });
    await runTTFBProbe(args.url, token, Number(args.runs));
  } catch (err) {
    console.error("ERROR:", err.message);
    process.exit(1);
  }
}
