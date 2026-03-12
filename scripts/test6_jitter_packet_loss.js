/**
 * TEST 6: Jitter & Packet Loss Monitor
 * ======================================
 * Reads WebRTC stats every second from an active LiveKit call.
 * Tracks: jitter, packets lost, packet loss %, RTT, bytes received rate.
 *
 * HOW TO USE:
 *   1. Start a LiveKit call in your browser (user must be in a room with audio)
 *   2. Open DevTools → Console
 *   3. Paste this script and press Enter
 *   4. Let it run for the duration of your test (30s, 60s, etc.)
 *   5. Call stopJitterMonitor() to stop and see the full summary
 *   6. Call exportJitterResults() to download a JSON report
 *
 * WHAT TO LOOK FOR:
 *   - Jitter > 30ms         → noticeable audio degradation
 *   - Packet loss > 1%      → audible glitches / gaps
 *   - RTT > 150ms           → noticeable conversation delay
 *   - RTT > 300ms           → significantly uncomfortable delay
 */

(function () {
  "use strict";

  const POLL_INTERVAL_MS = 1000;  // Sample every 1 second
  const MAX_SAMPLES = 3600;       // Keep up to 1 hour of samples

  // ── State ──────────────────────────────────────────────────────────────────
  let intervalId = null;
  let samples = [];
  let prevStats = new Map();  // trackId → previous stats snapshot (for delta calc)
  let startTime = null;

  // ── Find all active RTCPeerConnections ────────────────────────────────────
  // LiveKit stores its PC on room internals – we scan common locations
  function findPeerConnections() {
    const pcs = new Set();

    // Method 1: LiveKit SDK exposes room engine
    const lkKeys = Object.keys(window).filter(k =>
      k.startsWith("__lk") || k.includes("livekit") || k.includes("LiveKit")
    );
    for (const key of lkKeys) {
      try {
        const obj = window[key];
        if (obj?.engine?.publisher?.pc) pcs.add(obj.engine.publisher.pc);
        if (obj?.engine?.subscriber?.pc) pcs.add(obj.engine.subscriber.pc);
        if (obj?.publisher?.pc) pcs.add(obj.publisher.pc);
        if (obj?.subscriber?.pc) pcs.add(obj.subscriber.pc);
      } catch (_) {}
    }

    // Method 2: If you stored the room on window (common in demos)
    if (window.room?.engine?.publisher?.pc) pcs.add(window.room.engine.publisher.pc);
    if (window.room?.engine?.subscriber?.pc) pcs.add(window.room.engine.subscriber.pc);

    // Method 3: Patched instances from our test2 signaling script
    if (window.__livekitPCs) window.__livekitPCs.forEach(pc => pcs.add(pc));

    return [...pcs].filter(pc =>
      pc && pc.connectionState !== "closed" && pc.connectionState !== "failed"
    );
  }

  // ── Parse inbound-rtp stats ───────────────────────────────────────────────
  function parseInboundRTP(stats, prevMap) {
    const results = [];
    const now = performance.now();

    stats.forEach(stat => {
      if (stat.type !== "inbound-rtp" || stat.mediaType !== "audio") return;

      const key = stat.id;
      const prev = prevMap.get(key);
      prevMap.set(key, { ...stat, capturedAt: now });

      if (!prev) return;  // Need two samples to compute deltas

      const timeDeltaS = (now - prev.capturedAt) / 1000;
      const packetsDelta = (stat.packetsReceived || 0) - (prev.packetsReceived || 0);
      const lostDelta = (stat.packetsLost || 0) - (prev.packetsLost || 0);
      const bytesDelta = (stat.bytesReceived || 0) - (prev.bytesReceived || 0);

      const totalPackets = packetsDelta + Math.max(0, lostDelta);
      const lossPercent = totalPackets > 0
        ? ((lostDelta / totalPackets) * 100).toFixed(2)
        : "0.00";

      const bitrateKbps = timeDeltaS > 0
        ? ((bytesDelta * 8) / timeDeltaS / 1000).toFixed(1)
        : "0";

      results.push({
        trackId:          stat.id,
        timestamp:        new Date().toISOString(),
        elapsed_s:        ((now - startTime) / 1000).toFixed(1),
        // Jitter
        jitter_ms:        ((stat.jitter || 0) * 1000).toFixed(2),
        jitterBuffer_ms:  stat.jitterBufferDelay
          ? ((stat.jitterBufferDelay / (stat.jitterBufferEmittedCount || 1)) * 1000).toFixed(2)
          : "N/A",
        // Packet loss
        packetsLost_total: stat.packetsLost || 0,
        packetsLost_delta:  Math.max(0, lostDelta),
        packetLoss_pct:    lossPercent,
        // Throughput
        bitrate_kbps:     bitrateKbps,
        // Quality indicators
        concealedSamples: stat.concealedSamples || 0,
        silentConcealedSamples: stat.silentConcealedSamples || 0,
      });
    });

    return results;
  }

  // ── Parse remote-inbound-rtp for RTT ─────────────────────────────────────
  function parseRemoteInboundRTP(stats) {
    const results = [];
    stats.forEach(stat => {
      if (stat.type !== "remote-inbound-rtp" || stat.kind !== "audio") return;
      results.push({
        trackId:   stat.id,
        rtt_ms:    ((stat.roundTripTime || 0) * 1000).toFixed(2),
        fractionLost: ((stat.fractionLost || 0) * 100).toFixed(2),
      });
    });
    return results;
  }

  // ── Poll loop ─────────────────────────────────────────────────────────────
  async function poll() {
    const pcs = findPeerConnections();

    if (pcs.length === 0) {
      console.warn("[JitterMonitor] ⚠️  No active RTCPeerConnections found.");
      console.warn("  Make sure you are in an active LiveKit room.");
      console.warn("  If your room object is not on window.room, see README for manual setup.");
      return;
    }

    const tick = { timestamp: new Date().toISOString(), connections: [] };

    for (const pc of pcs) {
      try {
        const stats = await pc.getStats();
        const inbound  = parseInboundRTP(stats, prevStats);
        const remoteIn = parseRemoteInboundRTP(stats);

        if (inbound.length > 0) {
          tick.connections.push({ inbound, remote_inbound: remoteIn });

          // Live console output
          for (const s of inbound) {
            const rtt = remoteIn[0]?.rtt_ms ?? "—";
            console.log(
              `[${s.elapsed_s}s] jitter=${s.jitter_ms}ms | ` +
              `loss=${s.packetLoss_pct}% (${s.packetsLost_delta} pkts) | ` +
              `RTT=${rtt}ms | ${s.bitrate_kbps} kbps`
            );
          }
        }
      } catch (e) {
        console.error("[JitterMonitor] Stats error:", e);
      }
    }

    if (tick.connections.length > 0) {
      samples.push(tick);
      if (samples.length > MAX_SAMPLES) samples.shift();
    }
  }

  // ── Summary computation ───────────────────────────────────────────────────
  function computeSummary() {
    const jitterValues   = [];
    const lossValues     = [];
    const rttValues      = [];
    const bitrateValues  = [];

    for (const tick of samples) {
      for (const conn of tick.connections) {
        for (const s of conn.inbound) {
          const j = parseFloat(s.jitter_ms);
          const l = parseFloat(s.packetLoss_pct);
          const b = parseFloat(s.bitrate_kbps);
          if (!isNaN(j)) jitterValues.push(j);
          if (!isNaN(l)) lossValues.push(l);
          if (!isNaN(b)) bitrateValues.push(b);
        }
        for (const r of conn.remote_inbound) {
          const rtt = parseFloat(r.rtt_ms);
          if (!isNaN(rtt) && rtt > 0) rttValues.push(rtt);
        }
      }
    }

    const stats = (arr) => {
      if (!arr.length) return {};
      const s = [...arr].sort((a, b) => a - b);
      const n = s.length;
      return {
        min:  +s[0].toFixed(2),
        avg:  +(s.reduce((a, b) => a + b, 0) / n).toFixed(2),
        p50:  +s[Math.floor(n * 0.50)].toFixed(2),
        p95:  +s[Math.floor(n * 0.95)].toFixed(2),
        max:  +s[n - 1].toFixed(2),
      };
    };

    return {
      duration_s:        +((performance.now() - startTime) / 1000).toFixed(1),
      total_samples:     samples.length,
      jitter_ms:         stats(jitterValues),
      packet_loss_pct:   stats(lossValues),
      rtt_ms:            stats(rttValues),
      bitrate_kbps:      stats(bitrateValues),
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.stopJitterMonitor = function () {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
    const summary = computeSummary();
    console.group("📊 Jitter & Packet Loss Summary");
    console.table({
      "Jitter (ms)":        summary.jitter_ms,
      "Packet Loss (%)":    summary.packet_loss_pct,
      "RTT (ms)":           summary.rtt_ms,
      "Bitrate (kbps)":     summary.bitrate_kbps,
    });
    console.log(`  Duration: ${summary.duration_s}s | Samples: ${summary.total_samples}`);
    console.groupEnd();
    return summary;
  };

  window.exportJitterResults = function () {
    const summary = computeSummary();
    const output = { summary, raw_samples: samples };
    const blob = new Blob([JSON.stringify(output, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `jitter_packetloss_${Date.now()}.json`;
    a.click();
    console.log("✅ Exported jitter & packet loss results");
  };

  // Manual PC registration (if auto-detection fails)
  window.registerPC = function (pc) {
    if (!window.__livekitPCs) window.__livekitPCs = new Set();
    window.__livekitPCs.add(pc);
    console.log("[JitterMonitor] PC registered manually.");
  };

  // ── Start ──────────────────────────────────────────────────────────────────
  startTime = performance.now();
  intervalId = setInterval(poll, POLL_INTERVAL_MS);

  console.log("✅ [JitterMonitor] Started. Polling every 1s.");
  console.log("   If no stats appear, call: registerPC(yourPeerConnection)");
  console.log("   Call stopJitterMonitor()  → stop + print summary");
  console.log("   Call exportJitterResults() → download JSON");
})();
