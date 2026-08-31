#!/usr/bin/env node
/**
 * Automates refreshing the Trafikverket session cookie using a dedicated,
 * persistent browser profile (NOT your real Chrome - Chrome refuses remote
 * debugging on your default profile as an anti-cookie-theft protection, so
 * this uses its own separate profile folder instead: .playwright-profile/,
 * gitignored, lives only on this machine).
 *
 * First run: a real, visible browser window opens using that dedicated
 * profile and waits for you to log in with BankID.
 *
 * Every run after that: since the profile is persistent (saved to disk),
 * it's still logged in - the script launches the window positioned off
 * -screen (not headless - Trafikverket blocks real headless outright, see
 * below - just moved somewhere you won't see it) and reloads the
 * Trafikverket page (which is what actually extends the session, per
 * observed behavior), then reads the refreshed cookies. No BankID needed
 * again unless the underlying session has fully lapsed (rare - only if you
 * don't run this for a long while), in which case it detects that, closes
 * the off-screen window, and reopens a normal visible one for you to log
 * into, same as the first run.
 *
 * Usage:
 *   node scripts/refresh-cookie.js               # update config.json only
 *   node scripts/refresh-cookie.js --push         # also push to the GitHub
 *                                                  # Actions CONFIG_JSON secret
 *                                                  # (requires `gh` authenticated)
 *
 * For scheduled/unattended runs (e.g. Windows Task Scheduler), just use
 * --push without --headless: when already logged in (the normal case),
 * it needs zero clicks - the window opens, reloads, reads cookies, and
 * closes itself. --headless exists but currently just hangs - Trafikverket's
 * site seems to detect and block headless Chromium outright (page never
 * finishes loading), so don't use it for now.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// `gh` is often installed after the current shell/session started, so it
// may not be on PATH yet - fall back to its default Windows install path.
const GH_FALLBACK = "C:\\Program Files\\GitHub CLI\\gh.exe";
const GH_BIN = existsSync(GH_FALLBACK) ? GH_FALLBACK : "gh";
const CONFIG_PATH = path.join(ROOT, "config.json");
const PROFILE_DIR = path.join(ROOT, ".playwright-profile");
const LOGIN_URL = "https://fp.trafikverket.se/Boka/";
const POLL_MS = 2000;
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to complete BankID, if needed

const shouldPush = process.argv.includes("--push");
const headless = process.argv.includes("--headless");

function buildCookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function isLoggedIn(cookies) {
  return cookies.some((c) => c.name === "FpsExternalIdentity");
}

// Not headless (that's blocked outright) - just parked somewhere off the
// visible desktop so a real, normal browser window never actually shows up.
const OFFSCREEN_ARGS = ["--window-position=-3000,-3000"];

async function launchContext(offscreen) {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    args: offscreen ? OFFSCREEN_ARGS : [],
  });
}

async function main() {
  let context = await launchContext(true);
  let page = context.pages()[0] || (await context.newPage());

  await page.goto(LOGIN_URL);

  let cookies = await context.cookies();

  if (isLoggedIn(cookies)) {
    console.log("Already logged in (persistent profile) - reloading to refresh the session...");
    await page.reload();
    await page.waitForLoadState("networkidle").catch(() => {});
  } else if (headless) {
    await context.close();
    console.error(
      "Not logged in and running --headless, so I can't show you a BankID prompt. Run once without --headless to log in interactively, then scheduled --headless runs will keep reusing that login."
    );
    process.exitCode = 1;
    return;
  } else {
    console.log("Not logged in (or session fully lapsed) - reopening a visible window for BankID login...");
    await context.close();
    context = await launchContext(false);
    page = context.pages()[0] || (await context.newPage());
    await page.goto(LOGIN_URL);

    const deadline = Date.now() + TIMEOUT_MS;
    let loggedIn = false;
    while (Date.now() < deadline) {
      cookies = await context.cookies();
      if (isLoggedIn(cookies)) {
        loggedIn = true;
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (!loggedIn) {
      await context.close();
      console.error(`\nTimed out after ${TIMEOUT_MS / 60000} minutes waiting for BankID login. Nothing was changed.`);
      process.exitCode = 1;
      return;
    }
  }

  console.log("Reading cookies...");
  cookies = await context.cookies();
  const cookieHeader = buildCookieHeader(cookies);
  await context.close();

  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  cfg.cookie = cookieHeader;
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`Updated cookie in ${CONFIG_PATH}`);

  if (shouldPush) {
    console.log("Pushing to CONFIG_JSON GitHub secret via gh...");
    try {
      execFileSync(GH_BIN, ["secret", "set", "CONFIG_JSON", "--repo", "Sinjanthu/trafikverket-bot"], {
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
