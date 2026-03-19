/**
 * Results Analyzer — Reads all test results and prints consolidated summary
 *
 * Usage:
 *   node scripts/analyze_results.js
 *   node scripts/analyze_results.js --results-dir /path/to/results
 */

import { readFileSync, existsSync, createReadStream } from "fs";
import { resolve } from "path";
import { createInterface } from "readline";
import minimist from "minimist";

import { loadEnv, getEnv } from "./env.js";
import { computeStats, printMetric } from "./utils.js";

loadEnv();

function loadJSON(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    return null;
  }
}

async function readJSONL(filePath) {
  const lines = [];
  const rl = createInterface({ input: createReadStream(filePath) });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      lines.push(JSON.parse(t));
    } catch (_) {}
  }
  return lines;
}

function sep(char = "-", width = 60) {
  console.log(char.repeat(width));
}

async function analyze(resultsDir) {
  console.log(`\n${"=".repeat(60)}`);
  console.log("  LIVEKIT LATENCY TEST RESULTS");
  console.log(`  Generated : ${new Date().toLocaleString()}`);
  console.log(`  Directory : ${resultsDir}`);
  console.log("=".repeat(60));

  // ── E2E Latency + Agent Dispatch ─────────────────────────────
  const t1Path = resolve(resultsDir, "test_e2e_latency.json");
  if (existsSync(t1Path)) {
    const data = loadJSON(t1Path);
    if (data?.summary) {
      const s = data.summary;
      console.log();
      sep();
      console.log("  E2E Audio Latency + Agent Dispatch");
      sep();
      printMetric("Runs", `${s.successful}/${s.total_runs} successful`, "");

      if (s.e2e_latency_ms) {
        console.log("\n  E2E Latency (probe sent -> agent audio back):");
        for (const [k, v] of Object.entries(s.e2e_latency_ms)) {
          printMetric(`    ${k}`, v);
        }
        if (s.e2e_latency_ms.p95 > 3000)
          console.log("  !! P95 > 3s — investigate agent processing");
        else if (s.e2e_latency_ms.p95 > 1500)
          console.log("  !  P95 > 1.5s — room for improvement");
        else console.log("  OK P95 < 1.5s");
      }

      if (s.agent_dispatch_ms) {
        console.log("\n  Agent Dispatch (room created -> agent joined):");
        for (const [k, v] of Object.entries(s.agent_dispatch_ms)) {
          printMetric(`    ${k}`, v);
        }
        if (s.agent_dispatch_ms.p95 > 5000)
          console.log("  !! P95 > 5s — agent startup is slow");
        else if (s.agent_dispatch_ms.p95 > 2000)
          console.log("  !  P95 > 2s — agent dispatch could be faster");
        else console.log("  OK P95 < 2s");
      }
    }
  } else {
    console.log("\n  E2E Latency: No results (run npm run test:e2e)");
  }

  // ── TTFB ────────────────────────────────────────────────────
  const t3Path = resolve(resultsDir, "test_ttfb.json");
  if (existsSync(t3Path)) {
    const data = loadJSON(t3Path);
    if (data?.summary) {
      const s = data.summary;
      console.log();
      sep();
      console.log("  TTFB (User stops talking -> Agent first audio byte)");
      sep();
      for (const [k, v] of Object.entries(s)) {
        printMetric(`  ${k}`, v);
      }
      if (s.p95 > 2500)
        console.log("  !! P95 > 2.5s — LLM or TTS bottleneck");
      else if (s.p95 > 1200)
        console.log("  !  P95 > 1.2s — acceptable for complex queries");
      else console.log("  OK P95 < 1.2s");
    }
  } else {
    console.log("\n  TTFB: No results (run npm run test:ttfb)");
  }

  // ── Agent Pipeline JSONL (from agent-side instrumentation) ──
  const agentPath = resolve(resultsDir, "ttfb_agent.jsonl");
  if (existsSync(agentPath)) {
    const turns = await readJSONL(agentPath);
    if (turns.length) {
      console.log();
      sep();
      console.log("  Agent Pipeline Breakdown (from agent-side instrumentation)");
      sep();
      for (const [label, field] of [
        ["STT duration", "sttDurationMs"],
        ["LLM first token", "llmFirstTokenMs"],
        ["TTS first chunk", "ttsFirstChunkMs"],
        ["Total TTFB", "ttfbMs"],
      ]) {
        const vals = turns.map((t) => t[field]).filter((v) => v != null);
        if (!vals.length) continue;
        const s = computeStats(vals);
        console.log(
          `  ${label.padEnd(22)} avg=${s.avg}ms  p95=${s.p95}ms  max=${s.max}ms`
        );
      }
      console.log(`\n  Total turns: ${turns.length}`);
    }
  }

  // ── Network RTT ─────────────────────────────────────────────
  const t5Path = resolve(resultsDir, "test_network_rtt.json");
  if (existsSync(t5Path)) {
    const data = loadJSON(t5Path);
    if (data) {
      console.log();
      sep();
      console.log("  Network RTT");
      sep();

      if (data.dns?.avg) {
        printMetric("  DNS resolution avg", data.dns.avg);
      }
      if (data.tcp_rtt?.avg) {
        printMetric("  TCP RTT avg", data.tcp_rtt.avg);
        printMetric("  TCP RTT p95", data.tcp_rtt.p95);
        printMetric("  TCP jitter", data.tcp_rtt.jitter_ms);
        if (data.tcp_rtt.avg > 100)
          console.log("  !! High RTT — consider server placement");
      }
      if (data.websocket?.avg) {
        printMetric("  WebSocket handshake avg", data.websocket.avg);
        printMetric("  WebSocket handshake p95", data.websocket.p95);
      }
      if (data.traceroute?.slowestHop) {
        const sh = data.traceroute.slowestHop;
        printMetric(`  Slowest hop (#${sh.hop})`, sh.avgMs);
      }
    }
  } else {
    console.log("\n  Network RTT: No results (run npm run test:network)");
  }

  // ── Reference Thresholds ────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log("  REFERENCE THRESHOLDS");
  console.log("=".repeat(60));
  console.log(`
  Metric                     Target       Investigate
  ────────────────────────   ──────────   ───────────
  E2E audio latency          < 1500ms     > 3000ms
  Agent dispatch time         < 2s         > 5s
  STT latency                < 400ms      > 800ms
  LLM first token            < 600ms      > 1500ms
  TTS first chunk            < 200ms      > 500ms
  TTFB (total)               < 1200ms     > 2500ms
  TCP RTT                    < 50ms       > 100ms
  WebSocket handshake        < 100ms      > 300ms
  DNS resolution             < 10ms       > 50ms
  SDP signaling RTT          < 100ms      > 300ms
  ICE connection time        < 300ms      > 1000ms
  Jitter                     < 20ms       > 50ms
  Packet loss                < 0.5%       > 2%
`);
  console.log("=".repeat(60));
}

// CLI
const args = minimist(process.argv.slice(2), {
  string: ["results-dir"],
  default: { "results-dir": getEnv("RESULTS_DIR", "results") },
});

await analyze(args["results-dir"]);
