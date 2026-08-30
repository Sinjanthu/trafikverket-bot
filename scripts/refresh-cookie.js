#!/usr/bin/env node
/**
 * Automates the tedious part of "Refreshing your session" from the README:
 * opens a real browser to Trafikverket's login, waits for you to complete
 * BankID on your phone, then reads the resulting cookies straight out of
 * the browser session and writes them into config.json.
 *
 * BankID's own approval step (the tap/biometric confirmation on your phone)
 * can't be automated - that's the whole point of it being 2FA. This script
 * only removes the manual DevTools copy-paste that used to come after it.
 *
 * Usage:
 *   node scripts/refresh-cookie.js            # update config.json only
 *   node scripts/refresh-cookie.js --push      # also push to the GitHub
 *                                               # Actions CONFIG_JSON secret
 *                                               # (requires `gh` authenticated)
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = path.join(ROOT, "config.json");
const LOGIN_URL = "https://fp.trafikverket.se/Boka/";
const POLL_MS = 2000;
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to complete BankID

const shouldPush = process.argv.includes("--push");

function buildCookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function main() {
  console.log(`Opening ${LOGIN_URL} - log in with BankID in the browser window that opens...`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(LOGIN_URL);

  const deadline = Date.now() + TIMEOUT_MS;
  let loggedIn = false;

  while (Date.now() < deadline) {
    const cookies = await context.cookies();
    // FpsExternalIdentity is set only once BankID login actually succeeds.
    if (cookies.some((c) => c.name === "FpsExternalIdentity")) {
      loggedIn = true;
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  if (!loggedIn) {
    await browser.close();
    console.error(`\nTimed out after ${TIMEOUT_MS / 60000} minutes waiting for BankID login. Nothing was changed.`);
    process.exitCode = 1;
    return;
  }

  console.log("Login detected - reading cookies...");
  const cookies = await context.cookies();
  const cookieHeader = buildCookieHeader(cookies);
  await browser.close();

  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  cfg.cookie = cookieHeader;
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`Updated cookie in ${CONFIG_PATH}`);

  if (shouldPush) {
    console.log("Pushing to CONFIG_JSON GitHub secret via gh...");
    try {
      execFileSync("gh", ["secret", "set", "CONFIG_JSON", "--repo", "Sinjanthu/trafikverket-bot"], {
        input: JSON.stringify(cfg, null, 2) + "\n",
        stdio: ["pipe", "inherit", "inherit"],
      });
      console.log("Secret updated.");
    } catch (err) {
      console.error(`Failed to push secret via gh: ${err.message}`);
      console.error("You can push it manually: gh secret set CONFIG_JSON --repo Sinjanthu/trafikverket-bot < config.json");
      process.exitCode = 1;
    }
  } else {
    console.log("Run with --push to also update the CONFIG_JSON GitHub secret.");
  }
}

main();
