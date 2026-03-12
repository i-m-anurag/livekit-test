/**
 * TEST 5: Network RTT – Client ↔ LiveKit Server
 * ================================================
 * Measures:
 *   - TCP connection RTT to LiveKit server
 *   - WebSocket handshake latency
 *   - DNS resolution latency
 *   - Traceroute hop analysis
 *
 * NOTE: No agent host/port needed. Your agent auto-joins rooms via
 *       LiveKit dispatch — the agent's network path is internal to
 *       LiveKit and not directly measurable from the client side.
 *
 * Usage:
 *   node scripts/test5_network_rtt.js
 *   node scripts/test5_network_rtt.js --livekit-host your-server.com --runs 20
 */

import net from "net";
import dns from "dns/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import WebSocket from "ws";
import minimist from "minimist";

import { loadEnv, getEnv, getEnvInt } from "./env.js";
import { computeStats, sleep, round } from "./utils.js";

loadEnv();

const execFileAsync = promisify(execFile);

// ── TCP RTT ───────────────────────────────────────────────────────────────────

async function measureTCPRtt(host, port, runs = 20) {
  console.log(`\n  TCP RTT → ${host}:${port}`);
  const samples = [];

  for (let i = 1; i <= runs; i++) {
    const start = performance.now();
    try {
      await new Promise((resolve, reject) => {
        const socket = new net.Socket();
        socket.setTimeout(5000);
        socket.connect(port, host, () => { socket.destroy(); resolve(); });
        socket.on("error", reject);
        socket.on("timeout", () => { socket.destroy(); reject(new Error("timeout")); });
      });
      const rtt = round(performance.now() - start, 3);
      samples.push(rtt);
      console.log(`    [${String(i).padStart(3)}] ${rtt.toFixed(3)} ms`);
    } catch (err) {
      console.log(`    [${String(i).padStart(3)}] ERROR: ${err.message}`);
    }
    await sleep(100);
  }

  const stats = computeStats(samples);
  if (!stats) return { host, port, error: "all samples failed" };
  return {
    host, port,
    samples:    samples.length,
    min_ms:     stats.min,
    avg_ms:     stats.avg,
    p50_ms:     stats.p50,
    p95_ms:     stats.p95,
    max_ms:     stats.max,
    jitter_ms:  round(stats.max - stats.min, 3),
  };
}

// ── WebSocket Handshake RTT ───────────────────────────────────────────────────

async function measureWebSocketRtt(url, runs = 10) {
  console.log(`\n  WebSocket handshake RTT → ${url}`);
  const samples = [];

  for (let i = 1; i <= runs; i++) {
    const start = performance.now();
    try {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { handshakeTimeout: 5000 });
        ws.on("open", () => { ws.close(); resolve(); });
        ws.on("error", reject);
        setTimeout(() => { ws.terminate(); reject(new Error("timeout")); }, 5000);
      });
      const rtt = round(performance.now() - start, 3);
      samples.push(rtt);
      console.log(`    [${String(i).padStart(3)}] ${rtt.toFixed(3)} ms`);
    } catch (err) {
      console.log(`    [${String(i).padStart(3)}] ERROR: ${err.message}`);
    }
    await sleep(200);
  }

  if (!samples.length) return { url, error: "all handshakes failed" };
  const stats = computeStats(samples);
  return { url, samples: samples.length, ...stats };
}

// ── DNS Resolution ────────────────────────────────────────────────────────────

async function measureDnsResolution(host, runs = 10) {
  console.log(`\n  DNS Resolution → ${host}`);
  const samples = [];

  for (let i = 1; i <= runs; i++) {
    const start = performance.now();
    try {
      await dns.lookup(host);
      const rtt = round(performance.now() - start, 3);
      samples.push(rtt);
      console.log(`    [${String(i).padStart(3)}] ${rtt.toFixed(3)} ms`);
    } catch (err) {
      console.log(`    [${String(i).padStart(3)}] DNS ERROR: ${err.message}`);
    }
    await sleep(50);
  }

  if (!samples.length) return { host, error: "DNS resolution failed" };
  const stats = computeStats(samples);
  return { host, min_ms: stats.min, avg_ms: stats.avg, p95_ms: stats.p95 };
}

// ── Traceroute ────────────────────────────────────────────────────────────────

async function runTraceroute(host) {
  console.log(`\n  Traceroute → ${host}`);
  const platform = process.platform;
  let bin, args;

  if (platform === "win32")       { bin = "tracert";     args = ["-d", "-w", "1000", host]; }
  else if (platform === "darwin") { bin = "traceroute";  args = ["-n", "-w", "1", host]; }
  else                            { bin = "traceroute";  args = ["-n", "-w", "1", "-q", "3", host]; }

  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 60000 });
    console.log(stdout);
    return { host, traceroute_output: stdout };
  } catch (err) {
    if (err.code === "ENOENT") {
      const msg = "traceroute not installed. Install: apt install traceroute";
      console.log(`  ⚠️  ${msg}`);
      return { host, error: msg };
    }
    return { host, error: err.message };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main({ livekitHost, livekitPort, wsUrl, runs }) {
  console.log(`\n${"=".repeat(60)}`);
  console.log("  TEST 5 – Network RTT Analysis");
  console.log(`  LiveKit: ${livekitHost}:${livekitPort}`);
  if (wsUrl) console.log(`  WS URL : ${wsUrl}`);
  console.log(`  Runs   : ${runs}`);
  console.log("=".repeat(60));

  const allResults = {
    timestamp: new Date().toISOString(),
    livekit:   {},
    websocket: {},
    dns:       {},
    traceroute: {},
  };

  // 1. DNS
  allResults.dns.livekit = await measureDnsResolution(livekitHost);

  // 2. TCP RTT to LiveKit
  allResults.livekit = await measureTCPRtt(livekitHost, livekitPort, runs);
  console.log(`\n  LiveKit TCP RTT summary:`, allResults.livekit);

  // 3. WebSocket handshake
  if (wsUrl) {
    allResults.websocket = await measureWebSocketRtt(wsUrl);
    console.log(`\n  WebSocket RTT summary:`, allResults.websocket);
  }

  // 4. Traceroute
  allResults.traceroute.livekit = await runTraceroute(livekitHost);

  // ── Save ────────────────────────────────────────────────────────────────────
  mkdirSync("results", { recursive: true });
  const outPath = resolve("results", "test5_network_rtt.json");
  writeFileSync(outPath, JSON.stringify(allResults, null, 2));

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log("  NETWORK RTT SUMMARY");
  console.log("=".repeat(60));
  const lk = allResults.livekit;
  if (lk?.avg_ms) {
    console.log(`  LiveKit    avg=${lk.avg_ms} ms  p95=${lk.p95_ms} ms  jitter=${lk.jitter_ms} ms`);
    if (lk.avg_ms > 100) console.log(`  ⚠️  High RTT (${lk.avg_ms}ms) — consider moving LiveKit server closer`);
    else                 console.log(`  ✅  RTT looks good (${lk.avg_ms}ms)`);
  }
  if (allResults.websocket?.avg_ms) {
    console.log(`  WebSocket  avg=${allResults.websocket.avg_ms} ms  p95=${allResults.websocket.p95_ms} ms`);
  }
  if (allResults.dns.livekit?.avg_ms) {
    console.log(`  DNS        avg=${allResults.dns.livekit.avg_ms} ms`);
  }
  console.log(`\n  Results saved → ${outPath}`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = minimist(process.argv.slice(2), {
  string:  ["livekit-host", "ws-url", "results-dir"],
  default: {
    "livekit-host": getEnv("LIVEKIT_HOST"),
    "livekit-port": getEnvInt("LIVEKIT_PORT", 7880),
    "ws-url":       getEnv("LIVEKIT_WS_URL"),
    "runs":         getEnvInt("TEST_RUNS", 20),
    "results-dir":  getEnv("RESULTS_DIR", "results"),
  },
});

if (!args["livekit-host"]) {
  console.error("ERROR: --livekit-host is required (or set LIVEKIT_HOST in .env)");
  process.exit(1);
}

try {
  await main({
    livekitHost: args["livekit-host"],
    livekitPort: Number(args["livekit-port"]),
    wsUrl:       args["ws-url"] || null,
    runs:        Number(args.runs),
  });
} catch (err) {
  console.error("ERROR:", err.message);
  process.exit(1);
}
