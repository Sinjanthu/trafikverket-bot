#!/usr/bin/env node
/**
 * Always-on listener for the /openbrowser Discord slash command. Keeps its
 * own dedicated, persistent, logged-in browser profile open in the
 * background (parked off-screen, same trick as refresh-cookie.js) and, on
 * command, brings it on-screen so you can book immediately.
 *
 * Uses a SEPARATE profile from refresh-cookie.js's (.playwright-profile
 * -manual, not .playwright-profile) on purpose: this process holds its
 * browser open continuously for as long as it runs, which would otherwise
 * permanently conflict with the scheduled cookie-refresh task's periodic
 * use of the same profile. Keeps its own login fresh independently via a
 * periodic reload, same technique, just self-contained.
 *
 * Run directly (or via the hidden VBScript wrapper / scheduled task - see
 * README) - stays running, listening on Discord's Gateway (outbound
 * connection only, no public endpoint needed).
 */
import { Client, GatewayIntentBits, Events } from "discord.js";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = path.join(ROOT, "config.json");
const PROFILE_DIR = path.join(ROOT, ".playwright-profile-manual");
const BOOKING_URL = "https://fp.trafikverket.se/Boka/";
const OFFSCREEN_LEFT = 5130; // just past the real monitor's right edge - see refresh-cookie.js for why not further out
const OFFSCREEN_ARGS = [`--window-position=${OFFSCREEN_LEFT},0`];
const ONSCREEN_BOUNDS = { left: 100, top: 100, width: 1400, height: 900 };
const SELF_REFRESH_MS = 15 * 60 * 1000; // keep the session warm independently

const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const { token, applicationId, guildId } = cfg.discordBot || {};
if (!token || !applicationId || !guildId) {
  console.error("config.json is missing discordBot.token/applicationId/guildId.");
  process.exit(1);
}

let context;
let page;

function isLoggedIn(cookies) {
  return cookies.some((c) => c.name === "FpsExternalIdentity");
}

async function ensureBrowserReady() {
  if (context) return;

  context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, args: OFFSCREEN_ARGS });
  page = context.pages()[0] || (await context.newPage());
  await page.goto(BOOKING_URL);

  let cookies = await context.cookies();
  if (!isLoggedIn(cookies)) {
    console.log("Not logged in on the dedicated manual-open profile - relaunching visibly for BankID login...");
    await context.close();
    context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false });
    page = context.pages()[0] || (await context.newPage());
    await page.goto(BOOKING_URL);

    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      cookies = await context.cookies();
      if (isLoggedIn(cookies)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!isLoggedIn(await context.cookies())) {
      console.error("Timed out waiting for BankID login on startup. /openbrowser won't work until this succeeds.");
      await context.close();
      context = null;
      return;
    }
    // Park it off-screen again now that we're logged in, ready for next time.
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: OFFSCREEN_LEFT, top: 0 } }).catch(() => {});
  }

  console.log("Manual-open browser ready (logged in, parked off-screen).");

  setInterval(async () => {
    try {
      await page.reload();
      console.log("Self-refreshed manual-open browser session.");
    } catch (err) {
      console.error("Self-refresh failed:", err.message);
    }
  }, SELF_REFRESH_MS).unref();
}

async function bringOnScreen() {
  await ensureBrowserReady();
  if (!context) throw new Error("Browser isn't logged in - check the console, BankID login may be needed.");

  const cdp = await context.newCDPSession(page);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { ...ONSCREEN_BOUNDS, windowState: "normal" } });
  await page.bringToFront();
  await page.reload(); // also doubles as a fresh session-extend right when it matters most
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag} - listening for /openbrowser.`);
  ensureBrowserReady().catch((err) => console.error("Startup browser launch failed:", err.message));
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "openbrowser") return;
  if (interaction.guildId !== guildId) return;

  await interaction.reply({ content: "Opening the browser now...", ephemeral: true });
  try {
    await bringOnScreen();
    await interaction.followUp({ content: "Done - check your screen.", ephemeral: true });
  } catch (err) {
    await interaction.followUp({ content: `Failed to open: ${err.message}`, ephemeral: true });
  }
});

client.login(token);
