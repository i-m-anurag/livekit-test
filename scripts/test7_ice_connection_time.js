/**
 * TEST 7: ICE Connection Time & TCP Handshake
 * =============================================
 * Measures every phase of WebRTC ICE negotiation with millisecond precision.
 *
 * Tracks:
 *   - ICE candidate types (host / srflx / relay)
 *   - Time from ICE start → first candidate
 *   - Time from ICE start → gathering complete
 *   - Time from ICE checking → connected
 *   - Whether TCP or UDP transport was selected
 *   - TURN relay vs direct connection detection
 *
 * HOW TO USE:
 *   Option A (BEFORE call starts – most accurate):
 *     1. Open DevTools on a fresh page load
 *     2. Paste this script IMMEDIATELY before your app creates the RTCPeerConnection
 *     3. Make a call – all ICE events will be captured
 *
 *   Option B (AFTER call is connected – reads final state):
 *     1. Paste in console after call is established
 *     2. Call analyzeActiveConnections() to inspect the current ICE state
 *
 *   Call exportICEResults() to download a full JSON report.
 */

(function () {
  "use strict";

  window.__iceResults = [];

  // ── Helper ─────────────────────────────────────────────────────────────────
  const ts = () => performance.now();
  const fmt = (v) => (v !== null && v !== undefined) ? `${(+v).toFixed(2)}ms` : "—";

  // ── Patch RTCPeerConnection ────────────────────────────────────────────────
  const OrigPC = window.RTCPeerConnection;

  window.RTCPeerConnection = function (...args) {
    const pc = new OrigPC(...args);
    const session = {
      id:                    crypto.randomUUID().slice(0, 8),
      createdAt:             ts(),
      // Candidate gathering
      gatheringStartAt:      null,
      firstCandidateAt:      null,
      gatheringCompleteAt:   null,
      firstCandidateMs:      null,
      gatheringTotalMs:      null,
      candidateTypes:        [],           // host / srflx / relay
      candidateProtocols:    [],           // udp / tcp
      // ICE connection
      checkingStartAt:       null,
      connectedAt:           null,
      iceConnectionMs:       null,
      // Selected pair
      selectedCandidateType: null,
      selectedProtocol:      null,
      usingTURN:             null,
      usingTCP:              null,
      // Final outcome
      finalICEState:         null,
      finalConnectionState:  null,
      totalTimeMs:           null,         // created → connected
      // SDP timing
      offerCreatedAt:        null,
      answerReceivedAt:      null,
      sdpRoundTripMs:        null,
    };

    window.__iceResults.push(session);

    // ── ICE gathering state ────────────────────────────────────────────────
    pc.addEventListener("icegatheringstatechange", () => {
      const state = pc.iceGatheringState;
      if (state === "gathering") {
        session.gatheringStartAt = ts();
      } else if (state === "complete") {
        session.gatheringCompleteAt = ts();
        if (session.gatheringStartAt) {
          session.gatheringTotalMs = (
            session.gatheringCompleteAt - session.gatheringStartAt
          ).toFixed(2);
        }
        console.log(`[ICETest:${session.id}] Gathering complete in ${fmt(session.gatheringTotalMs)}`);
      }
    });

    // ── ICE candidates ─────────────────────────────────────────────────────
    pc.addEventListener("icecandidate", (e) => {
      if (!e.candidate) return;  // null = gathering done signal

      const cand = e.candidate;
      const type = cand.type;          // host | srflx | relay
      const proto = cand.protocol;     // udp | tcp

      if (!session.firstCandidateAt) {
        session.firstCandidateAt = ts();
        if (session.gatheringStartAt) {
          session.firstCandidateMs = (
            session.firstCandidateAt - session.gatheringStartAt
          ).toFixed(2);
        }
        console.log(
          `[ICETest:${session.id}] First candidate (${type}/${proto}) ` +
          `in ${fmt(session.firstCandidateMs)}`
        );
      }

      if (type && !session.candidateTypes.includes(type)) {
        session.candidateTypes.push(type);
      }
      if (proto && !session.candidateProtocols.includes(proto)) {
        session.candidateProtocols.push(proto);
      }
    });

    // ── ICE connection state ───────────────────────────────────────────────
    pc.addEventListener("iceconnectionstatechange", () => {
      const state = pc.iceConnectionState;
      session.finalICEState = state;
      console.log(`[ICETest:${session.id}] ICE state → ${state}`);

      if (state === "checking") {
        session.checkingStartAt = ts();
      } else if (state === "connected" || state === "completed") {
        session.connectedAt = ts();
        if (session.checkingStartAt) {
          session.iceConnectionMs = (
            session.connectedAt - session.checkingStartAt
          ).toFixed(2);
        }
        session.totalTimeMs = (session.connectedAt - session.createdAt).toFixed(2);

        // Inspect selected candidate pair for TCP/TURN info
        setTimeout(() => inspectSelectedPair(pc, session), 100);

        console.log(
          `[ICETest:${session.id}] ✅ ICE connected! ` +
          `checking→connected: ${fmt(session.iceConnectionMs)} | ` +
          `total: ${fmt(session.totalTimeMs)}`
        );
      } else if (state === "failed") {
        console.error(`[ICETest:${session.id}] ❌ ICE FAILED`);
      }
    });

    // ── Connection state ───────────────────────────────────────────────────
    pc.addEventListener("connectionstatechange", () => {
      session.finalConnectionState = pc.connectionState;
    });

    // ── SDP intercept ──────────────────────────────────────────────────────
    const origCreateOffer = pc.createOffer.bind(pc);
    pc.createOffer = async function (...a) {
      const desc = await origCreateOffer(...a);
      session.offerCreatedAt = ts();
      return desc;
    };

    const origSetRemote = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = async function (desc) {
      if (desc.type === "answer" && session.offerCreatedAt) {
        session.answerReceivedAt = ts();
        session.sdpRoundTripMs = (
          session.answerReceivedAt - session.offerCreatedAt
        ).toFixed(2);
        console.log(`[ICETest:${session.id}] SDP offer→answer RTT: ${fmt(session.sdpRoundTripMs)}`);
      }
      return origSetRemote(desc);
    };

    return pc;
  };

  Object.setPrototypeOf(window.RTCPeerConnection, OrigPC);
  window.RTCPeerConnection.prototype = OrigPC.prototype;

  // ── Inspect selected candidate pair ───────────────────────────────────────
  async function inspectSelectedPair(pc, session) {
    try {
      const stats = await pc.getStats();
      stats.forEach(stat => {
        if (stat.type === "candidate-pair" && stat.state === "succeeded" && stat.nominated) {
          const localId = stat.localCandidateId;
          const remoteId = stat.remoteCandidateId;
          stats.forEach(s => {
            if (s.id === localId) {
              session.selectedProtocol      = s.protocol;
              session.selectedCandidateType = s.candidateType;
              session.usingTCP  = s.protocol === "tcp";
              session.usingTURN = s.candidateType === "relay";
              console.log(
                `[ICETest:${session.id}] Selected pair: ` +
                `type=${s.candidateType} protocol=${s.protocol} ` +
                `(TURN=${session.usingTURN}, TCP=${session.usingTCP})`
              );
            }
          });
        }
      });
    } catch (_) {}
  }

  // ── Analyze currently active connections ──────────────────────────────────
  window.analyzeActiveConnections = async function () {
    const results = window.__iceResults;
    if (!results.length) {
      console.log("No connections captured. Make sure you pasted before the call started.");
      return;
    }
    printICESummary();
  };

  // ── Print summary ──────────────────────────────────────────────────────────
  function printICESummary() {
    const results = window.__iceResults;
    console.group("📊 ICE Connection Timing Results");
    console.table(results.map(r => ({
      "Session":           r.id,
      "SDP RTT (ms)":      r.sdpRoundTripMs   ?? "—",
      "1st Candidate (ms)":r.firstCandidateMs ?? "—",
      "Gathering (ms)":    r.gatheringTotalMs  ?? "—",
      "ICE Check→Conn (ms)":r.iceConnectionMs  ?? "—",
      "Total (ms)":        r.totalTimeMs       ?? "—",
      "Protocol":          r.selectedProtocol  ?? "—",
      "Type":              r.selectedCandidateType ?? "—",
      "TURN?":             r.usingTURN !== null ? String(r.usingTURN) : "—",
      "TCP?":              r.usingTCP  !== null ? String(r.usingTCP)  : "—",
      "Final ICE":         r.finalICEState ?? "—",
    })));
    console.groupEnd();
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  window.exportICEResults = function () {
    const blob = new Blob(
      [JSON.stringify(window.__iceResults, null, 2)],
      { type: "application/json" }
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ice_timing_${Date.now()}.json`;
    a.click();
    console.log("✅ ICE results exported.");
  };

  console.log("✅ [ICETest] Monitor installed.");
  console.log("   Make a LiveKit call — ICE timing will be captured automatically.");
  console.log("   Call analyzeActiveConnections() to view results at any time.");
  console.log("   Call exportICEResults() to download a JSON report.");
})();
