import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stockholmTimeLabel } from "./time.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WARNING_STATE_PATH = path.join(ROOT, "cookie-warning-state.json");

/**
 * Trafikverket sets a `LoginValid=YYYY-MM-DD HH:MM` cookie at login time,
 * stating exactly when the session expires. We parse it so we can warn on
 * Discord before the bot hits a hard failure instead of only after.
 *
 * The timestamp has no timezone info - it's Trafikverket's own server time
 * (Sweden). We approximate Swedish DST (CEST, UTC+2, roughly late March -
 * late October; UTC+1 otherwise) since Node/GitHub Actions run in UTC and
 * would otherwise misread it. This is a heads-up warning, not a hard cutover,
 * so a rough approximation is fine - the real expiry is still enforced
 * server-side regardless of what we compute here.
 */
export function parseCookieExpiry(cookieStr) {
  const m = /LoginValid=([^;]+)/.exec(cookieStr || "");
  if (!m) return null;

  const raw = m[1].trim(); // e.g. "2026-08-30 16:52"
  const [datePart, timePart] = raw.split(" ");
  if (!datePart || !timePart) return null;

  const month = Number(datePart.split("-")[1]);
  if (!Number.isFinite(month)) return null;
  const offset = month >= 3 && month <= 10 ? "+02:00" : "+01:00";

  const d = new Date(`${datePart}T${timePart}:00${offset}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function readLastWarnedExpiry() {
  if (!existsSync(WARNING_STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(WARNING_STATE_PATH, "utf-8")).lastWarnedExpiry || null;
  } catch {
    return null;
  }
}

function writeLastWarnedExpiry(expiryIso) {
  try {
    writeFileSync(WARNING_STATE_PATH, JSON.stringify({ lastWarnedExpiry: expiryIso }, null, 2));
  } catch {
    // best-effort - worst case we just warn again next run
  }
}

/**
 * Returns a short warning string when the cookie is close to (or past) its
 * stated expiry, or null when there's nothing worth flagging yet.
 *
 * Only fires ONCE per distinct expiry timestamp (persisted to a small state
 * file) - without this, polling every ~1 min means the final hour before
 * expiry would post ~60 near-identical warnings instead of just one.
 * Refreshing the cookie naturally resets this (new expiry = warn again).
 */
export function cookieExpiryWarning(cookieStr, { warnWithinMs = 60 * 60 * 1000 } = {}) {
  const expiry = parseCookieExpiry(cookieStr);
  if (!expiry) return null;

  const msRemaining = expiry.getTime() - Date.now();
  if (msRemaining > warnWithinMs) return null;

  const expiryIso = expiry.toISOString();
  if (readLastWarnedExpiry() === expiryIso) return null;

  const timeLabel = stockholmTimeLabel(expiry) + " Stockholm time";
  const message =
    msRemaining <= 0
      ? `⏰ Cookie's stated expiry (${timeLabel}) has already passed - refresh it if you start seeing session errors.`
      : `⏰ Cookie expires in ~${Math.round(msRemaining / 60000)} min (${timeLabel}) - refresh it soon.`;

  writeLastWarnedExpiry(expiryIso);
  return message;
}
