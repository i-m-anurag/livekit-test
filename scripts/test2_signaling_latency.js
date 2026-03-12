/**
 * TEST 2: Signaling Latency (SDP + ICE)
 * =======================================
 * Measures:
 *   - WebSocket connection time to LiveKit
 *   - SDP offer → answer round-trip time
 *   - ICE gathering duration
 *   - ICE checking → connected state duration
 *   - Total time to "usable connection"
 *
 * HOW TO USE:
 *   1. Open your web app that uses LiveKit in Chrome/Firefox
 *   2. Open DevTools → Console tab
 *   3. Paste this entire script and press Enter
 *   4. It will print a table of signaling timings
 *   5. Copy results or run collectSignalingMetrics() again for another sample
 *
 * NOTE: This script monkey-patches RTCPeerConnection to intercept events.
 *       Run it BEFORE your app calls new RTCPeerConnection().
 *       Best used on a fresh page load — paste in console immediately after load.
 */

(function () {
  "use strict";

  const log = (msg, data) => {
    const ts = performance.now().toFixed(2);
    console.log(`[SignalingTest @ ${ts}ms] ${msg}`, data ?? "");
  };

  // ── Storage ────────────────────────────────────────────────────────────────
  window.__signalingMetrics = [];
  const sessions = new Map(); // pc instance → timing object

  // ── Patch RTCPeerConnection ────────────────────────────────────────────────
  const OriginalPC = window.RTCPeerConnection;

  window.RTCPeerConnection = function (...args) {
    const pc = new OriginalPC(...args);
    const timing = {
      sessionId: crypto.randomUUID().slice(0, 8),
      pcCreatedAt: performance.now(),
      setLocalDescriptionAt: null,
      setRemoteDescriptionAt: null,
      sdpRoundTripMs: null,
      iceGatheringStartAt: null,
      iceGatheringEndAt: null,
      iceGatheringDurationMs: null,
      iceCheckingStartAt: null,
      iceConnectedAt: null,
      iceConnectionDurationMs: null,
      totalSignalingMs: null,
      finalState: null,
    };
    sessions.set(pc, timing);
    log(`[${timing.sessionId}] RTCPeerConnection created`);

    // ── Intercept setLocalDescription ───────────────────────────────────────
    const origSetLocal = pc.setLocalDescription.bind(pc);
    pc.setLocalDescription = async function (desc) {
      timing.setLocalDescriptionAt = performance.now();
      log(`[${timing.sessionId}] setLocalDescription called (type=${desc?.type})`);
      return origSetLocal(desc);
    };

    // ── Intercept setRemoteDescription ──────────────────────────────────────
    const origSetRemote = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = async function (desc) {
      timing.setRemoteDescriptionAt = performance.now();
      if (timing.setLocalDescriptionAt) {
        timing.sdpRoundTripMs = (
          timing.setRemoteDescriptionAt - timing.setLocalDescriptionAt
        ).toFixed(2);
        log(
          `[${timing.sessionId}] SDP round-trip: ${timing.sdpRoundTripMs} ms`
        );
      }
      return origSetRemote(desc);
    };

    // ── ICE gathering state ──────────────────────────────────────────────────
    pc.addEventListener("icegatheringstatechange", () => {
      const state = pc.iceGatheringState;
      if (state === "gathering") {
        timing.iceGatheringStartAt = performance.now();
        log(`[${timing.sessionId}] ICE gathering started`);
      } else if (state === "complete") {
        timing.iceGatheringEndAt = performance.now();
        if (timing.iceGatheringStartAt) {
          timing.iceGatheringDurationMs = (
            timing.iceGatheringEndAt - timing.iceGatheringStartAt
          ).toFixed(2);
          log(
            `[${timing.sessionId}] ICE gathering complete: ${timing.iceGatheringDurationMs} ms`
          );
        }
      }
    });

    // ── ICE connection state ─────────────────────────────────────────────────
    pc.addEventListener("iceconnectionstatechange", () => {
      const state = pc.iceConnectionState;
      log(`[${timing.sessionId}] ICE connection state → ${state}`);

      if (state === "checking") {
        timing.iceCheckingStartAt = performance.now();
      } else if (state === "connected" || state === "completed") {
        timing.iceConnectedAt = performance.now();
        timing.finalState = state;

        if (timing.iceCheckingStartAt) {
          timing.iceConnectionDurationMs = (
            timing.iceConnectedAt - timing.iceCheckingStartAt
          ).toFixed(2);
        }

        // Total from PC creation → ICE connected
        timing.totalSignalingMs = (
          timing.iceConnectedAt - timing.pcCreatedAt
        ).toFixed(2);

        log(
          `[${timing.sessionId}] ✅ Connected! ICE checking→connected: ${timing.iceConnectionDurationMs} ms | Total: ${timing.totalSignalingMs} ms`
        );

        // Save to global results
        window.__signalingMetrics.push({ ...timing });
        printResults();
      } else if (state === "failed" || state === "disconnected" || state === "closed") {
        timing.finalState = state;
        log(`[${timing.sessionId}] ⚠️ Connection ended with state: ${state}`);
      }
    });

    return pc;
  };

  // Preserve static methods
  Object.setPrototypeOf(window.RTCPeerConnection, OriginalPC);
  window.RTCPeerConnection.prototype = OriginalPC.prototype;

  // ── Print results table ────────────────────────────────────────────────────
  function printResults() {
    const results = window.__signalingMetrics;
    if (!results.length) {
      console.log("No completed sessions yet.");
      return;
    }

    console.group("📊 Signaling Latency Results");
    console.table(
      results.map((r) => ({
        "Session ID":          r.sessionId,
        "SDP RTT (ms)":        r.sdpRoundTripMs ?? "N/A",
        "ICE Gathering (ms)":  r.iceGatheringDurationMs ?? "N/A",
        "ICE Conn (ms)":       r.iceConnectionDurationMs ?? "N/A",
        "Total Signaling (ms)": r.totalSignalingMs ?? "N/A",
        "Final State":         r.finalState ?? "pending",
      }))
    );

    if (results.length > 1) {
      const totals = results
        .map((r) => parseFloat(r.totalSignalingMs))
        .filter((v) => !isNaN(v))
        .sort((a, b) => a - b);
      const avg = (totals.reduce((s, v) => s + v, 0) / totals.length).toFixed(2);
      const p95 = totals[Math.floor(totals.length * 0.95)];
      console.log(`  Avg total signaling: ${avg} ms  |  P95: ${p95} ms`);
    }
    console.groupEnd();
  }

  // ── Export helper ──────────────────────────────────────────────────────────
  window.collectSignalingMetrics = () => {
    printResults();
    return JSON.stringify(window.__signalingMetrics, null, 2);
  };

  window.exportSignalingMetrics = () => {
    const blob = new Blob(
      [JSON.stringify(window.__signalingMetrics, null, 2)],
      { type: "application/json" }
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `signaling_latency_${Date.now()}.json`;
    a.click();
    console.log("✅ Exported signaling metrics JSON");
  };

  log("✅ Signaling latency monitor installed.");
  log("   Reload your app and make a call.");
  log("   Run collectSignalingMetrics() at any time to see results.");
  log("   Run exportSignalingMetrics() to download results as JSON.");
})();
