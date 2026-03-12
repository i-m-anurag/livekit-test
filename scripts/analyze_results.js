/**
 * Results Analyzer
 * =================
 * Reads all JSON result files from the results/ folder and
 * prints a consolidated summary with bottleneck detection.
 *
 * Usage:
 *   node scripts/analyze_results.js
 *   node scripts/analyze_results.js --results-dir /path/to/results
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { createInterface } from "readline";
import { createReadStream } from "fs";
import minimist from "minimist";

import { loadEnv, getEnv } from "./env.js";
import { computeStats } from "./utils.js";

loadEnv();

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadJSON(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.log(`  ⚠️  Could not read ${filePath}: ${err.message}`);
    return null;
  }
}

async function readJSONL(filePath) {
  const lines = [];
  const rl = createInterface({ input: createReadStream(filePath) });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try { lines.push(JSON.parse(t)); } catch (_) {}
  }
  return lines;
}

function printSep(char = "─", width = 60) {
  console.log(char.repeat(width));
}

function metric(label, value, unit = "ms", width = 28) {
  if (value == null) return `  ${label.padEnd(width)} N/A`;
  return `  ${label.padEnd(width)} ${value} ${unit}`;
}

// ── Analyze ───────────────────────────────────────────────────────────────────

async function analyze(resultsDir) {
  console.log(`\n${"=".repeat(60)}`);
  console.log("  LIVEKIT LATENCY TEST RESULTS");
  console.log(`  Generated: ${new Date().toLocaleString()}`);
  console.log(`  Results dir: ${resultsDir}`);
  console.log("=".repeat(60));

  // ── Test 1: E2E Audio Latency ─────────────────────────────────────────────
  const t1Path = resolve(resultsDir, "test1_e2e_latency.json");
  if (existsSync(t1Path)) {
    const data = loadJSON(t1Path);
    if (data?.summary) {
      const s = data.summary;
      console.log(); printSep();
      console.log("  TEST 1 – End-to-End Audio Latency");
      printSep();
      console.log(metric("Min",  s.min));
      console.log(metric("Avg",  s.avg));
      console.log(metric("P50",  s.p50));
      console.log(metric("P95",  s.p95));
      console.log(metric("P99",  s.p99));
      console.log(metric("Max",  s.max));
      const failed = (data.runs || []).filter((r) => r.timedOut || r.error);
      console.log(`\n  Runs: ${(data.runs || []).length} total, ${failed.length} failed/timed-out`);
      if      (s.p95 > 500) console.log("  ⚠️  P95 > 500ms — investigate agent processing time");
      else if (s.p95 > 300) console.log("  ⚠️  P95 > 300ms — acceptable but room for improvement");
      else                  console.log("  ✅  P95 < 300ms — good latency");
    }
  } else {
    console.log("\n  TEST 1: No results found (run test1_e2e_audio_latency.js)");
  }

  // ── Test 3: TTFB ──────────────────────────────────────────────────────────
  const t3Path = resolve(resultsDir, "test3_ttfb.json");
  if (existsSync(t3Path)) {
    const data = loadJSON(t3Path);
    if (data?.summary) {
      const s = data.summary;
      console.log(); printSep();
      console.log("  TEST 3 – Time to First Audio Byte (TTFB)");
      printSep();
      console.log(metric("Min", s.min));
      console.log(metric("Avg", s.avg));
      console.log(metric("P50", s.p50));
      console.log(metric("P95", s.p95));
      console.log(metric("Max", s.max));
      if      (s.p95 > 2000) console.log("  ⚠️  P95 > 2s — LLM or TTS is the likely bottleneck");
      else if (s.p95 > 1000) console.log("  ⚠️  P95 > 1s — acceptable for complex queries");
      else                   console.log("  ✅  P95 < 1s — good TTFB");
    }
  } else {
    console.log("\n  TEST 3: No results found (run test3_ttfb.js)");
  }

  // ── Test 5: Network RTT ───────────────────────────────────────────────────
  const t5Path = resolve(resultsDir, "test5_network_rtt.json");
  if (existsSync(t5Path)) {
    const data = loadJSON(t5Path);
    if (data) {
      console.log(); printSep();
      console.log("  TEST 5 – Network RTT");
      printSep();
      for (const [label, key] of [["LiveKit server", "livekit"]]) {
        const d = data[key];
        if (d?.avg_ms) {
          console.log(`\n  ${label} (${d.host}:${d.port})`);
          console.log(metric("  Avg RTT", d.avg_ms));
          console.log(metric("  P95 RTT", d.p95_ms));
          console.log(metric("  Jitter",  d.jitter_ms));
          if (d.avg_ms > 100) console.log(`  ⚠️  High RTT (${d.avg_ms}ms) — consider moving server closer`);
          else                console.log(`  ✅  RTT looks good (${d.avg_ms}ms)`);
        }
      }
      if (data.websocket?.avg_ms) {
        console.log("\n  WebSocket handshake");
        console.log(metric("  Avg", data.websocket.avg_ms));
        console.log(metric("  P95", data.websocket.p95_ms));
      }
      if (data.dns) {
        console.log("\n  DNS Resolution");
        for (const [k, v] of Object.entries(data.dns)) {
          if (v?.avg_ms) console.log(metric(`  ${k} avg`, v.avg_ms));
        }
      }
    }
  } else {
    console.log("\n  TEST 5: No results found (run test5_network_rtt.js)");
  }

  // ── Agent pipeline JSONL ──────────────────────────────────────────────────
  const agentPath = resolve(resultsDir, "ttfb_agent.jsonl");
  if (existsSync(agentPath)) {
    const turns = await readJSONL(agentPath);
    if (turns.length) {
      console.log(); printSep();
      console.log("  AGENT PIPELINE TIMING (from agent logs)");
      printSep();
      for (const [label, field] of [
        ["STT duration",    "sttDurationMs"],
        ["LLM first token", "llmDurationMs"],
        ["TTS first chunk", "ttsFirstChunkMs"],
        ["Total TTFB",      "ttfbMs"],
      ]) {
        const vals = turns.map((t) => t[field]).filter((v) => v != null);
        if (!vals.length) continue;
        const s = computeStats(vals);
        console.log(`  ${label.padEnd(22)} avg=${s.avg}ms  p95=${s.p95}ms  max=${s.max}ms`);
      }
      console.log(`\n  Total turns analyzed: ${turns.length}`);
    }
  } else {
    console.log("\n  AGENT PIPELINE: No JSONL logs found (add TTFBInstrumentation to agent code)");
  }

  // ── Bottleneck checklist ──────────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log("  BOTTLENECK CHECKLIST");
  console.log("=".repeat(60));
  console.log(`
  Compare your numbers to these targets:

  Metric                   Target      Investigate if
  ─────────────────────    ─────────   ───────────────
  TCP RTT to LiveKit       < 50ms      > 100ms
  ICE connection time      < 300ms     > 1000ms
  SDP round-trip           < 100ms     > 300ms
  STT latency              < 400ms     > 800ms
  LLM first token          < 600ms     > 1500ms
  TTS first chunk          < 200ms     > 500ms
  TTFB (total)             < 1200ms    > 2500ms
  E2E audio latency        < 1500ms    > 3000ms
  Jitter                   < 20ms      > 50ms
  Packet loss              < 0.5%      > 2%
`);
  console.log("=".repeat(60) + "\n");
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = minimist(process.argv.slice(2), {
  string:  ["results-dir"],
  default: { "results-dir": getEnv("RESULTS_DIR", "results") },
});

await analyze(args["results-dir"]);
