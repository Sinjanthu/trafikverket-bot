/**
 * Trafikverket, and you, think in Swedish local time - UTC in Discord
 * messages is just confusing. This formats a Date as Stockholm wall-clock
 * time (handles CET/CEST automatically via the IANA timezone database).
 */
export function stockholmTimeLabel(date = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}
