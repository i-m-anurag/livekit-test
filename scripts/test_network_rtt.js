/**
 * TEST: Network RTT Analysis
 * ===========================
 * Measures:
 *   1. TCP RTT to LiveKit server
 *   2. WebSocket handshake latency
 *   3. DNS resolution time
 *   4. Traceroute hop latency (which hop is slowest)
 *
 * Usage:
 *   node scripts/test_network_rtt.js
 *   node scripts/test_network_rtt.js --livekit-host your-server.com --runs 20
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
import { computeStats, sleep, round, printSep, printMetric } from "./utils.js";

loadEnv();

const execFileAsync = promisify(execFile);

// ── TCP RTT ──────────────────────────────────────────────────────

async function measureTCPRtt(host, port, runs = 20) {
  console.log(`\n  TCP RTT -> ${host}:${port}`);
  const samples = [];

  for (let i = 1; i <= runs; i++) {
    const start = performance.now();
    try {
      await new Promise((res, rej) => {
        const socket = new net.Socket();
        socket.setTimeout(5000);
        socket.connect(port, host, () => {
          socket.destroy();
          res();
        });
        socket.on("error", rej);
        socket.on("timeout", () => {
          socket.destroy();
          rej(new Error("timeout"));
        });
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
    host,
    port,
    samples: samples.length,
    ...stats,
    jitter_ms: round(stats.max - stats.min, 3),
  };
}

// ── WebSocket Handshake RTT ──────────────────────────────────────

async function measureWebSocketRtt(url, runs = 10) {
  console.log(`\n  WebSocket Handshake RTT -> ${url}`);
  const samples = [];

  for (let i = 1; i <= runs; i++) {
    const start = performance.now();
    try {
      await new Promise((res, rej) => {
        const ws = new WebSocket(url, { handshakeTimeout: 5000 });
        ws.on("open", () => {
          ws.close();
          res();
        });
        ws.on("error", rej);
        setTimeout(() => {
          ws.terminate();
          rej(new Error("timeout"));
        }, 5000);
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

// ── DNS Resolution ───────────────────────────────────────────────

async function measureDnsResolution(host, runs = 10) {
  console.log(`\n  DNS Resolution -> ${host}`);
  const samples = [];

  for (let i = 1; i <= runs; i++) {
    const start = performance.now();
    try {
      const result = await dns.lookup(host);
      const rtt = round(performance.now() - start, 3);
      samples.push(rtt);
      console.log(`    [${String(i).padStart(3)}] ${rtt.toFixed(3)} ms -> ${result.address}`);
    } catch (err) {
      console.log(`    [${String(i).padStart(3)}] DNS ERROR: ${err.message}`);
    }
    await sleep(50);
  }

  if (!samples.length) return { host, error: "DNS resolution failed" };
  const stats = computeStats(samples);
  return { host, ...stats };
}

// ── Traceroute ───────────────────────────────────────────────────

async function runTraceroute(host) {
  console.log(`\n  Traceroute -> ${host}`);
  const platform = process.platform;
  let bin, args;

  if (platform === "win32") {
    bin = "tracert";
    args = ["-d", "-w", "1000", host];
  } else if (platform === "darwin") {
    bin = "traceroute";
    args = ["-n", "-w", "1", "-m", "20", host];
  } else {
    bin = "traceroute";
    args = ["-n", "-w", "1", "-q", "3", "-m", "20", host];
  }

  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 60000 });

    // Parse hops to find slowest
    const hops = [];
    for (const line of stdout.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.+)/);
      if (!match) continue;

      const hopNum = parseInt(match[1]);
      const times = [];
      const timeMatches = match[2].matchAll(/([\d.]+)\s*ms/g);
      for (const m of timeMatches) {
        times.push(parseFloat(m[1]));
      }

      if (times.length > 0) {
        const avgMs = round(times.reduce((a, b) => a + b, 0) / times.length, 2);
        hops.push({ hop: hopNum, avgMs, raw: match[2].trim() });
      }
    }

    // Find slowest hop
    let slowestHop = null;
    if (hops.length > 0) {
      slowestHop = hops.reduce((a, b) => (a.avgMs > b.avgMs ? a : b));
      console.log(`    Slowest hop: #${slowestHop.hop} (${slowestHop.avgMs}ms)`);
    }

    console.log(stdout);
    return { host, hops, slowestHop, totalHops: hops.length };
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("    traceroute not installed");
      return { host, error: "traceroute not installed" };
    }
    return { host, error: err.message };
  }
}

// ── Main ─────────────────────────────────────────────────────────

async function main({ livekitHost, livekitPort, wsUrl, runs }) {
  printSep();
  console.log("  TEST: Network RTT Analysis");
  console.log(`  LiveKit : ${livekitHost}:${livekitPort}`);
  if (wsUrl) console.log(`  WS URL  : ${wsUrl}`);
  console.log(`  Runs    : ${runs}`);
  printSep();

  const results = {
    test: "network_rtt",
    timestamp: new Date().toISOString(),
    dns: {},
    tcp_rtt: {},
    websocket: {},
    traceroute: {},
  };

  // 1. DNS
  results.dns = await measureDnsResolution(livekitHost);

  // 2. TCP RTT
  results.tcp_rtt = await measureTCPRtt(livekitHost, livekitPort, runs);

  // 3. WebSocket handshake
  if (wsUrl) {
    results.websocket = await measureWebSocketRtt(wsUrl);
  }

  // 4. Traceroute
  results.traceroute = await runTraceroute(livekitHost);

  // Summary
  console.log();
  printSep();
  console.log("  NETWORK RTT SUMMARY");
  printSep();

  if (results.dns?.avg) {
    printMetric("DNS resolution avg", results.dns.avg);
  }
  if (results.tcp_rtt?.avg) {
    printMetric("TCP RTT avg", results.tcp_rtt.avg);
    printMetric("TCP RTT p95", results.tcp_rtt.p95);
    printMetric("TCP jitter", results.tcp_rtt.jitter_ms);
    if (results.tcp_rtt.avg > 100) {
      console.log("  WARNING: High RTT — consider moving server closer");
    }
  }
  if (results.websocket?.avg) {
    printMetric("WebSocket handshake avg", results.websocket.avg);
    printMetric("WebSocket handshake p95", results.websocket.p95);
  }
  if (results.traceroute?.slowestHop) {
    const sh = results.traceroute.slowestHop;
    printMetric(`Slowest hop (#${sh.hop})`, sh.avgMs);
  }

  // Save
  mkdirSync("results", { recursive: true });
  const outPath = resolve("results", "test_network_rtt.json");
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n  Results saved -> ${outPath}`);
}

// CLI
const args = minimist(process.argv.slice(2), {
  string: ["livekit-host", "ws-url"],
  default: {
    "livekit-host": getEnv("LIVEKIT_HOST"),
    "livekit-port": getEnvInt("LIVEKIT_PORT", 7880),
    "ws-url": getEnv("LIVEKIT_WS_URL"),
    runs: getEnvInt("TEST_RUNS", 20),
  },
});

if (!args["livekit-host"]) {
  console.error("ERROR: --livekit-host required (or set LIVEKIT_HOST in .env)");
  process.exit(1);
}

try {
  await main({
    livekitHost: args["livekit-host"],
    livekitPort: Number(args["livekit-port"]),
    wsUrl: args["ws-url"] || null,
    runs: Number(args.runs),
  });
} catch (err) {
  console.error("ERROR:", err.message);
  process.exit(1);
}
