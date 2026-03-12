/**
 * LiveKit Token Generator
 * ========================
 * Shared utility used by all latency test scripts.
 *
 * HOW LIVEKIT TOKENS WORK:
 *   A LiveKit token is a JWT signed with your API key + API secret.
 *   The server URL is NOT part of the token — it is only used when
 *   connecting (i.e. in --url / LIVEKIT_URL). The token declares
 *   WHO you are and WHAT room you can join.
 *
 *   Token      = JWT signed with (API_KEY + API_SECRET)
 *                  containing: room name, participant identity, permissions, TTL
 *   Connection = room.connect(LIVEKIT_URL, token)
 *
 * WHERE TO FIND API KEY + SECRET (self-hosted LiveKit):
 *   In your LiveKit server config file (livekit.yaml):
 *     keys:
 *       <YOUR_API_KEY>: <YOUR_API_SECRET>
 *   Or in the env vars passed when starting LiveKit:
 *     LIVEKIT_KEYS="<YOUR_API_KEY>: <YOUR_API_SECRET>"
 *
 * Usage (standalone):
 *   node scripts/token_generator.js
 *   node scripts/token_generator.js --api-key KEY --api-secret SECRET --room my-room
 */

import { randomBytes } from "crypto";
import { AccessToken } from "livekit-server-sdk";
import { loadEnv, getEnv } from "./env.js";

loadEnv();

// ── Generate token ────────────────────────────────────────────────────────────

/**
 * Generate a LiveKit participant JWT token.
 *
 * NOTE: LIVEKIT_URL is NOT needed here. Tokens are signed with
 *       API_KEY + API_SECRET only. The URL is used at connect time.
 *
 * @param {object} opts
 * @param {string} [opts.apiKey]     - defaults to LIVEKIT_API_KEY env var
 * @param {string} [opts.apiSecret]  - defaults to LIVEKIT_API_SECRET env var
 * @param {string} [opts.room]       - defaults to LIVEKIT_ROOM env var
 * @param {string} [opts.identity]   - auto-generated if omitted
 * @param {string} [opts.agentName]  - defaults to LIVEKIT_AGENT_NAME env var
 *                                     passed as room metadata so LiveKit dispatches
 *                                     the correct agent into the room automatically
 * @param {number} [opts.ttlSeconds] - token TTL in seconds (default: 3600)
 * @returns {Promise<string>} JWT token string
 */
export async function generateToken({
  apiKey,
  apiSecret,
  room,
  identity,
  agentName,
  ttlSeconds = 3600,
} = {}) {
  apiKey    = apiKey     || getEnv("LIVEKIT_API_KEY");
  apiSecret = apiSecret  || getEnv("LIVEKIT_API_SECRET");
  room      = room       || getEnv("LIVEKIT_ROOM", "latency-test-room");
  agentName = agentName  || getEnv("LIVEKIT_AGENT_NAME");
  const prefix = getEnv("BOT_IDENTITY_PREFIX", "latency-bot");
  identity  = identity   || `${prefix}-${randomBytes(4).toString("hex")}`;

  if (!apiKey || !apiSecret) {
    throw new Error(
      "\n  Missing LiveKit credentials.\n" +
      "  Set these in your .env file:\n" +
      "    LIVEKIT_API_KEY=<your api key>\n" +
      "    LIVEKIT_API_SECRET=<your api secret>\n\n" +
      "  Find them in your LiveKit server config (livekit.yaml) under 'keys:'\n" +
      "  NOTE: LIVEKIT_URL is NOT needed for token generation."
    );
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: identity,
    ttl: ttlSeconds,
  });

  // roomCreate: true lets the bot create the room if it doesn't exist yet.
  // metadata carries the agent name so LiveKit's dispatch system knows
  // which background agent to auto-join into this room.
  const grant = {
    roomJoin:   true,
    roomCreate: true,
    room,
  };
  if (agentName) {
    grant.roomMetadata = JSON.stringify({ agentName });
  }
  at.addGrant(grant);

  const token = await at.toJwt();

  const serverUrl = getEnv("LIVEKIT_URL", "(not set — needed for connection, not token)");
  console.log(`  [Token] Generated via livekit-server-sdk`);
  console.log(`          api_key    = ${apiKey}`);
  console.log(`          identity   = ${identity}`);
  console.log(`          room       = ${room}`);
  console.log(`          agent_name = ${agentName || "(none — agent dispatch not set)"}`);
  console.log(`          ttl        = ${ttlSeconds}s`);
  console.log(`          server     = ${serverUrl}  ← used at connect time, not for token signing`);

  return token;
}

/**
 * Convenience wrapper used by test scripts.
 * Uses cliToken directly if provided, otherwise auto-generates from API key/secret.
 */
export async function getToken({ apiKey, apiSecret, room, identity, agentName, cliToken } = {}) {
  if (cliToken) {
    console.log("  [Token] Using token provided via --token argument");
    return cliToken;
  }
  return generateToken({ apiKey, apiSecret, room, identity, agentName });
}

// ── Standalone CLI ────────────────────────────────────────────────────────────

if (process.argv[1].endsWith("token_generator.js")) {
  import("minimist").then(async ({ default: minimist }) => {
    const args = minimist(process.argv.slice(2), {
      string: ["api-key", "api-secret", "room", "identity", "agent-name"],
      default: {
        "api-key":    getEnv("LIVEKIT_API_KEY",    ""),
        "api-secret": getEnv("LIVEKIT_API_SECRET", ""),
        "room":       getEnv("LIVEKIT_ROOM",       "latency-test-room"),
        "agent-name": getEnv("LIVEKIT_AGENT_NAME", ""),
        "ttl":        3600,
      },
    });

    if (!args["api-key"] || !args["api-secret"]) {
      console.error(
        "ERROR: LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required.\n" +
        "  Set them in .env  OR  pass --api-key and --api-secret.\n" +
        "  Find them in your LiveKit server config (livekit.yaml) under 'keys:'"
      );
      process.exit(1);
    }

    try {
      const token = await generateToken({
        apiKey:     args["api-key"],
        apiSecret:  args["api-secret"],
        room:       args["room"],
        identity:   args["identity"],
        agentName:  args["agent-name"],
        ttlSeconds: Number(args["ttl"]),
      });
      console.log("\n  Token (copy into LIVEKIT_TOKEN in .env if needed):\n");
      console.log(`  ${token}\n`);
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });
}
