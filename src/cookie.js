import { stockholmTimeLabel } from "./time.js";

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

/**
 * Returns a short warning string when the cookie is close to (or past) its
 * stated expiry, or null when there's nothing worth flagging yet.
 */
export function cookieExpiryWarning(cookieStr, { warnWithinMs = 60 * 60 * 1000 } = {}) {
  const expiry = parseCookieExpiry(cookieStr);
  if (!expiry) return null;

  const msRemaining = expiry.getTime() - Date.now();
  const timeLabel = stockholmTimeLabel(expiry) + " Stockholm time";

  if (msRemaining <= 0) {
    return `⏰ Cookie's stated expiry (${timeLabel}) has already passed - refresh it if you start seeing session errors.`;
  }
  if (msRemaining <= warnWithinMs) {
    const minutes = Math.round(msRemaining / 60000);
    return `⏰ Cookie expires in ~${minutes} min (${timeLabel}) - refresh it soon.`;
  }
  return null;
}
