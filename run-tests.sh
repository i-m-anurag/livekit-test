#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# LiveKit Latency Test Suite — Node.js Runner
# ═══════════════════════════════════════════════════════════════════
#
# Usage:
#   ./run-tests.sh e2e              # E2E latency + agent dispatch
#   ./run-tests.sh ttfb             # Time to first audio byte
#   ./run-tests.sh network          # TCP RTT, WebSocket, DNS, Traceroute
#   ./run-tests.sh all              # Run all Node.js tests + analyze
#   ./run-tests.sh analyze          # Analyze existing results
#
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

case "${1:-help}" in
  e2e)
    echo "Running E2E Latency + Agent Dispatch test..."
    node scripts/test_e2e_latency.js "${@:2}"
    ;;
  ttfb)
    echo "Running TTFB test..."
    node scripts/test_ttfb.js "${@:2}"
    ;;
  network)
    echo "Running Network RTT test..."
    node scripts/test_network_rtt.js "${@:2}"
    ;;
  analyze)
    node scripts/analyze_results.js "${@:2}"
    ;;
  all)
    echo "Running all tests..."
    echo ""
    node scripts/test_e2e_latency.js "${@:2}"
    echo ""
    node scripts/test_ttfb.js "${@:2}"
    echo ""
    node scripts/test_network_rtt.js "${@:2}"
    echo ""
    node scripts/analyze_results.js "${@:2}"
    ;;
  help|*)
    cat <<'USAGE'
LiveKit Latency Test Suite
==========================

NODE.JS TESTS (run from terminal):
  ./run-tests.sh e2e [flags]       E2E round-trip latency + agent dispatch time
  ./run-tests.sh ttfb [flags]      TTFB (user stops talking -> agent first audio)
  ./run-tests.sh network [flags]   TCP RTT, WebSocket, DNS, Traceroute
  ./run-tests.sh all [flags]       Run all tests + analyze
  ./run-tests.sh analyze           Analyze existing results

BROWSER TESTS (paste in DevTools console):
  scripts/browser/webrtc_signaling.js    SDP RTT, ICE time, transport type, TURN detection
  scripts/browser/jitter_packet_loss.js  Jitter, packet loss %, RTT

COMMON FLAGS:
  --url wss://server          LiveKit server URL
  --runs 20                   Number of test runs
  --delay 3                   Delay between runs (seconds)
  --agent-name my-agent       Agent to dispatch

EXAMPLES:
  ./run-tests.sh e2e --runs 20 --delay 3
  ./run-tests.sh ttfb --runs 15
  ./run-tests.sh network --livekit-host my-server.com --runs 30
  ./run-tests.sh all
USAGE
    ;;
esac
