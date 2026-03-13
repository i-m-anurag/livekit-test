# LiveKit Test Suite — Latency First, Then Load

Test latency and performance of your LiveKit server + AI agent using the official **LiveKit CLI** (`lk`).

## Prerequisites

- [LiveKit CLI](https://docs.livekit.io/home/cli/cli-setup/) installed (`lk --version`)
- LiveKit server running (self-hosted or cloud)
- AI agent deployed and registered

## Quick Start

```bash
# 1. Configure credentials
cp .env.example .env
# Edit: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_AGENT_NAME

# 2. Verify connectivity
lk room list --url wss://your-server --api-key KEY --api-secret SECRET

# 3. Smoke test
./run-tests.sh quick

# 4. Measure latency
./run-tests.sh latency

# 5. View results
./export-results.sh latest
```

---

## Latency Tests (Single Room)

These test **one call at a time** — measuring how fast your agent responds.

### Quick Smoke Test
Can the agent connect and respond? (30 seconds)
```bash
./run-tests.sh quick
```

### Single Session Latency
One room, one agent, measures response time per speech cycle.
```bash
./run-tests.sh latency               # 2 min, speech every 5s (~24 samples)
./run-tests.sh latency 5m            # 5 min (~60 samples)
./run-tests.sh latency 5m 3s         # 5 min, speech every 3s (~100 samples)
./run-tests.sh latency 10m 5s        # 10 min (~120 samples, long soak)
```

**What it measures per sample:**
- Agent join time (room connect -> agent appears)
- E2E response latency (speech sent -> agent audio received)

### Repeated Sessions
Runs N **separate** room sessions back-to-back. Each session = fresh room + fresh agent join.
```bash
./run-tests.sh latency-repeat 5            # 5 sessions x 1 min each
./run-tests.sh latency-repeat 10 2m        # 10 sessions x 2 min each
./run-tests.sh latency-repeat 5 1m 3s      # 5 sessions, speech every 3s
```

**Why this matters:**
- Catches **cold-start** issues (first call slower than rest?)
- Tests **consistency** across separate connections
- Detects **intermittent spikes** that a single session might miss

---

## Load Tests (Multiple Rooms)

These test **scaling** — how your system performs under concurrent usage.

### Agent Concurrency
Multiple rooms, each with its own agent, running simultaneously.
```bash
./run-tests.sh load 3                 # 3 concurrent rooms, 2 min
./run-tests.sh load 5 5m              # 5 rooms, 5 min
./run-tests.sh load 10 10m            # 10 rooms, 10 min (stress)
```

### Media Transport Quality
Simulates audio publishers and subscribers — measures jitter, packet loss, bitrate.
```bash
./run-tests.sh media                  # 5 audio pubs, 20 subs, 2 min
./run-tests.sh media 10 100 3m        # 10 pubs, 100 subs, 3 min
```

---

## Full Suite

Runs everything in order: latency first, then load.

```bash
./run-tests.sh all
```

Order: `quick -> latency -> repeated sessions -> concurrent load -> media`

---

## Exporting Results

```bash
./export-results.sh              # Summary of all results
./export-results.sh latest       # Print the latest result in full
./export-results.sh csv          # Export metadata as CSV
./export-results.sh zip          # Package all into a zip for sharing
./export-results.sh clean        # Delete all result files
```

---

## Standalone lk Commands

### Agent Latency (single room)
```bash
lk perf agent-load-test \
  --url wss://your-server.com \
  --api-key YOUR_KEY \
  --api-secret YOUR_SECRET \
  --rooms 1 \
  --agent-name your-agent \
  --duration 2m \
  --echo-speech-delay 5s
```

### Agent Load (concurrent rooms)
```bash
lk perf agent-load-test \
  --url wss://your-server.com \
  --api-key YOUR_KEY \
  --api-secret YOUR_SECRET \
  --rooms 5 \
  --agent-name your-agent \
  --duration 5m \
  --echo-speech-delay 5s
```

### Media Load
```bash
lk load-test \
  --url wss://your-server.com \
  --api-key YOUR_KEY \
  --api-secret YOUR_SECRET \
  --room load-test \
  --audio-publishers 10 \
  --subscribers 100 \
  --duration 2m \
  --simulate-speakers
```

---

## Flag Reference

### `lk perf agent-load-test`
| Flag | Description | Default |
|------|-------------|---------|
| `--rooms N` | Number of concurrent rooms | - |
| `--agent-name NAME` | Agent to dispatch (must match WorkerOptions) | - |
| `--duration TIME` | How long to run (30s, 2m, 5m) | until cancelled |
| `--echo-speech-delay TIME` | Delay between speech cycles | 5s |
| `--attribute key=value` | Pass attributes to agent (repeatable) | - |
| `--attribute-file FILE` | Read attributes from JSON file | - |

### `lk load-test`
| Flag | Description | Default |
|------|-------------|---------|
| `--room NAME` | Room name | - |
| `--audio-publishers N` | Number of audio publishers | 0 |
| `--video-publishers N` | Number of video publishers | 0 |
| `--subscribers N` | Number of subscriber clients | 0 |
| `--duration TIME` | How long to run | until cancelled |
| `--simulate-speakers` | Rotate active speakers | false |

---

## Interpreting Results

| Metric | Good | Investigate |
|--------|------|-------------|
| Agent join time | < 2s | > 5s |
| E2E response latency | < 1.5s | > 3s |
| Audio jitter | < 20ms | > 50ms |
| Packet loss | < 0.5% | > 2% |
| RTT | < 50ms | > 150ms |

---

## Recommended Test Flow

```
Step 1:  ./run-tests.sh quick             Is the agent alive?
Step 2:  ./run-tests.sh latency 5m 3s     Baseline latency (~100 samples)
Step 3:  ./run-tests.sh latency-repeat 5  Consistency across sessions
Step 4:  ./run-tests.sh load 5 5m         Does latency degrade at 5x concurrency?
Step 5:  ./export-results.sh zip          Package & share results
```
