import { loadConfig } from "./config.js";
import { fetchOccasionsForCity, extractOccasions, matchesTransmission, SessionExpiredError } from "./trafikverket.js";
import { notifyDiscord, notifyDiscordError } from "./discord.js";
import { loadSeen, saveSeen, occasionKey } from "./state.js";

const DEBUG = process.env.DEBUG === "1";

function inWindow(occasion, search) {
  if (!occasion.date) return true;
  if (search?.earliestDate && occasion.date < search.earliestDate) return false;
  if (search?.latestDate && occasion.date > search.latestDate) return false;
  return true;
}

async function run() {
  const { cfg, payloadTemplate } = loadConfig();
  const { seen, isFirstRun } = loadSeen();
  const notifyOnFirstRun = cfg.notifyOnFirstRun === true; // default: false
  let sessionExpired = false;

  for (const city of cfg.cities) {
    try {
      const { raw } = await fetchOccasionsForCity(cfg, payloadTemplate, city);

      if (DEBUG) {
        console.log(`\n--- RAW response for ${city.name} ---`);
        console.log(JSON.stringify(raw, null, 2));
      }

      const occasions = extractOccasions(raw)
        .filter((o) => matchesTransmission(o, cfg.transmission))
        .filter((o) => inWindow(o, cfg.search));

      const newOnes = occasions.filter((o) => !seen.has(occasionKey(city.name, o)));

      if (isFirstRun && !notifyOnFirstRun) {
        // Seed state silently so the first real run doesn't dump every
        // currently-open slot at once. Set notifyOnFirstRun:true in
        // config.json if you'd rather see everything that's open right now.
        console.log(
          `[${city.name}] first run - seeding ${newOnes.length} existing slot(s) without notifying.`
        );
        newOnes.forEach((o) => seen.add(occasionKey(city.name, o)));
      } else if (newOnes.length > 0) {
        console.log(`[${city.name}] ${newOnes.length} new slot(s) found.`);
        await notifyDiscord(cfg.discord.webhookUrl, {
          cityName: city.name,
          occasions: newOnes,
          transmission: cfg.transmission,
        });
        newOnes.forEach((o) => seen.add(occasionKey(city.name, o)));
      } else {
        console.log(`[${city.name}] no new slots (${occasions.length} total matching current filters).`);
      }
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        sessionExpired = true;
        console.error(`[${city.name}] ${err.message}`);
      } else {
        console.error(`[${city.name}] error: ${err.message}`);
        await notifyDiscordError(cfg.discord.webhookUrl, `${city.name}: ${err.message}`);
      }
    }
  }

  saveSeen(seen);

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
