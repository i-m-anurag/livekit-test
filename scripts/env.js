/**
 * env.js — Shared environment variable loader
 */

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadEnv() {
  config({ path: resolve(__dirname, "..", ".env") });
}

export function getEnv(key, fallback = "") {
  return process.env[key] || fallback;
}

export function getEnvInt(key, fallback = 0) {
  const val = process.env[key];
  return val !== undefined ? parseInt(val, 10) : fallback;
}

export function getEnvFloat(key, fallback = 0.0) {
  const val = process.env[key];
  return val !== undefined ? parseFloat(val) : fallback;
}
