import { loadConfig } from "./config.js";
import { fetchOccasionsForCity, extractOccasions, matchesTransmission, SessionExpiredError } from "./trafikverket.js";
import { notifyDiscord, notifyDiscordError, notifyDiscordHeartbeat } from "./discord.js";
import { loadPreviousSnapshot, saveSnapshot, occasionKey } from "./state.js";
import { cookieExpiryWarning } from "./cookie.js";

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

  // Heartbeat lines are grouped per destination webhook - cities with their
  // own dedicated webhookUrl get their own heartbeat message, separate from
  // the default one covering cities that use the main/split webhooks.
  const defaultHeartbeatWebhook = isRealUrl(cfg.discord.afterDateWebhookUrl)
    ? cfg.discord.afterDateWebhookUrl
    : cfg.discord.webhookUrl;
  const heartbeatGroups = new Map(); // webhookUrl -> citySummary[]

  function addSummary(webhookUrl, summary) {
    if (!heartbeatGroups.has(webhookUrl)) heartbeatGroups.set(webhookUrl, []);
    heartbeatGroups.get(webhookUrl).push(summary);
  }

  for (const city of cfg.cities) {
    // A city can have its own dedicated webhookUrl (routes all of that
    // city's notifications - alerts and heartbeat - to its own channel,
    // bypassing the main/split-by-date logic entirely). Falls back to the
    // shared main webhook when the city has none of its own.
    const cityWebhook = isRealUrl(city.webhookUrl) ? city.webhookUrl : null;
    const errorWebhook = cityWebhook || cfg.discord.webhookUrl;
    const heartbeatKey = cityWebhook || defaultHeartbeatWebhook;

    try {
      // Full check of everything currently available for this city, every run.
      const { raw } = await fetchOccasionsForCity(cfg, payloadTemplate, city);

      if (DEBUG) {
        console.log(`\n--- RAW response for ${city.name} ---`);
        console.log(JSON.stringify(raw, null, 2));
      }

      const occasions = extractOccasions(raw)
        .filter((o) => matchesTransmission(o, cfg.transmission))
        .filter((o) => inWindow(o, cfg.search));

      occasions.forEach((o) => currentSnapshot.add(occasionKey(city.name, o)));

      const newOnes = occasions.filter((o) => !previous.has(occasionKey(city.name, o)));

      // isFirstRun (state.json missing entirely) covers a fresh install, but
      // a city added later to an already-existing state.json needs the same
      // treatment - otherwise every slot it currently has floods out as
      // "new" the moment it's added, since it has no prior history at all.
      const cityIsFirstRun = isFirstRun || ![...previous].some((k) => k.startsWith(`${city.name}|`));

      addSummary(heartbeatKey, {
        cityName: city.name,
        availableCount: occasions.length,
        newCount: cityIsFirstRun && !notifyOnFirstRun ? 0 : newOnes.length,
      });

      if (cityIsFirstRun && !notifyOnFirstRun) {
        // Seed the snapshot silently so the first real run doesn't dump
        // every currently-open slot at once. Set notifyOnFirstRun:true in
        // config.json if you'd rather see everything that's open right now.
        console.log(
          `[${city.name}] first run - seeding ${occasions.length} existing slot(s) without notifying.`
        );
      } else if (newOnes.length > 0) {
        console.log(`[${city.name}] ${newOnes.length} new slot(s) found (of ${occasions.length} available now).`);

        if (cityWebhook) {
          // Dedicated city webhook - no date-based splitting, everything
          // for this city goes to its own channel.
          await notifyDiscord(cityWebhook, {
            cityName: city.name,
            occasions: newOnes,
            transmission: cfg.transmission,
          });
        } else {
          const splitDate = cfg.discord.splitDate;
          const afterWebhook = cfg.discord.afterDateWebhookUrl;
          // Route slots after splitDate to a separate (e.g. muted) channel,
          // instead of dropping them - only meaningful when both are set.
          const useSplit = splitDate && isRealUrl(afterWebhook);
          const mainOnes = useSplit ? newOnes.filter((o) => !o.date || o.date <= splitDate) : newOnes;
          const laterOnes = useSplit ? newOnes.filter((o) => o.date && o.date > splitDate) : [];

          if (mainOnes.length > 0) {
            await notifyDiscord(cfg.discord.webhookUrl, {
              cityName: city.name,
              occasions: mainOnes,
              transmission: cfg.transmission,
            });
          }
          if (laterOnes.length > 0) {
            await notifyDiscord(afterWebhook, {
              cityName: city.name,
              occasions: laterOnes,
              transmission: cfg.transmission,
            });
          }
        }
      } else {
        console.log(`[${city.name}] no new slots (${occasions.length} available now, all already notified).`);
      }
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        sessionExpired = true;
        console.error(`[${city.name}] ${err.message}`);
        addSummary(heartbeatKey, { cityName: city.name, error: "session cookie expired" });
        // Don't let a failed check wipe out the snapshot for this city -
        // carry forward whatever we knew about it last time.
        for (const key of previous) {
          if (key.startsWith(`${city.name}|`)) currentSnapshot.add(key);
        }
      } else {
        console.error(`[${city.name}] error: ${err.message}`);
        await notifyDiscordError(errorWebhook, `${city.name}: ${err.message}`);
        addSummary(heartbeatKey, { cityName: city.name, error: err.message });
        for (const key of previous) {
          if (key.startsWith(`${city.name}|`)) currentSnapshot.add(key);
        }
      }
    }
  }

  saveSnapshot(currentSnapshot);

  // The shared session cookie affects every city equally, so every
  // heartbeat group gets the same expiry warning.
  const cookieWarning = cookieExpiryWarning(cfg.cookie);
  for (const [webhookUrl, summaries] of heartbeatGroups) {
    await notifyDiscordHeartbeat(webhookUrl, summaries, { cookieWarning });
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
