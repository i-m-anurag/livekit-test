/**
 * TEST 3: Time to First Audio Byte (TTFB)
 * =========================================
 * Measures: Time from end of user speech (VAD silence) → first audio packet
 *           received back from the AI agent.
 *
 * TWO PARTS:
 *   Part A → TTFBInstrumentation class: add to your existing LiveKit agent code
 *   Part B → Standalone probe bot: run directly to measure TTFB from outside
 *
 * Usage:
 *   node scripts/test3_ttfb.js
 *   node scripts/test3_ttfb.js --url wss://your-server --runs 15
 */

// ═══════════════════════════════════════════════════════════════════════════════
// PART A – Agent-side instrumentation (import and use inside your agent code)
// ═══════════════════════════════════════════════════════════════════════════════

import { appendFileSync, mkdirSync } from "fs";
import { resolve } from "path";

/**
 * TTFBInstrumentation
 * -------------------
 * Add to your LiveKit agent to log pipeline timing per conversation turn.
 *
 * Usage inside your agent:
 *
 *   import { TTFBInstrumentation } from "./test3_ttfb.js";
 *   const instr = new TTFBInstrumentation();
 *
 *   // When VAD detects end of speech:
 *   const turn = instr.startTurn();
 *
 *   turn.sttStartAt       = performance.now();   // before STT
 *   turn.sttEndAt         = performance.now();   // after STT
 *   turn.llmStartAt       = performance.now();   // before LLM
 *   turn.llmFirstTokenAt  = performance.now();   // on first LLM token
 *   turn.ttsStartAt       = performance.now();   // before TTS
 *   turn.ttsFirstChunkAt  = performance.now();   // on first TTS audio chunk
 *   turn.firstAudioSentAt = performance.now();   // when first audio frame sent to LiveKit
 *
 *   instr.finishTurn(turn);
 */
export class TTFBInstrumentation {
  constructor(logFile = "results/ttfb_agent.jsonl") {
    this.logFile = logFile;
    this.turns   = [];
    mkdirSync("results", { recursive: true });
  }

  startTurn() {
    const turnId = `turn_${Date.now()}`;
    const timing = {
      turnId,
      vadSilenceDetectedAt: performance.now(),
      sttStartAt:           null,
      sttEndAt:             null,
      sttDurationMs:        null,
      llmStartAt:           null,
      llmFirstTokenAt:      null,
      llmDurationMs:        null,
      ttsStartAt:           null,
      ttsFirstChunkAt:      null,
      ttsFirstChunkMs:      null,
      firstAudioSentAt:     null,
      ttfbMs:               null,
    };
    console.log(`[TTFB] Turn ${turnId} started (VAD silence detected)`);
    return timing;
  }

  finishTurn(timing) {
    // Compute durations
    if (timing.sttEndAt && timing.sttStartAt) {
      timing.sttDurationMs = round(timing.sttEndAt - timing.sttStartAt);
    }
    if (timing.llmFirstTokenAt && timing.llmStartAt) {
      timing.llmDurationMs = round(timing.llmFirstTokenAt - timing.llmStartAt);
    }
    if (timing.ttsFirstChunkAt && timing.ttsStartAt) {
      timing.ttsFirstChunkMs = round(timing.ttsFirstChunkAt - timing.ttsStartAt);
    }
    if (timing.firstAudioSentAt && timing.vadSilenceDetectedAt) {
      timing.ttfbMs = round(timing.firstAudioSentAt - timing.vadSilenceDetectedAt);
    }

    this.turns.push(timing);
    console.log(
      `[TTFB] Turn ${timing.turnId} complete | ` +
      `STT=${timing.sttDurationMs}ms | ` +
      `LLM first token=${timing.llmDurationMs}ms | ` +
      `TTS first chunk=${timing.ttsFirstChunkMs}ms | ` +
      `TTFB=${timing.ttfbMs}ms`
    );

    appendFileSync(this.logFile, JSON.stringify(timing) + "\n");
  }

  printSummary() {
    const completed = this.turns.filter((t) => t.ttfbMs !== null);
    if (!completed.length) { console.log("No completed turns yet."); return; }

    console.log(`\n${"=".repeat(55)}`);
    console.log(`  TTFB SUMMARY  (${completed.length} turns)`);
    console.log("=".repeat(55));

    for (const [label, key] of [
      ["STT duration (ms)",    "sttDurationMs"],
      ["LLM first token (ms)", "llmDurationMs"],
      ["TTS first chunk (ms)", "ttsFirstChunkMs"],
      ["TTFB total (ms)",      "ttfbMs"],
    ]) {
      const vals = completed.map((t) => t[key]).filter((v) => v !== null);
      if (!vals.length) continue;
      const s = computeStats(vals);
      console.log(`  ${label.padEnd(25)} min=${s.min}  avg=${s.avg}  p50=${s.p50}  p95=${s.p95}  max=${s.max}`);
    }
    console.log("=".repeat(55) + "\n");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART B – Standalone TTFB probe bot
// ═══════════════════════════════════════════════════════════════════════════════

import { Room, RoomEvent, TrackKind, AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource, AudioFrame } from "@livekit/rtc-node";
import { writeFileSync } from "fs";
import minimist from "minimist";

import { loadEnv, getEnv, getEnvInt } from "./env.js";
import { getToken } from "./token_generator.js";
import { computeStats, sleep, generateTone, generateSilence, splitIntoFrames, round } from "./utils.js";

loadEnv();

const SAMPLE_RATE         = 16000;
const CHANNELS            = 1;
const SAMPLES_PER_FRAME   = 960;
const RESPONSE_TIMEOUT_MS = 20000;

async function runTTFBProbe(url, token, runs) {
  const results = [];

  for (let runId = 1; runId <= runs; runId++) {
    const room = new Room();
    let firstAudioTime      = 0;
    let firstAudioReceived  = false;
    let resolveFirstAudio;
    const firstAudioPromise = new Promise((res) => { resolveFirstAudio = res; });

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
      const track  = LocalAudioTrack.createAudioTrack("probe", source);
      const opts   = new TrackPublishOptions();
      opts.source  = TrackSource.SOURCE_MICROPHONE;
      await room.localParticipant.publishTrack(track, opts);

      // Warmup silence (1s)
      const warmup = splitIntoFrames(generateSilence(SAMPLE_RATE, 1000), SAMPLES_PER_FRAME);
      for (const buf of warmup) {
        await source.captureFrame(new AudioFrame(buf, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME));
        await sleep(Math.floor(SAMPLES_PER_FRAME / SAMPLE_RATE * 1000));
      }

      // Speech burst: 1.5s tone to trigger VAD
      const burst = splitIntoFrames(generateTone(SAMPLE_RATE, 440, 1500), SAMPLES_PER_FRAME);
      for (const buf of burst) {
        await source.captureFrame(new AudioFrame(buf, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME));
        await sleep(Math.floor(SAMPLES_PER_FRAME / SAMPLE_RATE * 1000));
      }

      // Silence after burst (simulates user stopped talking)
      const speechEndAt = performance.now();
      const trailing = splitIntoFrames(generateSilence(SAMPLE_RATE, 500), SAMPLES_PER_FRAME);
      for (const buf of trailing) {
        await source.captureFrame(new AudioFrame(buf, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME));
        await sleep(Math.floor(SAMPLES_PER_FRAME / SAMPLE_RATE * 1000));
      }

      // Wait for response
      const winner = await Promise.race([
        firstAudioPromise.then(() => "packet"),
        sleep(RESPONSE_TIMEOUT_MS).then(() => "timeout"),
      ]);

      if (winner === "packet") {
        const ttfbMs = firstAudioTime - speechEndAt;
        results.push(ttfbMs);
        console.log(`  Run ${runId}: ✅ TTFB = ${ttfbMs.toFixed(1)} ms`);
      } else {
        console.log(`  Run ${runId}: ⏰ Timed out`);
      }
    } catch (err) {
      console.log(`  Run ${runId}: ❌ Error – ${err.message}`);
    } finally {
      await room.disconnect();
      await sleep(2000);
    }
  }

  if (results.length) {
    const s = computeStats(results);
    console.log(`\n${"=".repeat(50)}`);
    console.log(`  TTFB PROBE RESULTS (${results.length} successful runs)`);
    console.log(`  Min:  ${s.min.toFixed(1)} ms`);
    console.log(`  Avg:  ${s.avg.toFixed(1)} ms`);
    console.log(`  P50:  ${s.p50.toFixed(1)} ms`);
    console.log(`  P95:  ${s.p95.toFixed(1)} ms`);
    console.log(`  Max:  ${s.max.toFixed(1)} ms`);
    console.log("=".repeat(50) + "\n");

    mkdirSync("results", { recursive: true });
    const outPath = resolve("results", "test3_ttfb.json");
    writeFileSync(outPath, JSON.stringify({ runs: results, summary: s }, null, 2));
    console.log(`  Results saved → ${outPath}`);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (process.argv[1].endsWith("test3_ttfb.js")) {
  const args = minimist(process.argv.slice(2), {
    string:  ["url", "token", "api-key", "api-secret", "room", "agent-name"],
    default: {
      "url":         getEnv("LIVEKIT_URL"),
      "token":       getEnv("LIVEKIT_TOKEN"),
      "api-key":     getEnv("LIVEKIT_API_KEY"),
      "api-secret":  getEnv("LIVEKIT_API_SECRET"),
      "room":        getEnv("LIVEKIT_ROOM", "latency-test-room"),
      "agent-name":  getEnv("LIVEKIT_AGENT_NAME"),
      "runs":        getEnvInt("TEST_RUNS", 10),
    },
  });

  if (!args.url) {
    console.error("ERROR: --url is required (or set LIVEKIT_URL in .env)");
    process.exit(1);
  }

  if (!args["agent-name"]) {
    console.warn("WARNING: --agent-name not set (LIVEKIT_AGENT_NAME in .env).");
    console.warn("         The agent must join the room on its own for the test to work.\n");
  }

  try {
    const token = await getToken({
      cliToken:  args.token,
      apiKey:    args["api-key"],
      apiSecret: args["api-secret"],
      room:      args.room,
      agentName: args["agent-name"],
    });
    await runTTFBProbe(args.url, token, Number(args.runs));
  } catch (err) {
    console.error("ERROR:", err.message);
    process.exit(1);
  }
}
