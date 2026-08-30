import { stockholmTimeLabel } from "./time.js";

const COLOR_AUTOMATIC = 0x2ecc71; // green
const COLOR_MANUAL = 0xe67e22; // orange
const COLOR_UNKNOWN = 0x95a5a6; // grey

const MAX_EMBEDS_PER_MESSAGE = 10; // Discord's hard limit
const DELAY_BETWEEN_MESSAGES_MS = 700; // stay under the webhook rate limit

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function transmissionLabel(o, configuredTransmission) {
  const raw = (o.transmissionRaw || "").toLowerCase();
  if (raw.includes("automat")) return "Automat";
  if (raw.includes("manuell") || raw.includes("manual")) return "Manuell";
  // Fall back to what we're filtering for, if the response didn't say.
  if (configuredTransmission === "automatic") return "Automat";
  if (configuredTransmission === "manual") return "Manuell";
  return "";
}

function transmissionColor(label) {
  if (label === "Automat") return COLOR_AUTOMATIC;
  if (label === "Manuell") return COLOR_MANUAL;
  return COLOR_UNKNOWN;
}

function formatPrice(price) {
  if (price === null || price === undefined || price === "") return null;
  const num = Number(price);
  if (Number.isFinite(num)) {
    return `${num.toLocaleString("sv-SE")} kr`;
  }
  return String(price);
}

function buildEmbed(cityName, occasion, configuredTransmission) {
  const label = transmissionLabel(occasion, configuredTransmission);
  const title = `🚗 1 new time — Körprov${label ? ` Grattis ${label}` : ""}`;

  const lines = [`🚗 **${[occasion.date, occasion.time].filter(Boolean).join(" ")}**`];
  lines.push(`📍 ${cityName}`);
  const price = formatPrice(occasion.price);
  if (price) lines.push(`💰 ${price}`);

  return {
    title,
    description: "Book quickly — cancelled slots go fast.\n\n" + lines.join("\n"),
    color: transmissionColor(label),
    footer: { text: "Trafikverket Notifier" },
    timestamp: new Date().toISOString(),
  };
}

export async function notifyDiscord(webhookUrl, { cityName, occasions, transmission }) {
  if (occasions.length === 0) return;

  const embeds = occasions.map((o) => buildEmbed(cityName, o, transmission));

  for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
    const batch = embeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: batch }),
    });

    if (!res.ok) {
      console.error(
        `Discord webhook failed: HTTP ${res.status} ${await res.text().catch(() => "")}`
      );
    }

    if (i + MAX_EMBEDS_PER_MESSAGE < embeds.length) {
      await sleep(DELAY_BETWEEN_MESSAGES_MS);
    }
  }
}

export async function notifyDiscordHeartbeat(webhookUrl, citySummaries, { cookieWarning } = {}) {
  const time = stockholmTimeLabel() + " Stockholm time";
  const lines = citySummaries.map((s) => {
    if (s.error) return `⚠️ ${s.cityName}: ${s.error}`;
    const newPart = s.newCount > 0 ? `${s.newCount} new` : "no new";
    return `${s.newCount > 0 ? "🚗" : "✅"} ${s.cityName}: ${newPart} (${s.availableCount} available)`;
  });

  const contentLines = [`🔄 Checked ${time}`, ...lines];
  if (cookieWarning) contentLines.push(cookieWarning);
  const content = contentLines.join("\n");

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      console.error(
        `Discord heartbeat failed: HTTP ${res.status} ${await res.text().catch(() => "")}`
      );
    }
  } catch (err) {
    console.error(`Discord heartbeat failed: ${err.message}`);
  }
}

export async function notifyDiscordError(webhookUrl, message) {
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `⚠️ Trafikverket bot error: ${message}` }),
    });
  } catch {
    // best-effort only
  }
}
