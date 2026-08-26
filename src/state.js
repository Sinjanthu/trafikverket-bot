import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE_PATH = path.join(ROOT, "state.json");
const TMP_PATH = path.join(ROOT, "state.json.tmp");

// state.json holds a SNAPSHOT of what was available on the last run, not an
// ever-growing history. Each run compares "what's available now" against
// this snapshot, notifies about anything new, then overwrites the snapshot
// with the current result. This means:
//   - Slots that are no longer available get dropped automatically (no
//     manual cleanup / no unbounded growth).
//   - If a slot disappears and later reappears, it counts as new again and
//     you get notified about it a second time.
export function loadPreviousSnapshot() {
  if (!existsSync(STATE_PATH)) return { previous: new Set(), isFirstRun: true };
  try {
    const arr = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    return { previous: new Set(arr), isFirstRun: false };
  } catch (err) {
    console.error(
      `WARNING: state.json exists but couldn't be read (${err.message}). Treating as first run - this should be rare and usually means a transient file lock (antivirus/cloud sync). If you see this on every run, something else is wrong.`
    );
    return { previous: new Set(), isFirstRun: true };
  }
}

export function saveSnapshot(keysSet) {
  // Write to a temp file first, then rename into place. Rename is atomic at
  // the filesystem level, so state.json is never observable in a half-
  // written state - this is what fixes the "Unexpected end of JSON input"
  // truncation issue (usually caused by antivirus/cloud-sync grabbing the
  // file mid-write on Windows).
  writeFileSync(TMP_PATH, JSON.stringify([...keysSet], null, 2));
  renameSync(TMP_PATH, STATE_PATH);
}

export function occasionKey(cityName, occasion) {
  return `${cityName}|${occasion.date}|${occasion.time}`;
}