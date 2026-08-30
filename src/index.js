import { loadConfig } from "./config.js";
import { fetchOccasionsForCity, extractOccasions, matchesTransmission, SessionExpiredError } from "./trafikverket.js";
import { notifyDiscord, notifyDiscordError, notifyDiscordHeartbeat } from "./discord.js";
import { loadPreviousSnapshot, saveSnapshot, occasionKey } from "./state.js";

const DEBUG = process.env.DEBUG === "1";

function inWindow(occasion, search) {
  if (!occasion.date) return true;
  if (search?.earliestDate && occasion.date < search.earliestDate) return false;
  if (search?.latestDate && occasion.date > search.latestDate) return false;
  return true;
}

async function run() {
  const { cfg, payloadTemplate } = loadConfig();
  const { previous, isFirstRun } = loadPreviousSnapshot();
  const notifyOnFirstRun = cfg.notifyOnFirstRun === true; // default: false
  let sessionExpired = false;

  const currentSnapshot = new Set(); // rebuilt fresh every run from ALL currently available slots
  const citySummaries = []; // for the every-run Discord heartbeat, regardless of whether anything new was found

  for (const city of cfg.cities) {
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

      citySummaries.push({
        cityName: city.name,
        availableCount: occasions.length,
        newCount: isFirstRun && !notifyOnFirstRun ? 0 : newOnes.length,
      });

      if (isFirstRun && !notifyOnFirstRun) {
        // Seed the snapshot silently so the first real run doesn't dump
        // every currently-open slot at once. Set notifyOnFirstRun:true in
        // config.json if you'd rather see everything that's open right now.
        console.log(
          `[${city.name}] first run - seeding ${occasions.length} existing slot(s) without notifying.`
        );
      } else if (newOnes.length > 0) {
        console.log(`[${city.name}] ${newOnes.length} new slot(s) found (of ${occasions.length} available now).`);
        await notifyDiscord(cfg.discord.webhookUrl, {
          cityName: city.name,
          occasions: newOnes,
          transmission: cfg.transmission,
        });
      } else {
        console.log(`[${city.name}] no new slots (${occasions.length} available now, all already notified).`);
      }
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        sessionExpired = true;
        console.error(`[${city.name}] ${err.message}`);
        citySummaries.push({ cityName: city.name, error: "session cookie expired" });
        // Don't let a failed check wipe out the snapshot for this city -
        // carry forward whatever we knew about it last time.
        for (const key of previous) {
          if (key.startsWith(`${city.name}|`)) currentSnapshot.add(key);
        }
      } else {
        console.error(`[${city.name}] error: ${err.message}`);
        await notifyDiscordError(cfg.discord.webhookUrl, `${city.name}: ${err.message}`);
        citySummaries.push({ cityName: city.name, error: err.message });
        for (const key of previous) {
          if (key.startsWith(`${city.name}|`)) currentSnapshot.add(key);
        }
      }
    }
  }

  saveSnapshot(currentSnapshot);

  await notifyDiscordHeartbeat(cfg.discord.webhookUrl, citySummaries);

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