/**
 * env.js — Shared environment variable loader
 * Loads .env from the project root (one level above scripts/).
 */

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadEnv() {
  config({ path: resolve(__dirname, "..", ".env") });
}

/**
 * Get an env variable with an optional default.
 * @param {string} key
 * @param {string} [fallback]
 * @returns {string}
 */
export function getEnv(key, fallback = "") {
  return process.env[key] || fallback;
}

/**
 * Get an env variable as integer.
 */
export function getEnvInt(key, fallback = 0) {
  const val = process.env[key];
  return val !== undefined ? parseInt(val, 10) : fallback;
}

/**
 * Get an env variable as float.
 */
export function getEnvFloat(key, fallback = 0.0) {
  const val = process.env[key];
  return val !== undefined ? parseFloat(val) : fallback;
}
