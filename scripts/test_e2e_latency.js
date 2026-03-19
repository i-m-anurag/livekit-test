/**
 * TEST: E2E Audio Latency + Agent Dispatch Time
 * ===============================================
 * Measures:
 *   1. Agent dispatch time — room created → agent auto-joins
 *   2. E2E round-trip latency — probe tone sent → first audio packet received from agent
 *
 * Usage:
 *   node scripts/test_e2e_latency.js
 *   node scripts/test_e2e_latency.js --runs 20 --delay 3
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
import {
  computeStats,
  printSep,
  sleep,
  generateTone,
  generateSilence,
  splitIntoFrames,
  printMetric,
} from "./utils.js";

loadEnv();

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const SAMPLES_PER_FRAME = 960;
const WARMUP_SILENCE_MS = 600;
const PROBE_TONE_FREQ = 440;
const PROBE_DURATION_MS = 1000;
const AGENT_JOIN_TIMEOUT_MS = 15000;
const RESPONSE_TIMEOUT_MS = 20000;

async function runSingleProbe(url, token, agentName, runId) {
  const result = {
    runId,
    agentName,
    roomCreatedAt: 0,
    roomConnectedAt: 0,
    agentJoinedAt: 0,
    probeSentAt: 0,
    firstPacketReceivedAt: 0,
    agentDispatchMs: -1,
    e2eLatencyMs: -1,
    connected: false,
    agentJoined: false,
    timedOut: false,
    error: null,
  };

  const roomCreatedAt = performance.now();
  result.roomCreatedAt = roomCreatedAt;

  const room = new Room();

  let resolveAgentJoined;
  const agentJoinedPromise = new Promise((res) => {
    resolveAgentJoined = res;
  });

  let firstPacketReceived = false;
  let resolveFirstPacket;
  const firstPacketPromise = new Promise((res) => {
    resolveFirstPacket = res;
  });

  // Detect agent joining (any participant that isn't our bot)
  room.on(RoomEvent.ParticipantConnected, (participant) => {
    const botPrefix = getEnv("BOT_IDENTITY_PREFIX", "latency-bot");
    if (!participant.identity.startsWith(botPrefix) && !result.agentJoined) {
      result.agentJoined = true;
      result.agentJoinedAt = performance.now();
      result.agentDispatchMs = result.agentJoinedAt - result.roomCreatedAt;
      console.log(
        `    Agent "${participant.identity}" joined | dispatch=${result.agentDispatchMs.toFixed(0)}ms`
      );
      resolveAgentJoined();
    }
  });

  // Listen for agent's audio track
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
    // Connect — agent dispatch happens via token metadata
    await room.connect(url, token);
    result.roomConnectedAt = performance.now();
    result.connected = true;
    console.log(`    Connected to room "${room.name}"`);

    // Wait for agent
    if (agentName) {
      console.log(`    Waiting for agent "${agentName}"...`);
      const agentWinner = await Promise.race([
        agentJoinedPromise.then(() => "joined"),
        sleep(AGENT_JOIN_TIMEOUT_MS).then(() => "timeout"),
      ]);
      if (agentWinner === "timeout") {
        console.log(
          `    WARNING: Agent did not join within ${AGENT_JOIN_TIMEOUT_MS / 1000}s`
        );
      }
    }

    // Publish mic audio source
    const source = new AudioSource(SAMPLE_RATE, CHANNELS);
    const localTrack = LocalAudioTrack.createAudioTrack("probe-mic", source);
    const opts = new TrackPublishOptions();
    opts.source = TrackSource.SOURCE_MICROPHONE;
    await room.localParticipant.publishTrack(localTrack, opts);

    // Warmup silence
    for (const buf of splitIntoFrames(
      generateSilence(SAMPLE_RATE, WARMUP_SILENCE_MS),
      SAMPLES_PER_FRAME
    )) {
      await source.captureFrame(
        new AudioFrame(buf, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME)
      );
      await sleep(Math.floor((SAMPLES_PER_FRAME / SAMPLE_RATE) * 1000));
    }

    // Send probe tone
    result.probeSentAt = performance.now();
    for (const buf of splitIntoFrames(
      generateTone(SAMPLE_RATE, PROBE_TONE_FREQ, PROBE_DURATION_MS),
      SAMPLES_PER_FRAME
    )) {
      await source.captureFrame(
        new AudioFrame(buf, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME)
      );
      await sleep(Math.floor((SAMPLES_PER_FRAME / SAMPLE_RATE) * 1000));
    }

    // Wait for agent response
    const winner = await Promise.race([
      firstPacketPromise.then(() => "packet"),
      sleep(RESPONSE_TIMEOUT_MS).then(() => "timeout"),
    ]);

    if (winner === "packet") {
      result.e2eLatencyMs = result.firstPacketReceivedAt - result.probeSentAt;
      console.log(
        `  Run ${runId}: E2E=${result.e2eLatencyMs.toFixed(1)}ms | Dispatch=${result.agentDispatchMs > 0 ? result.agentDispatchMs.toFixed(0) + "ms" : "N/A"}`
      );
    } else {
      result.timedOut = true;
      console.log(`  Run ${runId}: TIMED OUT (${RESPONSE_TIMEOUT_MS / 1000}s)`);
    }
  } catch (err) {
    result.error = err.message;
    console.log(`  Run ${runId}: ERROR - ${err.message}`);
  } finally {
    await room.disconnect();
  }

  return result;
}

async function main(url, token, agentName, runs, delayMs, resultsDir) {
  printSep();
  console.log("  TEST: E2E Audio Latency + Agent Dispatch Time");
  console.log(`  Server    : ${url}`);
  console.log(`  Agent     : ${agentName || "(not set)"}`);
  console.log(`  Runs      : ${runs}   |   Delay: ${delayMs / 1000}s`);
  printSep();
  console.log();

  const allRuns = [];
  for (let i = 1; i <= runs; i++) {
    const result = await runSingleProbe(url, token, agentName, i);
    allRuns.push(result);
    if (i < runs) await sleep(delayMs);
  }

  const successful = allRuns.filter((r) => r.e2eLatencyMs > 0);
  const e2eStats = computeStats(successful.map((r) => r.e2eLatencyMs));
  const dispatchStats = computeStats(
    successful.filter((r) => r.agentDispatchMs > 0).map((r) => r.agentDispatchMs)
  );
  const failed = allRuns.filter((r) => r.timedOut || r.error);

  console.log();
  printSep();
  console.log("  RESULTS");
  printSep();
  printMetric("Total runs", runs, "");
  printMetric("Successful", successful.length, "");
  printMetric("Failed/Timed out", failed.length, "");

  if (e2eStats) {
    console.log("\n  E2E Latency (probe sent -> first audio back):");
    for (const [k, v] of Object.entries(e2eStats)) {
      printMetric(`    ${k}`, v);
    }
  }
  if (dispatchStats) {
    console.log("\n  Agent Dispatch Time (room created -> agent joined):");
    for (const [k, v] of Object.entries(dispatchStats)) {
      printMetric(`    ${k}`, v);
    }
  }

  mkdirSync(resultsDir, { recursive: true });
  const outPath = resolve(resultsDir, "test_e2e_latency.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        test: "e2e_latency_and_dispatch",
        timestamp: new Date().toISOString(),
        config: { url, agentName, runs, delayMs },
        summary: {
          total_runs: runs,
          successful: successful.length,
          failed: failed.length,
          e2e_latency_ms: e2eStats,
          agent_dispatch_ms: dispatchStats,
        },
        runs: allRuns,
      },
      null,
      2
    )
  );
  console.log(`\n  Results saved -> ${outPath}`);
}

// CLI
const args = minimist(process.argv.slice(2), {
  string: ["url", "token", "api-key", "api-secret", "room", "agent-name", "results-dir"],
  default: {
    url: getEnv("LIVEKIT_URL"),
    token: getEnv("LIVEKIT_TOKEN"),
    "api-key": getEnv("LIVEKIT_API_KEY"),
    "api-secret": getEnv("LIVEKIT_API_SECRET"),
    room: getEnv("LIVEKIT_ROOM", "latency-test-room"),
    "agent-name": getEnv("LIVEKIT_AGENT_NAME"),
    runs: getEnvInt("TEST_RUNS", 10),
    delay: getEnvFloat("TEST_DELAY", 2.0),
    "results-dir": getEnv("RESULTS_DIR", "results"),
  },
});

if (!args.url) {
  console.error("ERROR: --url required (or set LIVEKIT_URL in .env)");
  process.exit(1);
}

const token = await getToken({
  cliToken: args.token,
  apiKey: args["api-key"],
  apiSecret: args["api-secret"],
  room: args.room,
  agentName: args["agent-name"],
}).catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});

await main(
  args.url,
  token,
  args["agent-name"],
  Number(args.runs),
  Number(args.delay) * 1000,
  args["results-dir"]
);
