import { loadConfig } from "./config.js";

// Just re-runs index.js's logic on a timer. Kept separate from index.js so
// `npm start` (single pass, good for cron/GitHub Actions) stays simple.
const { cfg } = loadConfig();
const intervalMs = Math.max(1, cfg.pollIntervalMinutes || 5) * 60 * 1000;

console.log(`Polling every ${cfg.pollIntervalMinutes || 5} minute(s). Ctrl+C to stop.`);

async function tick() {
  const { execFile } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");

  execFile(process.execPath, [indexPath], (err, stdout, stderr) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  });
}

tick();
setInterval(tick, intervalMs);
