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

function buildEmbed(cityName, occasion, configuredTransmission, examLabel) {
  const label = transmissionLabel(occasion, configuredTransmission);
  const title = `🚗 1 new time — ${examLabel}${label ? ` Grattis ${label}` : ""}`;

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

const URGENT_WITHIN_DAYS = 5;

export function isUrgent(occasion) {
  if (!occasion.date) return false;
  const target = new Date(`${occasion.date}T00:00:00`);
  if (Number.isNaN(target.getTime())) return false;
  const diffDays = (target.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  return diffDays <= URGENT_WITHIN_DAYS;
}

export async function notifyDiscord(webhookUrl, { cityName, occasions, transmission, examLabel = "Körprov" }) {
  if (occasions.length === 0) return;

  const embeds = occasions.map((o) => buildEmbed(cityName, o, transmission, examLabel));
  // @everyone only for genuinely new slots happening soon - not on every
  // heartbeat, and not for far-future openings months out.
  const urgent = occasions.some(isUrgent);

  for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
    const batch = embeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
    const body = { embeds: batch };
    if (urgent && i === 0) body.content = "@everyone";

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

// Periodic "here's what's open right now" digest - plain content UNLESS at
// least one currently-listed slot is within URGENT_WITHIN_DAYS, in which
// case it pings @everyone same as a fresh new-slot alert would. Since this
// recomputes fresh every ~5 min, that ping naturally repeats every cycle
// for as long as an urgent slot keeps showing up, and just as naturally
// stops the moment it's gone (booked/removed) - no separate tracking needed.
export async function notifyDiscordPeriodicSummary(webhookUrl, { title, cityBlocks, urgent }) {
  const lines = urgent ? ["@everyone", title] : [title];
  for (const { cityName, availableCount, first5 } of cityBlocks) {
    lines.push(`\n📍 **${cityName}**: ${availableCount} available`);
    lines.push(`First 5: ${first5.join(", ") || "none"}`);
  }
  const content = lines.join("\n");

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      console.error(
        `Discord periodic summary post failed: HTTP ${res.status} ${await res.text().catch(() => "")}`
      );
    }
  } catch (err) {
    console.error(`Discord periodic summary post failed: ${err.message}`);
  }
}

export async function notifyDiscordCookieWarning(webhookUrl, cookieWarning) {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: cookieWarning }),
    });
    if (!res.ok) {
      console.error(
        `Discord cookie-warning post failed: HTTP ${res.status} ${await res.text().catch(() => "")}`
      );
    }
  } catch (err) {
    console.error(`Discord cookie-warning post failed: ${err.message}`);
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
