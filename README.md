# LiveKit Latency Test Suite (Node.js)

Measures 16 latency metrics for your LiveKit WebRTC + AI agent setup.

## Metrics Covered

| # | Metric | Test | Runtime |
|---|--------|------|---------|
| 1 | E2E round-trip latency | `test_e2e_latency.js` | Node.js |
| 2 | Agent dispatch time | `test_e2e_latency.js` | Node.js |
| 3 | STT latency | `test_ttfb.js` (agent instrumentation) | Agent code |
| 4 | LLM time to first token | `test_ttfb.js` (agent instrumentation) | Agent code |
| 5 | TTS time to first chunk | `test_ttfb.js` (agent instrumentation) | Agent code |
| 6 | TTFB (STT+LLM+TTS combined) | `test_ttfb.js` | Node.js |
| 7 | TCP RTT to LiveKit | `test_network_rtt.js` | Node.js |
| 8 | WebSocket handshake latency | `test_network_rtt.js` | Node.js |
| 9 | DNS resolution time | `test_network_rtt.js` | Node.js |
| 10 | Traceroute hop latency | `test_network_rtt.js` | Node.js |
| 11 | SDP signaling RTT | `browser/webrtc_signaling.js` | Browser |
| 12 | ICE connection time | `browser/webrtc_signaling.js` | Browser |
| 13 | ICE transport type (UDP/TCP) | `browser/webrtc_signaling.js` | Browser |
| 14 | TURN relay usage | `browser/webrtc_signaling.js` | Browser |
| 15 | Jitter | `browser/jitter_packet_loss.js` | Browser |
| 16 | Packet loss % | `browser/jitter_packet_loss.js` | Browser |

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_AGENT_NAME

# 3. Run all Node.js tests
./run-tests.sh all

# 4. View consolidated results
./run-tests.sh analyze
```

## Node.js Tests

### E2E Latency + Agent Dispatch
```bash
./run-tests.sh e2e                      # default: 10 runs
./run-tests.sh e2e --runs 20 --delay 3  # 20 runs, 3s between
```

### TTFB (Time to First Audio Byte)
```bash
./run-tests.sh ttfb                     # default: 10 runs
./run-tests.sh ttfb --runs 15
```

### Network RTT (TCP, WebSocket, DNS, Traceroute)
```bash
./run-tests.sh network                  # default: 20 runs
./run-tests.sh network --runs 30
```

### Run Everything
```bash
./run-tests.sh all
```

## Browser Tests (paste in DevTools console)

### WebRTC Signaling + ICE + Transport
Measures: SDP RTT, ICE connection time, UDP vs TCP, TURN detection

1. Open your LiveKit web app in Chrome
2. Open DevTools Console (F12)
3. Paste `scripts/browser/webrtc_signaling.js` **before** joining a room
4. Join the room
5. Run: `getSignalingResults()` or `exportSignalingResults()`

### Jitter & Packet Loss
Measures: Jitter, packet loss %, RTT, bitrate

1. Join a LiveKit room in Chrome
2. Open DevTools Console
3. Paste `scripts/browser/jitter_packet_loss.js`
4. Let it run 30s-5min
5. Run: `stopMonitor()` or `exportMonitor()`

## Agent-Side Pipeline Instrumentation

For per-stage breakdown (STT/LLM/TTS), add this to your agent code:

```javascript
import { TTFBInstrumentation } from "./scripts/test_ttfb.js";
const instr = new TTFBInstrumentation();

// On each conversation turn:
const turn = instr.startTurn();
turn.sttStartAt       = performance.now();  // before STT
turn.sttEndAt         = performance.now();  // after STT
turn.llmStartAt       = performance.now();  // before LLM
turn.llmFirstTokenAt  = performance.now();  // first LLM token
turn.ttsStartAt       = performance.now();  // before TTS
turn.ttsFirstChunkAt  = performance.now();  // first TTS chunk
turn.firstAudioSentAt = performance.now();  // audio sent
instr.finishTurn(turn);
```

Results saved to `results/ttfb_agent.jsonl`, auto-included by the analyzer.

## Reference Thresholds

| Metric | Good | Investigate |
|--------|------|-------------|
| E2E audio latency | < 1500ms | > 3000ms |
| Agent dispatch | < 2s | > 5s |
| STT latency | < 400ms | > 800ms |
| LLM first token | < 600ms | > 1500ms |
| TTS first chunk | < 200ms | > 500ms |
| TTFB total | < 1200ms | > 2500ms |
| TCP RTT | < 50ms | > 100ms |
| WebSocket handshake | < 100ms | > 300ms |
| DNS resolution | < 10ms | > 50ms |
| SDP signaling RTT | < 100ms | > 300ms |
| ICE connection time | < 300ms | > 1000ms |
| Jitter | < 20ms | > 50ms |
| Packet loss | < 0.5% | > 2% |

## File Structure

```
scripts/
  env.js                        Environment loader
  utils.js                      Stats, audio, helpers
  token_generator.js            JWT token generation
  test_e2e_latency.js           E2E latency + agent dispatch
  test_ttfb.js                  TTFB + agent instrumentation class
  test_network_rtt.js           TCP, WebSocket, DNS, Traceroute
  analyze_results.js            Consolidated results analyzer
  browser/
    webrtc_signaling.js         SDP, ICE, transport, TURN (browser)
    jitter_packet_loss.js       Jitter, packet loss (browser)
results/                        Output directory (git-ignored)
```
