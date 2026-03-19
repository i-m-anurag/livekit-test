/**
 * BROWSER TEST: Jitter & Packet Loss Monitor
 * ============================================
 * Measures:
 *   - Jitter (variation in packet arrival times)
 *   - Packet loss % (audio packets dropped in transit)
 *   - RTT (round-trip time from WebRTC stats)
 *   - Bitrate
 *
 * HOW TO USE:
 *   1. Join a LiveKit room in your browser (have an active call)
 *   2. Open DevTools -> Console (F12)
 *   3. Paste this script
 *   4. Let it run for 30s-5min
 *   5. When done:
 *      stopMonitor()      // stop + print summary
 *      exportMonitor()    // download JSON
 *
 * THRESHOLDS:
 *   Jitter > 30ms       = noticeable audio degradation
 *   Packet loss > 1%    = audible glitches
 *   RTT > 150ms         = noticeable delay
 */

(function () {
  "use strict";

  const POLL_MS = 1000;
  const MAX_SAMPLES = 3600;

  let intervalId = null;
  let samples = [];
  let prevStats = new Map();
  let startTime = performance.now();

  function findPeerConnections() {
    const pcs = new Set();
    // LiveKit SDK internals
    const keys = Object.keys(window).filter(
      (k) => k.startsWith("__lk") || k.includes("livekit") || k.includes("LiveKit")
    );
    for (const key of keys) {
      try {
        const obj = window[key];
        if (obj?.engine?.publisher?.pc) pcs.add(obj.engine.publisher.pc);
        if (obj?.engine?.subscriber?.pc) pcs.add(obj.engine.subscriber.pc);
      } catch (_) {}
    }
    // Common pattern: window.room
    if (window.room?.engine?.publisher?.pc) pcs.add(window.room.engine.publisher.pc);
    if (window.room?.engine?.subscriber?.pc) pcs.add(window.room.engine.subscriber.pc);
    // Manual registration
    if (window.__livekitPCs) window.__livekitPCs.forEach((pc) => pcs.add(pc));

    return [...pcs].filter(
      (pc) => pc && pc.connectionState !== "closed" && pc.connectionState !== "failed"
    );
  }

  async function poll() {
    const pcs = findPeerConnections();
    if (!pcs.length) {
      console.warn("[Monitor] No active RTCPeerConnections. Call registerPC(pc) if needed.");
      return;
    }

    const tick = { ts: new Date().toISOString(), data: [] };

    for (const pc of pcs) {
      try {
        const stats = await pc.getStats();
        const now = performance.now();

        stats.forEach((stat) => {
          if (stat.type !== "inbound-rtp" || stat.mediaType !== "audio") return;

          const key = stat.id;
          const prev = prevStats.get(key);
          prevStats.set(key, { ...stat, _at: now });
          if (!prev) return;

          const dt = (now - prev._at) / 1000;
          const pktDelta = (stat.packetsReceived || 0) - (prev.packetsReceived || 0);
          const lostDelta = (stat.packetsLost || 0) - (prev.packetsLost || 0);
          const bytesDelta = (stat.bytesReceived || 0) - (prev.bytesReceived || 0);
          const totalPkts = pktDelta + Math.max(0, lostDelta);
          const lossPct = totalPkts > 0 ? +((lostDelta / totalPkts) * 100).toFixed(2) : 0;
          const kbps = dt > 0 ? +((bytesDelta * 8) / dt / 1000).toFixed(1) : 0;
          const jitterMs = +((stat.jitter || 0) * 1000).toFixed(2);

          const entry = {
            elapsed: +((now - startTime) / 1000).toFixed(1),
            jitterMs,
            lossPct,
            lostPkts: Math.max(0, lostDelta),
            kbps,
          };

          tick.data.push(entry);

          // Find RTT from remote-inbound-rtp
          let rttMs = "N/A";
          stats.forEach((s) => {
            if (s.type === "remote-inbound-rtp" && s.kind === "audio" && s.roundTripTime) {
              rttMs = +(s.roundTripTime * 1000).toFixed(2);
            }
          });

          console.log(
            `[${entry.elapsed}s] jitter=${jitterMs}ms | loss=${lossPct}% (${entry.lostPkts}pkts) | RTT=${rttMs}ms | ${kbps}kbps`
          );
        });
      } catch (e) {
        console.error("[Monitor] Stats error:", e);
      }
    }

    if (tick.data.length) {
      samples.push(tick);
      if (samples.length > MAX_SAMPLES) samples.shift();
    }
  }

  function computeSummary() {
    const jitter = [],
      loss = [],
      bitrate = [];
    for (const tick of samples) {
      for (const d of tick.data) {
        if (!isNaN(d.jitterMs)) jitter.push(d.jitterMs);
        if (!isNaN(d.lossPct)) loss.push(d.lossPct);
        if (!isNaN(d.kbps)) bitrate.push(d.kbps);
      }
    }

    const s = (arr) => {
      if (!arr.length) return {};
      const sorted = [...arr].sort((a, b) => a - b);
      const n = sorted.length;
      return {
        min: +sorted[0].toFixed(2),
        avg: +(sorted.reduce((a, b) => a + b, 0) / n).toFixed(2),
        p50: +sorted[Math.floor(n * 0.5)].toFixed(2),
        p95: +sorted[Math.floor(n * 0.95)].toFixed(2),
        max: +sorted[n - 1].toFixed(2),
      };
    };

    return {
      durationSec: +((performance.now() - startTime) / 1000).toFixed(1),
      totalSamples: samples.length,
      jitterMs: s(jitter),
      packetLossPct: s(loss),
      bitrateKbps: s(bitrate),
    };
  }

  // Public API
  window.stopMonitor = function () {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
    const summary = computeSummary();
    console.group("Jitter & Packet Loss Summary");
    console.table({
      "Jitter (ms)": summary.jitterMs,
      "Packet Loss (%)": summary.packetLossPct,
      "Bitrate (kbps)": summary.bitrateKbps,
    });
    console.log(`Duration: ${summary.durationSec}s | Samples: ${summary.totalSamples}`);
    console.groupEnd();
    return summary;
  };

  window.exportMonitor = function () {
    const summary = computeSummary();
    const blob = new Blob([JSON.stringify({ summary, samples }, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `jitter_packetloss_${Date.now()}.json`;
    a.click();
    console.log("Exported jitter & packet loss results");
  };

  window.registerPC = function (pc) {
    if (!window.__livekitPCs) window.__livekitPCs = new Set();
    window.__livekitPCs.add(pc);
    console.log("[Monitor] PC registered.");
  };

  intervalId = setInterval(poll, POLL_MS);
  console.log("[Monitor] Started. Polling every 1s.");
  console.log("  stopMonitor()   -> stop + summary");
  console.log("  exportMonitor() -> download JSON");
  console.log("  registerPC(pc)  -> manual PC registration");
})();
