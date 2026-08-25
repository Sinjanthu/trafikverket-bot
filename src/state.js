import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE_PATH = path.join(ROOT, "state.json");

export function loadSeen() {
  // isFirstRun tells index.js whether state.json existed before this run,
  // so it knows whether to notify about what it finds or just seed silently.
  if (!existsSync(STATE_PATH)) return { seen: new Set(), isFirstRun: true };
  try {
    const arr = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    return { seen: new Set(arr), isFirstRun: false };
  } catch {
    return { seen: new Set(), isFirstRun: true };
  }
}

export function saveSeen(set) {
  writeFileSync(STATE_PATH, JSON.stringify([...set], null, 2));
}

export function occasionKey(cityName, occasion) {
  return `${cityName}|${occasion.date}|${occasion.time}|${occasion.locationName ?? ""}`;
}
