import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE_PATH = path.join(ROOT, "throttle-state.json");

function readState() {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Generic "has enough time passed since we last did X" helper, backed by a
 * small persisted file (cached alongside state.json in the cloud workflow)
 * so the interval holds even though the bot itself gets invoked far more
 * often than the desired cadence (e.g. cron-job.org firing every ~1 min for
 * a feature that should only actually happen every 5 min).
 */
export function isDue(key, intervalMs) {
  const state = readState();
  const last = state[key];
  if (!last) return true;
  return Date.now() - new Date(last).getTime() >= intervalMs;
}

export function markDone(key) {
  const state = readState();
  state[key] = new Date().toISOString();
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    // best-effort - worst case it just fires again next run
  }
}
