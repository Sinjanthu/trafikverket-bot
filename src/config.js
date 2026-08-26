import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = path.join(ROOT, "config.json");
const PAYLOAD_PATH = path.join(ROOT, "payload.json");

function readJson(p, label) {
  if (!existsSync(p)) {
    throw new Error(
      `${label} not found at ${p}. See README.md's Setup section - you need to copy the .example file and fill it in.`
    );
  }
  return JSON.parse(readFileSync(p, "utf-8"));
}

export function loadConfig() {
  const cfg = readJson(CONFIG_PATH, "config.json");
  const payloadTemplate = readJson(PAYLOAD_PATH, "payload.json");

  // GitHub Actions (or any CI) injects secrets as env vars rather than real
  // files with real values committed to the repo. If these are set, they
  // override whatever placeholder is in config.json/payload.json.
  if (process.env.TRAFIKVERKET_COOKIE) cfg.cookie = process.env.TRAFIKVERKET_COOKIE;
  if (process.env.DISCORD_WEBHOOK_URL) {
    cfg.discord = cfg.discord || {};
    cfg.discord.webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  }
  if (process.env.TRAFIKVERKET_PAYLOAD_JSON) {
    try {
      Object.assign(payloadTemplate, JSON.parse(process.env.TRAFIKVERKET_PAYLOAD_JSON));
    } catch {
      throw new Error("TRAFIKVERKET_PAYLOAD_JSON env var is set but isn't valid JSON.");
    }
  }

  const missing = [];
  if (!cfg.apiUrl || cfg.apiUrl.startsWith("PASTE_")) missing.push("apiUrl");
  if (!cfg.cookie || cfg.cookie.startsWith("PASTE_")) missing.push("cookie");
  if (!cfg.discord?.webhookUrl || cfg.discord.webhookUrl.startsWith("PASTE_"))
    missing.push("discord.webhookUrl");
  if (!Array.isArray(cfg.cities) || cfg.cities.length === 0)
    missing.push("cities (must be a non-empty array)");

  for (const city of cfg.cities || []) {
    if (!city.locationId || String(city.locationId).startsWith("PASTE_")) {
      missing.push(`cities[] entry "${city.name || "?"}" is missing a real locationId`);
    }
  }

  if (!["automatic", "manual", "any"].includes(cfg.transmission)) {
    missing.push('transmission (must be "automatic", "manual", or "any")');
  }

  if (missing.length) {
    throw new Error(
      "config.json is incomplete. Fix these and re-run:\n  - " + missing.join("\n  - ")
    );
  }

  // Strip helper/comment keys out of the payload template before using it.
  const cleanTemplate = { ...payloadTemplate };
  delete cleanTemplate._comment;
  delete cleanTemplate._example_shape_only;

  return { cfg, payloadTemplate: cleanTemplate };
}

export const CONFIG_PATH_FOR_LOGGING = CONFIG_PATH;
