# LiveKit Latency Test Suite (Node.js)

Complete latency testing toolkit for LiveKit self-hosted WebRTC + AI agent setup.
**All scripts run in Node.js — no Python required.**

---

## Quick Start

### Prerequisites
- Node.js >= 18.0.0
- npm or [pnpm](https://pnpm.io) / [yarn](https://yarnpkg.com)

### Install dependencies

```bash
npm install
# or
pnpm install
```

### Set up `.env`

```bash
cp .env.example .env
# Fill in: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_AGENT_NAME
```

Tokens are **auto-generated** from your API key + secret — no manual token needed.

### Token generation priority
Each script resolves the token in this order:
1. `--token YOUR_TOKEN` CLI argument (explicit override)
2. `LIVEKIT_TOKEN` in `.env` (pre-generated token)
3. Auto-generated from `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET` in `.env` ✅ recommended

> **No `AGENT_HOST` / `AGENT_PORT` needed.** Your agent auto-joins rooms via LiveKit dispatch. Set `LIVEKIT_AGENT_NAME` — it is embedded in the room token so LiveKit routes the right agent in automatically.

Generate a token standalone:
```bash
node scripts/token_generator.js
# or
npm run token
```

---

## Test Overview

| Test | Script | Runtime | What it measures |
|------|--------|---------|-----------------|
| 1 – E2E Audio Latency | `test1_e2e_audio_latency.js` | Node.js | Mic send → agent response received |
| 2 – Signaling Latency | `test2_signaling_latency.js` | Browser console | SDP RTT, ICE state times |
| 3 – TTFB | `test3_ttfb.js` | Node.js | VAD silence → first audio byte |
| 4 – Agent Pipeline | Inside `test3_ttfb.js` (Part A) | Node.js (agent) | STT / LLM / TTS per-stage timing |
| 5 – Network RTT | `test5_network_rtt.js` | Node.js | TCP RTT, DNS, WebSocket, traceroute |
| 6 – Jitter & Packet Loss | `test6_jitter_packet_loss.js` | Browser console | Jitter, loss %, RTT from WebRTC stats |
| 7 – ICE Connection Time | `test7_ice_connection_time.js` | Browser console | ICE phases, TCP vs UDP, TURN detection |

---

## Running Each Test

---

### TEST 1 – End-to-End Audio Latency *(Node.js bot)*

```bash
# Token auto-generated from .env (recommended):
node scripts/test1_e2e_audio_latency.js
# or
npm run test1

# With explicit args:
node scripts/test1_e2e_audio_latency.js \
  --url   wss://your-livekit-server.com \
  --token YOUR_TOKEN \
  --runs  20 \
  --delay 3
```

**Output:** `results/test1_e2e_latency.json`

---

### TEST 2 – Signaling Latency *(Browser console — manual steps)*

**Steps:**
1. Open your LiveKit web app in Chrome
2. Open **DevTools → Console** (`F12`)
3. Paste the entire contents of `test2_signaling_latency.js`
4. Press `Enter` — the monitor installs silently
5. Make a call (join a room)
6. When done, run:
   ```js
   collectSignalingMetrics()   // print summary table
   exportSignalingMetrics()    // download JSON
   ```

---

### TEST 3 – TTFB *(Node.js bot)*

```bash
node scripts/test3_ttfb.js
# or
npm run test3

# With explicit args:
node scripts/test3_ttfb.js --runs 15
```

**Part A – Add to your agent code for per-stage pipeline timing:**

```js
import { TTFBInstrumentation } from "./scripts/test3_ttfb.js";
const instr = new TTFBInstrumentation();

// When VAD detects end of speech:
const turn = instr.startTurn();

// After each pipeline stage:
turn.sttStartAt       = performance.now();  // before STT
turn.sttEndAt         = performance.now();  // after STT
turn.llmStartAt       = performance.now();  // before LLM
turn.llmFirstTokenAt  = performance.now();  // on first LLM token
turn.ttsStartAt       = performance.now();  // before TTS
turn.ttsFirstChunkAt  = performance.now();  // on first TTS chunk
turn.firstAudioSentAt = performance.now();  // when audio sent to LiveKit

instr.finishTurn(turn);
```

**Outputs:** `results/test3_ttfb.json`, `results/ttfb_agent.jsonl`

---

### TEST 4 – Agent Pipeline Timing *(no separate script)*

Captured by Part A instrumentation in Test 3. Per-stage breakdown:
- `sttDurationMs` — Speech-to-Text time
- `llmDurationMs` — LLM time to first token
- `ttsFirstChunkMs` — TTS time to first audio chunk
- `ttfbMs` — Total: VAD silence → audio sent

---

### TEST 5 – Network RTT *(Node.js)*

```bash
node scripts/test5_network_rtt.js
# or
npm run test5

# With explicit args:
node scripts/test5_network_rtt.js \
  --livekit-host your-livekit-server.com \
  --runs 20
```

**Output:** `results/test5_network_rtt.json`

---

### TEST 6 – Jitter & Packet Loss *(Browser console)*

**Steps:**
1. Join a LiveKit room in Chrome
2. Open **DevTools → Console**
3. Paste contents of `test6_jitter_packet_loss.js`
4. Let it run (30s to 5min recommended)
5. When done:
   ```js
   stopJitterMonitor()     // stop + print summary
   exportJitterResults()   // download JSON
   ```

---

### TEST 7 – ICE Connection Time *(Browser console)*

**Steps:**
1. Open your LiveKit web app on a fresh page load
2. Open **DevTools → Console** immediately
3. Paste `test7_ice_connection_time.js` **before joining a room**
4. Join the room / make a call
5. When connected:
   ```js
   analyzeActiveConnections()  // print table
   exportICEResults()          // download JSON
   ```

---

## Run All Node.js Tests in Sequence

```bash
npm run all
# which runs: test1 → test3 → test5 → analyze
```

Or manually:
```bash
node scripts/test1_e2e_audio_latency.js && \
node scripts/test3_ttfb.js && \
node scripts/test5_network_rtt.js && \
node scripts/analyze_results.js
```

## Analyze All Results

```bash
node scripts/analyze_results.js
# or
npm run analyze
```

---

## Interpreting Results

| Metric | Good | Investigate |
|--------|------|-------------|
| TCP RTT to LiveKit | < 50ms | > 100ms |
| ICE connection time | < 300ms | > 1000ms |
| SDP round-trip | < 100ms | > 300ms |
| STT latency | < 400ms | > 800ms |
| LLM first token | < 600ms | > 1500ms |
| TTS first chunk | < 200ms | > 500ms |
| TTFB (total) | < 1200ms | > 2500ms |
| E2E audio latency | < 1500ms | > 3000ms |
| Jitter | < 20ms | > 50ms |
| Packet loss | < 0.5% | > 2% |
