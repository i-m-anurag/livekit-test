#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# LiveKit Test Suite — Latency First, Then Load
# ═══════════════════════════════════════════════════════════════════
#
# LATENCY TESTS (single room — how fast is one call?)
#   ./run-tests.sh latency                 # 1 room, 2 min, speech every 5s (~24 samples)
#   ./run-tests.sh latency 5m              # 1 room, 5 min (~60 samples)
#   ./run-tests.sh latency 5m 3s           # 1 room, 5 min, speech every 3s (~100 samples)
#   ./run-tests.sh latency-repeat 5        # Run 5 separate sessions back-to-back
#
# LOAD TESTS (multiple rooms — how does it scale?)
#   ./run-tests.sh load 3                  # 3 concurrent agent rooms, 2 min
#   ./run-tests.sh load 10 5m             # 10 rooms, 5 min
#   ./run-tests.sh media 5 20 2m           # 5 audio pubs, 20 subs, 2 min
#
# FULL SUITE
#   ./run-tests.sh all                     # Latency first, then load tests
#
# Results saved to ./results/ with timestamps.
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Load .env ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env file not found."
  echo "  cp .env.example .env   # then fill in your values"
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

# ── Validate required vars ───────────────────────────────────────
for var in LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set in .env"
    exit 1
  fi
done

# ── Common flags ─────────────────────────────────────────────────
LK_COMMON=(
  --url "$LIVEKIT_URL"
  --api-key "$LIVEKIT_API_KEY"
  --api-secret "$LIVEKIT_API_SECRET"
)

AGENT_NAME="${LIVEKIT_AGENT_NAME:-}"
RESULTS_DIR="$SCRIPT_DIR/results"
mkdir -p "$RESULTS_DIR"

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

# ── Helpers ──────────────────────────────────────────────────────
separator() {
  echo ""
  echo "═══════════════════════════════════════════════════════════"
  echo "  $1"
  echo "═══════════════════════════════════════════════════════════"
  echo ""
}

save_result() {
  local test_name="$1"
  local output_file="$RESULTS_DIR/${test_name}_${TIMESTAMP}.log"
  tee "$output_file"
  echo ""
  echo "  Results saved -> $output_file"
}

require_agent() {
  if [ -z "$AGENT_NAME" ]; then
    echo "ERROR: LIVEKIT_AGENT_NAME not set in .env"
    echo "  This must match the agent_name in your agent's WorkerOptions."
    exit 1
  fi
}


# ═══════════════════════════════════════════════════════════════════
#  LATENCY TESTS — Single room, single agent, measure response time
# ═══════════════════════════════════════════════════════════════════


# ── Single Session Latency ───────────────────────────────────────
# Joins 1 room, dispatches 1 agent, sends speech at regular intervals.
# Each speech cycle produces one latency sample.
#
# With default 2m duration + 5s delay = ~24 latency samples
# With 5m + 3s = ~100 latency samples
#
# What it measures per sample:
#   - Agent join time (room connect -> agent appears)
#   - E2E response latency (speech sent -> agent audio received)
# ──────────────────────────────────────────────────────────────────
run_latency_test() {
  local duration="${1:-2m}"
  local speech_delay="${2:-5s}"

  require_agent

  separator "LATENCY TEST | 1 room | duration=$duration | speech every $speech_delay | agent=$AGENT_NAME"
  echo "  What: Single conversation — measures agent response time"
  echo "  Samples: ~$(estimate_samples "$duration" "$speech_delay") latency measurements"
  echo ""

  lk perf agent-load-test \
    "${LK_COMMON[@]}" \
    --rooms 1 \
    --agent-name "$AGENT_NAME" \
    --duration "$duration" \
    --echo-speech-delay "$speech_delay" \
    2>&1 | save_result "latency_${duration}_${speech_delay}interval"
}

# ── Repeated Latency Sessions ────────────────────────────────────
# Runs N separate single-room sessions back-to-back.
# Each session = fresh room + fresh agent join.
#
# Why: Tests consistency across separate connections, not just within one.
#   - Does latency degrade over time?
#   - Is the first call slower than subsequent ones? (cold start)
#   - Are there intermittent spikes?
# ──────────────────────────────────────────────────────────────────
run_latency_repeat() {
  local sessions="${1:-5}"
  local per_session_duration="${2:-1m}"
  local speech_delay="${3:-5s}"

  require_agent

  separator "REPEATED LATENCY TEST | $sessions sessions x $per_session_duration each | agent=$AGENT_NAME"
  echo "  What: $sessions separate room sessions, testing cold-start and consistency"
  echo ""

  for i in $(seq 1 "$sessions"); do
    echo ""
    echo "  ──────── Session $i of $sessions ────────"
    echo ""

    lk perf agent-load-test \
      "${LK_COMMON[@]}" \
      --rooms 1 \
      --agent-name "$AGENT_NAME" \
      --duration "$per_session_duration" \
      --echo-speech-delay "$speech_delay" \
      2>&1 | save_result "latency_session${i}of${sessions}"

    if [ "$i" -lt "$sessions" ]; then
      echo ""
      echo "  Cooling down 5s before next session..."
      sleep 5
    fi
  done

  separator "REPEATED LATENCY TEST COMPLETE ($sessions sessions)"
}

# ── Quick Smoke Test ─────────────────────────────────────────────
# Fastest possible check — 1 room, 30 seconds, 3 speech cycles.
# Just verifies: can the agent connect and respond?
# ──────────────────────────────────────────────────────────────────
run_quick_test() {
  require_agent

  separator "QUICK SMOKE TEST | 1 room | 30s | agent=$AGENT_NAME"
  echo "  What: Fast sanity check — does the agent connect and respond?"
  echo ""

  lk perf agent-load-test \
    "${LK_COMMON[@]}" \
    --rooms 1 \
    --agent-name "$AGENT_NAME" \
    --duration 30s \
    --echo-speech-delay 10s \
    2>&1 | save_result "quick_smoke"
}


# ═══════════════════════════════════════════════════════════════════
#  LOAD TESTS — Multiple rooms/publishers, measure under stress
# ═══════════════════════════════════════════════════════════════════


# ── Agent Concurrency Load Test ──────────────────────────────────
# Multiple concurrent rooms, each with an agent.
# Measures: does latency degrade when many rooms are active?
# ──────────────────────────────────────────────────────────────────
run_load_test() {
  local rooms="${1:-3}"
  local duration="${2:-2m}"

  require_agent

  separator "AGENT LOAD TEST | $rooms concurrent rooms | $duration | agent=$AGENT_NAME"
  echo "  What: Stress test — does latency degrade with $rooms simultaneous calls?"
  echo ""

  lk perf agent-load-test \
    "${LK_COMMON[@]}" \
    --rooms "$rooms" \
    --agent-name "$AGENT_NAME" \
    --duration "$duration" \
    --echo-speech-delay 5s \
    2>&1 | save_result "load_${rooms}rooms_${duration}"
}

# ── Media Load Test ──────────────────────────────────────────────
# Simulates audio publishers + subscribers in a single room.
# Measures: track latency, bitrate, jitter, packet loss.
# ──────────────────────────────────────────────────────────────────
run_media_test() {
  local audio_pubs="${1:-5}"
  local subscribers="${2:-20}"
  local duration="${3:-2m}"

  separator "MEDIA LOAD TEST | ${audio_pubs} audio pubs | ${subscribers} subs | ${duration}"
  echo "  What: Audio transport quality — jitter, packet loss, bitrate"
  echo ""

  lk load-test \
    "${LK_COMMON[@]}" \
    --room "latency-test-media" \
    --audio-publishers "$audio_pubs" \
    --subscribers "$subscribers" \
    --duration "$duration" \
    --simulate-speakers \
    2>&1 | save_result "media_${audio_pubs}pub_${subscribers}sub_${duration}"
}


# ═══════════════════════════════════════════════════════════════════
#  FULL SUITE — Latency first, then load
# ═══════════════════════════════════════════════════════════════════

run_all_tests() {
  separator "FULL TEST SUITE"
  echo "  Timestamp : $(date)"
  echo "  Server    : $LIVEKIT_URL"
  echo "  Agent     : ${AGENT_NAME:-'(not set)'}"
  echo ""
  echo "  Order: quick -> latency -> repeated latency -> load -> media"
  echo ""

  # Step 1: Quick smoke test
  run_quick_test
  echo ""; echo "  Waiting 10s..."; sleep 10

  # Step 2: Single session latency (2 min, ~24 samples)
  run_latency_test 2m 5s
  echo ""; echo "  Waiting 10s..."; sleep 10

  # Step 3: Repeated sessions (3 sessions, catch cold-start issues)
  run_latency_repeat 3 1m 5s
  echo ""; echo "  Waiting 10s..."; sleep 10

  # Step 4: Concurrency load (3 rooms)
  run_load_test 3 2m
  echo ""; echo "  Waiting 10s..."; sleep 10

  # Step 5: Media quality
  run_media_test 5 20 2m

  separator "ALL TESTS COMPLETE"
  echo "  Results directory: $RESULTS_DIR"
  echo ""
  ls -lh "$RESULTS_DIR"/*_${TIMESTAMP}.log 2>/dev/null || echo "  No results found."
}


# ═══════════════════════════════════════════════════════════════════
#  Utility
# ═══════════════════════════════════════════════════════════════════

# Rough estimate of how many latency samples a test will produce
estimate_samples() {
  local duration="$1"
  local delay="$2"

  # Parse duration to seconds
  local dur_s=0
  if [[ "$duration" =~ ^([0-9]+)s$ ]]; then dur_s="${BASH_REMATCH[1]}"
  elif [[ "$duration" =~ ^([0-9]+)m$ ]]; then dur_s=$((BASH_REMATCH[1] * 60))
  elif [[ "$duration" =~ ^([0-9]+)h$ ]]; then dur_s=$((BASH_REMATCH[1] * 3600))
  fi

  # Parse delay to seconds
  local del_s=0
  if [[ "$delay" =~ ^([0-9]+)s$ ]]; then del_s="${BASH_REMATCH[1]}"
  elif [[ "$delay" =~ ^([0-9]+)m$ ]]; then del_s=$((BASH_REMATCH[1] * 60))
  fi

  if [ "$del_s" -gt 0 ]; then
    echo $((dur_s / del_s))
  else
    echo "?"
  fi
}


# ═══════════════════════════════════════════════════════════════════
#  CLI Router
# ═══════════════════════════════════════════════════════════════════

print_usage() {
  cat <<'USAGE'
LiveKit Test Suite — Latency First, Then Load
===============================================

Usage:
  ./run-tests.sh <command> [args...]

LATENCY TESTS (single room — how fast is one call?):
  quick                                Fast sanity check (1 room, 30s)
  latency [duration] [speech-delay]    Single session latency (default: 2m, 5s)
  latency-repeat [N] [dur] [delay]    N separate sessions back-to-back (default: 5x 1m)

LOAD TESTS (multiple rooms — how does it scale?):
  load [rooms] [duration]              Concurrent agent rooms (default: 3 rooms, 2m)
  media [pubs] [subs] [duration]       Audio transport quality (default: 5 pubs, 20 subs, 2m)

FULL SUITE:
  all                                  Run everything: latency first, then load

Examples:
  ./run-tests.sh quick                 # Can the agent connect? (30s)
  ./run-tests.sh latency               # Measure response time (2 min, ~24 samples)
  ./run-tests.sh latency 5m 3s         # More samples (5 min, speech every 3s, ~100 samples)
  ./run-tests.sh latency-repeat 5      # 5 separate sessions (catch cold-start issues)
  ./run-tests.sh load 5 5m             # 5 concurrent rooms for 5 min
  ./run-tests.sh media 10 100 3m       # 10 audio pubs, 100 subs, 3 min
  ./run-tests.sh all                   # Full suite: latency -> load -> media

Results saved to: ./results/<test>_<timestamp>.log
USAGE
}

case "${1:-help}" in
  quick)           run_quick_test ;;
  latency)         run_latency_test "${2:-2m}" "${3:-5s}" ;;
  latency-repeat)  run_latency_repeat "${2:-5}" "${3:-1m}" "${4:-5s}" ;;
  load)            run_load_test "${2:-3}" "${3:-2m}" ;;
  media)           run_media_test "${2:-5}" "${3:-20}" "${4:-2m}" ;;
  all)             run_all_tests ;;
  help|*)          print_usage ;;
esac
