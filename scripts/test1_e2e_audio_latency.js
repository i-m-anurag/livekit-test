/**
 * TEST 1: End-to-End Audio Latency
 * =================================
 * Measures: microphone send → LiveKit SFU → AI agent → audio response back to client
 * Approach: Bot joins room with agentName in room metadata so LiveKit auto-dispatches
 *           the agent. Sends a probe tone, measures time until first audio packet
 *           received back from the agent.
 *
 * How agent dispatch works in your setup:
 *   1. Bot connects to room, passing agentName in room metadata
 *   2. LiveKit sees the new room and dispatches the named agent automatically
 *   3. Agent auto-joins the same room (no direct connection to agent server needed)
 *   4. Bot detects agent's audio track → starts probe → measures E2E latency
 *
 * Usage:
 *   node scripts/test1_e2e_audio_latency.js
 *   node scripts/test1_e2e_audio_latency.js --agent-name my-agent --runs 20
 */

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
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import minimist from "minimist";

import { loadEnv, getEnv, getEnvInt, getEnvFloat } from "./env.js";
import { getToken } from "./token_generator.js";
import { computeStats, printSep, sleep, generateTone, generateSilence, splitIntoFrames } from "./utils.js";

loadEnv();

// ── Config ─────────────────────────────────────────────────────────────────
const SAMPLE_RATE           = 16000;
const CHANNELS              = 1;
const SAMPLES_PER_FRAME     = 960;
const WARMUP_SILENCE_MS     = 600;
const PROBE_TONE_FREQ       = 440;
const PROBE_DURATION_MS     = 1000;
const AGENT_JOIN_TIMEOUT_MS = 10000;
const RESPONSE_TIMEOUT_MS   = 15000;

// ── Single probe run ────────────────────────────────────────────────────────

async function runSingleProbe(url, token, agentName, runId) {
  const result = {
    runId,
    agentName,
    roomConnectedAt:       0,
    agentJoinedAt:         0,
    probeSentAt:           0,
    firstPacketReceivedAt: 0,
    agentJoinMs:          -1,
    e2eLatencyMs:         -1,
    connected:            false,
    agentJoined:          false,
    timedOut:             false,
    error:                null,
  };

  const room = new Room();

  // ── Promise: agent joins the room ────────────────────────────────────────
  let resolveAgentJoined;
  const agentJoinedPromise = new Promise((res) => { resolveAgentJoined = res; });

  // ── Promise: first audio packet from agent ───────────────────────────────
  let firstPacketReceived = false;
  let resolveFirstPacket;
  const firstPacketPromise = new Promise((res) => { resolveFirstPacket = res; });

  // Any participant that is NOT our bot = the agent
  room.on(RoomEvent.ParticipantConnected, (participant) => {
    const botPrefix = getEnv("BOT_IDENTITY_PREFIX", "latency-bot");
    if (!participant.identity.startsWith(botPrefix) && !result.agentJoined) {
      result.agentJoined   = true;
      result.agentJoinedAt = performance.now();
      result.agentJoinMs   = result.agentJoinedAt - result.roomConnectedAt;
      console.log(`    Agent "${participant.identity}" joined in ${result.agentJoinMs.toFixed(0)} ms`);
      resolveAgentJoined();
    }
  });

  // Listen for agent's outgoing audio track
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === TrackKind.KIND_AUDIO) {
      (async () => {
        for await (const _frame of track.stream) {
          if (!firstPacketReceived) {
            firstPacketReceived = true;
            result.firstPacketReceivedAt = performance.now();
            resolveFirstPacket();
          }
          break;
        }
      })();
    }
  });

  try {
    // ── Connect — agent dispatch happens via token metadata (set in token_generator.js)
    await room.connect(url, token);
    result.roomConnectedAt = performance.now();
    result.connected = true;
    console.log(`    Connected to room "${room.name}"`);

    // ── Wait for agent to auto-join ───────────────────────────────────────────
    if (agentName) {
      console.log(`    Waiting for agent "${agentName}" to join...`);
      const agentWinner = await Promise.race([
        agentJoinedPromise.then(() => "joined"),
        sleep(AGENT_JOIN_TIMEOUT_MS).then(() => "timeout"),
      ]);
      if (agentWinner === "timeout") {
        console.log(`    ⚠️  Agent did not join within ${AGENT_JOIN_TIMEOUT_MS / 1000}s`);
        console.log(`       Verify LIVEKIT_AGENT_NAME matches the name in your agent's WorkerOptions`);
      }
    }

    // ── Publish mic audio source ───────────────────────────────────────────────
    const source = new AudioSource(SAMPLE_RATE, CHANNELS);
    const localTrack = LocalAudioTrack.createAudioTrack("probe-mic", source);
    const opts = new TrackPublishOptions();
    opts.source = TrackSource.SOURCE_MICROPHONE;
    await room.localParticipant.publishTrack(localTrack, opts);

    // ── Warmup silence ────────────────────────────────────────────────────────
    for (const buf of splitIntoFrames(generateSilence(SAMPLE_RATE, WARMUP_SILENCE_MS), SAMPLES_PER_FRAME)) {
      await source.captureFrame(new AudioFrame(buf, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME));
      await sleep(Math.floor(SAMPLES_PER_FRAME / SAMPLE_RATE * 1000));
    }

    // ── Send probe tone & mark timestamp ─────────────────────────────────────
    result.probeSentAt = performance.now();
    for (const buf of splitIntoFrames(generateTone(SAMPLE_RATE, PROBE_TONE_FREQ, PROBE_DURATION_MS), SAMPLES_PER_FRAME)) {
      await source.captureFrame(new AudioFrame(buf, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME));
      await sleep(Math.floor(SAMPLES_PER_FRAME / SAMPLE_RATE * 1000));
    }

    // ── Wait for first agent audio response ───────────────────────────────────
    const winner = await Promise.race([
      firstPacketPromise.then(() => "packet"),
      sleep(RESPONSE_TIMEOUT_MS).then(() => "timeout"),
    ]);

    if (winner === "packet") {
      result.e2eLatencyMs = result.firstPacketReceivedAt - result.probeSentAt;
      console.log(
        `  Run ${runId}: ✅  E2E=${result.e2eLatencyMs.toFixed(1)} ms` +
        (result.agentJoinMs > 0 ? `  |  Agent joined in ${result.agentJoinMs.toFixed(0)} ms` : "")
      );
    } else {
      result.timedOut = true;
      console.log(`  Run ${runId}: ⏰  Timed out after ${RESPONSE_TIMEOUT_MS / 1000}s`);
    }

  } catch (err) {
    result.error = err.message;
    console.log(`  Run ${runId}: ❌  Error – ${err.message}`);
  } finally {
    await room.disconnect();
  }

  return result;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(url, token, agentName, runs, delayMs, resultsDir) {
  printSep();
  console.log("  TEST 1 – End-to-End Audio Latency");
  console.log(`  Server     : ${url}`);
  console.log(`  Agent name : ${agentName || "(not set — agent must join independently)"}`);
  console.log(`  Runs       : ${runs}   |   Delay: ${delayMs / 1000}s`);
  printSep();
  console.log();

  const allRuns = [];
  for (let i = 1; i <= runs; i++) {
    const result = await runSingleProbe(url, token, agentName, i);
    allRuns.push(result);
    if (i < runs) await sleep(delayMs);
  }

  const successful = allRuns.filter((r) => r.e2eLatencyMs > 0);
  const e2eStats   = computeStats(successful.map((r) => r.e2eLatencyMs));
  const joinStats  = computeStats(successful.filter((r) => r.agentJoinMs > 0).map((r) => r.agentJoinMs));
  const failed     = allRuns.filter((r) => r.timedOut || r.error);

  console.log();
  printSep();
  console.log("  SUMMARY");
  printSep();
  console.log(`  ${"total_runs".padEnd(22)} ${runs}`);
  console.log(`  ${"successful_runs".padEnd(22)} ${successful.length}`);
  console.log(`  ${"failed/timed_out".padEnd(22)} ${failed.length}`);

  if (e2eStats) {
    console.log("\n  E2E Latency (probe sent → first audio packet back):");
    for (const [k, v] of Object.entries(e2eStats)) {
      console.log(`    ${k.padEnd(6)} ${v.toFixed(1)} ms`);
    }
  }
  if (joinStats) {
    console.log("\n  Agent Join Time (room connect → agent joined room):");
    for (const [k, v] of Object.entries(joinStats)) {
      console.log(`    ${k.padEnd(6)} ${v.toFixed(1)} ms`);
    }
  }

  mkdirSync(resultsDir, { recursive: true });
  const outPath = resolve(resultsDir, "test1_e2e_latency.json");
  writeFileSync(outPath, JSON.stringify({
    summary: {
      total_runs: runs, successful_runs: successful.length, failed: failed.length,
      e2e_latency_ms: e2eStats, agent_join_ms: joinStats,
    },
    runs: allRuns,
  }, null, 2));
  console.log(`\n  Results saved → ${outPath}`);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = minimist(process.argv.slice(2), {
  string:  ["url", "token", "api-key", "api-secret", "room", "agent-name", "results-dir"],
  default: {
    "url":         getEnv("LIVEKIT_URL"),
    "token":       getEnv("LIVEKIT_TOKEN"),
    "api-key":     getEnv("LIVEKIT_API_KEY"),
    "api-secret":  getEnv("LIVEKIT_API_SECRET"),
    "room":        getEnv("LIVEKIT_ROOM", "latency-test-room"),
    "agent-name":  getEnv("LIVEKIT_AGENT_NAME"),
    "runs":        getEnvInt("TEST_RUNS", 10),
    "delay":       getEnvFloat("TEST_DELAY", 2.0),
    "results-dir": getEnv("RESULTS_DIR", "results"),
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

const token = await getToken({
  cliToken:  args.token,
  apiKey:    args["api-key"],
  apiSecret: args["api-secret"],
  room:      args.room,
}).catch((err) => { console.error("ERROR:", err.message); process.exit(1); });

await main(args.url, token, args["agent-name"], Number(args.runs), Number(args.delay) * 1000, args["results-dir"]);
