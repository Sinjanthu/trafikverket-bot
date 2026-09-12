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

function watchForManualClose(ctx) {
  // If the user closes the browser window themselves (e.g. after booking),
  // this connection goes stale - without detecting that, the next
  // /openbrowser would just fail instead of relaunching. Cookies/login
  // persist to disk regardless (a normal browser close doesn't log you
  // out), so relaunching just reopens the same still-logged-in profile.
  // Only ever attached to the ONE context we're actually keeping (see
  // ensureBrowserReady) - never to a short-lived probe launch we might
  // discard, so there's no ambiguity about whether a given close event is
  // "ours" or a genuine manual close.
  ctx.on("close", () => {
    console.log("Manual-open browser was closed - will relaunch on next /openbrowser.");
    context = null;
    page = null;
  });
}

let inFlightLaunch = null;

// Concurrency guard: without this, two overlapping triggers (e.g. clicking
// /openbrowser again while the first call is still waiting on BankID) would
// both call launchPersistentContext on the same profile dir at once, which
// Playwright rejects outright ("Opening in existing browser session") -
// that's exactly what crashed the bot once already (see the interaction
// handler's error-length fix above for the other half of that incident).
async function ensureBrowserReady() {
  if (context) return;
  if (inFlightLaunch) return inFlightLaunch;

  inFlightLaunch = ensureBrowserReadyInner().finally(() => {
    inFlightLaunch = null;
  });
  return inFlightLaunch;
}

async function ensureBrowserReadyInner() {
  // Local variables until we know which context we're actually keeping -
  // the module-level context/page (and the close-watcher) only get set
  // once, on whichever one survives below.
  let ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, args: OFFSCREEN_ARGS });
  let pg = ctx.pages()[0] || (await ctx.newPage());
  await pg.goto(BOOKING_URL);

  let cookies = await ctx.cookies();
  if (!isLoggedIn(cookies)) {
    console.log("Not logged in on the dedicated manual-open profile - relaunching visibly for BankID login...");
    await ctx.close();
    // Chromium persists window bounds per-profile - without explicitly
    // forcing an on-screen position here, it can silently restore the
    // off-screen position from the first launch above, leaving the window
    // impossible to find even though it's technically "visible".
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      args: [`--window-position=${ONSCREEN_BOUNDS.left},${ONSCREEN_BOUNDS.top}`, `--window-size=${ONSCREEN_BOUNDS.width},${ONSCREEN_BOUNDS.height}`],
    });
    pg = ctx.pages()[0] || (await ctx.newPage());
    await pg.goto(BOOKING_URL);

    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      cookies = await ctx.cookies();
      if (isLoggedIn(cookies)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!isLoggedIn(await ctx.cookies())) {
      console.error("Timed out waiting for BankID login on startup. /openbrowser won't work until this succeeds.");
      await ctx.close();
      return;
    }
    // Park it off-screen again now that we're logged in, ready for next time.
    const cdp = await ctx.newCDPSession(pg);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: OFFSCREEN_LEFT, top: 0 } }).catch(() => {});
  }

  context = ctx;
  page = pg;
  watchForManualClose(context);

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
  const isOpenCommand = interaction.isChatInputCommand() && interaction.commandName === "openbrowser";
  // "Book now" button attached to new-slot alert messages (see
  // src/discord.js) - same action as /openbrowser, just one click away
  // from the alert itself instead of switching over to type a command.
  const isBookButton = interaction.isButton() && interaction.customId === "book_now";
  if (!isOpenCommand && !isBookButton) return;
  if (interaction.guildId !== guildId) return;

  try {
    await interaction.reply({ content: "Opening the browser now...", ephemeral: true });
  } catch (err) {
    console.error("Failed to send initial reply:", err.message);
    return;
  }

  try {
    await bringOnScreen();
    await interaction.followUp({ content: "Done - check your screen.", ephemeral: true });
  } catch (err) {
    // Playwright errors can include a huge multi-line call log (well over
    // Discord's 2000-char message limit) - sending that unmodified once
    // crashed the whole process with an uncaught DiscordAPIError. Take just
    // the first line and wrap the whole send in its own try/catch too.
    const firstLine = String(err.message).split("\n")[0].slice(0, 1500);
    try {
      await interaction.followUp({ content: `Failed to open: ${firstLine}`, ephemeral: true });
    } catch (sendErr) {
      console.error("Failed to send error followUp:", sendErr.message);
    }
  }
});

// Last-resort safety net - an uncaught error here previously took down the
// whole listener (e.g. a Discord API error thrown outside the handler's own
// try/catch). Log and keep running instead.
client.on("error", (err) => console.error("Discord client error:", err.message));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

client.login(token);
