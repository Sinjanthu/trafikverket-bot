import { loadConfig } from "./config.js";
import { fetchOccasionsForCity, extractOccasions, matchesTransmission, SessionExpiredError } from "./trafikverket.js";
import { notifyDiscord, notifyDiscordError, notifyDiscordCookieWarning, notifyDiscordPeriodicSummary, isUrgent } from "./discord.js";
import { loadPreviousSnapshot, saveSnapshot, occasionKey } from "./state.js";
import { cookieExpiryWarning } from "./cookie.js";
import { isDue, markDone } from "./throttle.js";
import { stockholmTimeLabel } from "./time.js";

const TEORIPROV_SUMMARY_KEY = "teoriprov-periodic-summary";
const TEORIPROV_SUMMARY_INTERVAL_MS = 5 * 60 * 1000;

const DEBUG = process.env.DEBUG === "1";

function inWindow(occasion, search) {
  if (!occasion.date) return true;
  if (search?.earliestDate && occasion.date < search.earliestDate) return false;
  if (search?.latestDate && occasion.date > search.latestDate) return false;
  return true;
}

function isRealUrl(url) {
  return typeof url === "string" && url.length > 0 && !url.startsWith("PASTE_");
}

async function run() {
  const { cfg, payloadTemplate } = loadConfig();
  const { previous, isFirstRun } = loadPreviousSnapshot();
  const notifyOnFirstRun = cfg.notifyOnFirstRun === true; // default: false
  let sessionExpired = false;

  const currentSnapshot = new Set(); // rebuilt fresh every run from ALL currently available slots
  const teoriprovBlocks = []; // collected during the loop below, posted as one throttled periodic summary after

  // Heartbeat lines are grouped per destination webhook - cities with their
  // own dedicated webhookUrl (e.g. the Kunskapsprov entries) get their own
  // heartbeat message there; everything else falls back to the main webhook.
  const heartbeatGroups = new Map(); // webhookUrl -> { examLabel, summaries[] }

  function addSummary(webhookUrl, examLabel, summary) {
    if (!heartbeatGroups.has(webhookUrl)) heartbeatGroups.set(webhookUrl, { examLabel, summaries: [] });
    heartbeatGroups.get(webhookUrl).summaries.push(summary);
  }

  for (const city of cfg.cities) {
    // A city can have its own dedicated webhookUrl (e.g. the Kunskapsprov
    // entries, routed to the theory-test channel) - everything for that
    // city (heartbeat, alerts, errors) goes there. Falls back to the main
    // webhook (the Körprov channel) when the city has none of its own.
    const cityWebhook = isRealUrl(city.webhookUrl) ? city.webhookUrl : null;
    const targetWebhook = cityWebhook || cfg.discord.webhookUrl;
    const examLabel = city.examinationTypeId === 3 ? "Kunskapsprov" : "Körprov";
    // city.name stays the unique tracking key (avoids state.json collisions
    // between e.g. "Upplands Väsby" Körprov and Kunskapsprov entries sharing
    // the same city) - displayName is just what shows up in Discord.
    const displayName = city.displayName || city.name;

    try {
      // Full check of everything currently available for this city, every run.
      const { raw } = await fetchOccasionsForCity(cfg, payloadTemplate, city);

      if (DEBUG) {
        console.log(`\n--- RAW response for ${city.name} ---`);
        console.log(JSON.stringify(raw, null, 2));
      }

      const occasions = extractOccasions(raw)
        // The API mixes in results from payload.json's nearbyLocationIds
        // alongside the requested city - without this filter, a city's
        // count (and worse, its "new slot" alerts) can silently include
        // slots that only actually exist at a different, nearby location.
        .filter((o) => String(o._source?.locationId) === String(city.locationId))
        .filter((o) => matchesTransmission(o, cfg.transmission))
        .filter((o) => inWindow(o, cfg.search))
        // Per-city date window (in addition to the global one above) - e.g.
        // the "other cities" group only cares about slots up to a cutoff,
        // with no second channel to route later ones to like Upplands Väsby
        // has, so they're excluded entirely rather than split.
        .filter((o) => inWindow(o, city));

      occasions.forEach((o) => currentSnapshot.add(occasionKey(city.name, o)));

      const newOnes = occasions.filter((o) => !previous.has(occasionKey(city.name, o)));

      // isFirstRun (state.json missing entirely) covers a fresh install, but
      // a city added later to an already-existing state.json needs the same
      // treatment - otherwise every slot it currently has floods out as
      // "new" the moment it's added, since it has no prior history at all.
      const cityIsFirstRun = isFirstRun || ![...previous].some((k) => k.startsWith(`${city.name}|`));

      // Soonest 2 available slots, shown in the heartbeat as a quick preview
      // without having to open the site.
      const preview = [...occasions]
        .sort((a, b) => `${a.date || ""} ${a.time || ""}`.localeCompare(`${b.date || ""} ${b.time || ""}`))
        .slice(0, 2)
        .map((o) => `${o.date || "?"} ${o.time || "?"}`);

      addSummary(targetWebhook, examLabel, {
        cityName: displayName,
        availableCount: occasions.length,
        newCount: cityIsFirstRun && !notifyOnFirstRun ? 0 : newOnes.length,
        preview,
      });

      if (city.examinationTypeId === 3) {
        const first5 = [...occasions]
          .sort((a, b) => `${a.date || ""} ${a.time || ""}`.localeCompare(`${b.date || ""} ${b.time || ""}`))
          .slice(0, 5)
          .map((o) => `${o.date || "?"} ${o.time || "?"}`);
        teoriprovBlocks.push({
          cityName: displayName,
          availableCount: occasions.length,
          first5,
          hasUrgent: occasions.some(isUrgent),
        });
      }

      if (cityIsFirstRun && !notifyOnFirstRun) {
        // Seed the snapshot silently so the first real run doesn't dump
        // every currently-open slot at once. Set notifyOnFirstRun:true in
        // config.json if you'd rather see everything that's open right now.
        console.log(
          `[${city.name}] first run - seeding ${occasions.length} existing slot(s) without notifying.`
        );
      } else if (newOnes.length > 0) {
        console.log(`[${city.name}] ${newOnes.length} new slot(s) found (of ${occasions.length} available now).`);

        // Exam type decides the channel now, not date - Körprov cities go to
        // the main webhook, Kunskapsprov cities to their own (via cityWebhook).
        await notifyDiscord(targetWebhook, {
          cityName: displayName,
          occasions: newOnes,
          transmission: cfg.transmission,
          examLabel,
        });
      } else {
        console.log(`[${city.name}] no new slots (${occasions.length} available now, all already notified).`);
      }
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        sessionExpired = true;
        console.error(`[${city.name}] ${err.message}`);
        addSummary(targetWebhook, examLabel, { cityName: displayName, error: "session cookie expired" });
        // Don't let a failed check wipe out the snapshot for this city -
        // carry forward whatever we knew about it last time.
        for (const key of previous) {
          if (key.startsWith(`${city.name}|`)) currentSnapshot.add(key);
        }
      } else {
        console.error(`[${city.name}] error: ${err.message}`);
        await notifyDiscordError(targetWebhook, `${city.name}: ${err.message}`);
        addSummary(targetWebhook, examLabel, { cityName: displayName, error: err.message });
        for (const key of previous) {
          if (key.startsWith(`${city.name}|`)) currentSnapshot.add(key);
        }
      }
    }
  }

  saveSnapshot(currentSnapshot);

  // Periodic "here's what's open" digest for the Teoriprov channel - fires
  // at most every 5 min regardless of how often the bot itself runs, and
  // deliberately never pings @everyone (that's reserved for genuinely new,
  // soon slots via the alert path above) so it can't spam the channel.
  if (teoriprovBlocks.length > 0 && isDue(TEORIPROV_SUMMARY_KEY, TEORIPROV_SUMMARY_INTERVAL_MS)) {
    await notifyDiscordPeriodicSummary(cfg.discord.afterDateWebhookUrl, {
      title: `📘 Kunskapsprov (teoriprov) availability — ${stockholmTimeLabel()} Stockholm time`,
      cityBlocks: teoriprovBlocks,
      urgent: teoriprovBlocks.some((b) => b.hasUrgent),
    });
    markDone(TEORIPROV_SUMMARY_KEY);
  }

  // No more routine "Checked..." status message every run - only genuinely
  // new slots post (via notifyDiscord above). The cookie-expiry warning is
  // the one thing still worth surfacing on its own, but only while it's
  // actually close to expiring, not on every check.
  const cookieWarning = cookieExpiryWarning(cfg.cookie);
  if (cookieWarning) {
    for (const [webhookUrl] of heartbeatGroups) {
      await notifyDiscordCookieWarning(webhookUrl, cookieWarning);
    }
  }

  if (sessionExpired) {
    await notifyDiscordError(
      cfg.discord.webhookUrl,
      "Your Trafikverket session cookie has expired. Log in again and update config.json (see README's 'Refreshing your session')."
    );
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
