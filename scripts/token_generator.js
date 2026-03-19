/**
 * LiveKit Token Generator
 *
 * Usage:
 *   node scripts/token_generator.js
 *   node scripts/token_generator.js --room my-room --agent-name my-agent
 */

import { randomBytes } from "crypto";
import { AccessToken } from "livekit-server-sdk";
import { loadEnv, getEnv } from "./env.js";

loadEnv();

export async function generateToken({
  apiKey,
  apiSecret,
  room,
  identity,
  agentName,
  ttlSeconds = 3600,
} = {}) {
  apiKey = apiKey || getEnv("LIVEKIT_API_KEY");
  apiSecret = apiSecret || getEnv("LIVEKIT_API_SECRET");
  room = room || getEnv("LIVEKIT_ROOM", "latency-test-room");
  agentName = agentName || getEnv("LIVEKIT_AGENT_NAME");
  const prefix = getEnv("BOT_IDENTITY_PREFIX", "latency-bot");
  identity = identity || `${prefix}-${randomBytes(4).toString("hex")}`;

  if (!apiKey || !apiSecret) {
    throw new Error(
      "Missing LIVEKIT_API_KEY / LIVEKIT_API_SECRET. Set them in .env"
    );
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: identity,
    ttl: ttlSeconds,
  });

  const grant = { roomJoin: true, roomCreate: true, room };
  if (agentName) {
    grant.roomMetadata = JSON.stringify({ agentName });
  }
  at.addGrant(grant);

  const token = await at.toJwt();

  console.log(`  [Token] identity=${identity} room=${room} agent=${agentName || "(none)"}`);
  return token;
}

export async function getToken({ apiKey, apiSecret, room, identity, agentName, cliToken } = {}) {
  if (cliToken) {
    console.log("  [Token] Using --token argument");
    return cliToken;
  }
  return generateToken({ apiKey, apiSecret, room, identity, agentName });
}

// Standalone CLI
if (process.argv[1].endsWith("token_generator.js")) {
  import("minimist").then(async ({ default: minimist }) => {
    const args = minimist(process.argv.slice(2), {
      string: ["api-key", "api-secret", "room", "identity", "agent-name"],
    });
    try {
      const token = await generateToken({
        apiKey: args["api-key"],
        apiSecret: args["api-secret"],
        room: args["room"],
        identity: args["identity"],
        agentName: args["agent-name"],
      });
      console.log(`\n  ${token}\n`);
    } catch (err) {
      console.error("ERROR:", err.message);
      process.exit(1);
    }
  });
}
