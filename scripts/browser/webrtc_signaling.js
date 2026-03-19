/**
 * BROWSER TEST: WebRTC Signaling, ICE Connection, Transport & TURN Detection
 * ============================================================================
 * Measures:
 *   - SDP signaling RTT (offer -> answer)
 *   - ICE gathering duration
 *   - ICE connection time (checking -> connected)
 *   - ICE transport type (UDP vs TCP)
 *   - TURN relay detection
 *   - ICE candidate types (host / srflx / relay)
 *
 * HOW TO USE:
 *   1. Open your LiveKit web app in Chrome
 *   2. Open DevTools -> Console (F12)
 *   3. Paste this ENTIRE script BEFORE joining a room
 *   4. Join the room / make a call
 *   5. When connected, run:
 *      getSignalingResults()    // print summary table
 *      exportSignalingResults() // download JSON
 */

(function () {
  "use strict";

  window.__signalingResults = [];
  const sessions = new Map();

  const log = (msg) => {
    console.log(`[WebRTC-Test @ ${performance.now().toFixed(0)}ms] ${msg}`);
  };

  const OrigPC = window.RTCPeerConnection;

  window.RTCPeerConnection = function (...args) {
    const pc = new OrigPC(...args);
    const s = {
      id: crypto.randomUUID().slice(0, 8),
      createdAt: performance.now(),
      // SDP timing
      setLocalAt: null,
      setRemoteAt: null,
      sdpRoundTripMs: null,
      // ICE gathering
      gatheringStartAt: null,
      firstCandidateAt: null,
      gatheringCompleteAt: null,
      firstCandidateMs: null,
      gatheringDurationMs: null,
      candidateTypes: [],
      candidateProtocols: [],
      // ICE connection
      checkingStartAt: null,
      connectedAt: null,
      iceConnectionMs: null,
      totalTimeMs: null,
      // Transport info
      selectedProtocol: null,
      selectedCandidateType: null,
      usingTCP: null,
      usingTURN: null,
      // State
      finalICEState: null,
    };
    sessions.set(pc, s);
    log(`[${s.id}] RTCPeerConnection created`);

    // SDP interception
    const origSetLocal = pc.setLocalDescription.bind(pc);
    pc.setLocalDescription = async function (desc) {
      s.setLocalAt = performance.now();
      return origSetLocal(desc);
    };

    const origSetRemote = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = async function (desc) {
      s.setRemoteAt = performance.now();
      if (s.setLocalAt) {
        s.sdpRoundTripMs = +(s.setRemoteAt - s.setLocalAt).toFixed(2);
        log(`[${s.id}] SDP round-trip: ${s.sdpRoundTripMs}ms`);
      }
      return origSetRemote(desc);
    };

    // ICE gathering
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "gathering") {
        s.gatheringStartAt = performance.now();
      } else if (pc.iceGatheringState === "complete") {
        s.gatheringCompleteAt = performance.now();
        if (s.gatheringStartAt) {
          s.gatheringDurationMs = +(s.gatheringCompleteAt - s.gatheringStartAt).toFixed(2);
          log(`[${s.id}] ICE gathering complete: ${s.gatheringDurationMs}ms`);
        }
      }
    });

    // ICE candidates
    pc.addEventListener("icecandidate", (e) => {
      if (!e.candidate) return;
      const { type, protocol } = e.candidate;
      if (!s.firstCandidateAt) {
        s.firstCandidateAt = performance.now();
        if (s.gatheringStartAt) {
          s.firstCandidateMs = +(s.firstCandidateAt - s.gatheringStartAt).toFixed(2);
        }
        log(`[${s.id}] First candidate (${type}/${protocol}) in ${s.firstCandidateMs}ms`);
      }
      if (type && !s.candidateTypes.includes(type)) s.candidateTypes.push(type);
      if (protocol && !s.candidateProtocols.includes(protocol)) s.candidateProtocols.push(protocol);
    });

    // ICE connection state
    pc.addEventListener("iceconnectionstatechange", () => {
      const state = pc.iceConnectionState;
      s.finalICEState = state;

      if (state === "checking") {
        s.checkingStartAt = performance.now();
      } else if (state === "connected" || state === "completed") {
        s.connectedAt = performance.now();
        if (s.checkingStartAt) {
          s.iceConnectionMs = +(s.connectedAt - s.checkingStartAt).toFixed(2);
        }
        s.totalTimeMs = +(s.connectedAt - s.createdAt).toFixed(2);

        // Inspect selected pair
        setTimeout(() => inspectPair(pc, s), 100);

        log(`[${s.id}] ICE connected! ${s.iceConnectionMs}ms | total: ${s.totalTimeMs}ms`);
        window.__signalingResults.push({ ...s });
      }
    });

    return pc;
  };

  Object.setPrototypeOf(window.RTCPeerConnection, OrigPC);
  window.RTCPeerConnection.prototype = OrigPC.prototype;

  async function inspectPair(pc, s) {
    try {
      const stats = await pc.getStats();
      stats.forEach((stat) => {
        if (stat.type === "candidate-pair" && stat.state === "succeeded" && stat.nominated) {
          stats.forEach((cs) => {
            if (cs.id === stat.localCandidateId) {
              s.selectedProtocol = cs.protocol;
              s.selectedCandidateType = cs.candidateType;
              s.usingTCP = cs.protocol === "tcp";
              s.usingTURN = cs.candidateType === "relay";
              log(
                `[${s.id}] Transport: ${cs.candidateType}/${cs.protocol} | TURN=${s.usingTURN} TCP=${s.usingTCP}`
              );
            }
          });
        }
      });
    } catch (_) {}
  }

  // Public API
  window.getSignalingResults = function () {
    const r = window.__signalingResults;
    if (!r.length) {
      console.log("No completed sessions. Join a room first.");
      return;
    }
    console.group("WebRTC Signaling & ICE Results");
    console.table(
      r.map((s) => ({
        Session: s.id,
        "SDP RTT (ms)": s.sdpRoundTripMs ?? "N/A",
        "ICE Gather (ms)": s.gatheringDurationMs ?? "N/A",
        "ICE Connect (ms)": s.iceConnectionMs ?? "N/A",
        "Total (ms)": s.totalTimeMs ?? "N/A",
        Protocol: s.selectedProtocol ?? "N/A",
        Type: s.selectedCandidateType ?? "N/A",
        TURN: s.usingTURN !== null ? String(s.usingTURN) : "N/A",
        TCP: s.usingTCP !== null ? String(s.usingTCP) : "N/A",
      }))
    );
    console.groupEnd();
    return r;
  };

  window.exportSignalingResults = function () {
    const blob = new Blob([JSON.stringify(window.__signalingResults, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `webrtc_signaling_${Date.now()}.json`;
    a.click();
    console.log("Exported signaling results");
  };

  log("WebRTC signaling + ICE monitor installed.");
  log("Join a room, then run: getSignalingResults()");
  log("Download JSON: exportSignalingResults()");
})();
