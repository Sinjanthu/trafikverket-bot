# Trafikverket Körprov Bot (personal use)

Polls Trafikverket's booking system for **Körprov** slots at the cities you
choose, keeps only **automatic** (or manual, or any) transmission, and pings
a Discord webhook when a genuinely new slot shows up (it won't spam you
about the same slot every 5 minutes).

> **Important:** This uses Trafikverket's *internal* booking endpoint — the
> same one their own website calls — not a public/documented API. It
> requires you to be logged in (BankID), so the bot needs a copy of your
> browser's session cookie. That cookie will expire periodically (hours to a
> day or so) and you'll need to refresh it — see below. This is normal for
> every community tool of this kind; there's no way around the login
> requirement since test bookings are tied to your personnummer.

## Requirements

- [Node.js](https://nodejs.org/) 18+
- A Discord server where you can add a webhook (Server Settings → Integrations → Webhooks → New Webhook → copy URL)

## Setup

### 1. Copy the example files

```bash
cp config.example.json config.json
cp payload.example.json payload.json
```

### 2. Capture your real request from the browser

1. Go to <https://fp.trafikverket.se/Boka/> and log in.
2. Open DevTools (F12) → **Network** tab → filter by `Fetch/XHR`.
3. Search for a **Körprov** in any city (doesn't matter which — you'll swap
   the city per request).
4. Find the request that returns the list of times — look for something
   like `occasion-bundles` or similar in the Network tab.
5. Right-click it → **Copy → Copy as cURL**, or open the **Payload/Request**
   tab to see the JSON body and the **Headers** tab to see the full request
   URL and `Cookie` header.
6. From that:
   - Paste the **full request URL** into `config.json` → `"apiUrl"`.
   - Paste the **`Cookie` header value** into `config.json` → `"cookie"`.
   - Paste the **request body JSON** into `payload.json`, replacing the
     `_example_shape_only` placeholder entirely (just the real JSON object,
     no wrapper).

### 3. Find each city's `locationId`

In that same captured payload, whichever field holds the location (often
`locationId`) — search once in the browser UI for "Upplands Väsby", capture
the request again, and note the value that field has. Put that value into
`config.json` under `cities`.

To add more cities later, repeat this once per city and add another entry
to the `cities` array:

```json
"cities": [
  { "name": "Upplands Väsby", "locationId": "1234" },
  { "name": "Stockholm City", "locationId": "5678" }
]
```

### 4. Set your transmission filter

In `config.json`:

```json
"transmission": "automatic"
```

Options: `"automatic"`, `"manual"`, `"any"`.

> Note: the bot detects transmission by scanning the response for a
> field whose name suggests gearbox/transmission and whose value contains
> "Automat" or "Manuell". If your account/search is already scoped to
> automatic-only licences, you may see everything anyway — that's fine,
> it just means filtering has nothing left to do. Run with `DEBUG=1` (see
> below) if you want to confirm the filter is matching real data.

### 5. Add your Discord webhook

```json
"discord": { "webhookUrl": "https://discord.com/api/webhooks/..." }
```

## Running it

**Single check:**

```bash
npm install
npm start
```

**Debug mode** (dumps the raw API response so you can sanity-check field
names if notifications aren't matching what the website shows you):

```bash
npm run debug
```

**Keep polling continuously** (every `pollIntervalMinutes` from
config.json):

```bash
npm run watch
```

**Or use cron** instead of `watch` (every 5 minutes, 05:00–19:00):

```
*/5 5-19 * * * cd /path/to/trafikverket-bot && node src/index.js >> bot.log 2>&1
```

## Fixing a mismatched payload shape

If your captured `payload.json` nests the location under a sub-object
(Trafikverket's does, e.g. `occasionBundleQuery.locationId`), set
`locationIdField` in `config.json` to that **dot path**, not just the bare
key name:

```json
"locationIdField": "occasionBundleQuery.locationId"
```

Same idea for the search start date — Trafikverket's payload includes a
`startDate` that should be "now", not whatever date happened to be current
when you captured it in DevTools. Point `startDateField` at it and the bot
refreshes it to the current time on every request automatically:

```json
"startDateField": "occasionBundleQuery.startDate"
```

Both support arbitrary nesting depth (`"a.b.c"`). Leave `startDateField` as
`null` if your payload doesn't have anything like this.

## Running via GitHub Actions (no computer needed)

This lets the bot run in the cloud on a schedule, so you don't need to keep
anything on at home. It's already set up at
`.github/workflows/poll.yml` — you just need to push the project and add
your secrets.

1. **Push this project to a new GitHub repo.** `config.json`, `payload.json`,
   and `state.json` are already git-ignored, so your cookie/personnummer/
   webhook never get committed:
   ```bash
   git init
   git add .
   git commit -m "trafikverket bot"
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

2. **Add two repo secrets** (Settings → Secrets and variables → Actions →
   New repository secret):
   - `CONFIG_JSON` — paste your entire real `config.json` file content
     (with your real cookie, webhook URL, cities, etc.)
   - `PAYLOAD_JSON` — paste your entire real `payload.json` file content

3. The workflow only listens for `workflow_dispatch` (the manual "Run
   workflow" button) — GitHub's own `schedule:` trigger used to be here, but
   is documented as best-effort and was observed actually skipping runs for
   2-4.5 hours at a stretch under load, which defeats the point of a bot
   meant to catch a slot within minutes of it opening. Instead, an external,
   actually-reliable timer calls the dispatch API for you:

   1. Create a fine-grained PAT scoped to just this repo's Actions:
      [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
      → repository access "Only select repositories" → `trafikverket-bot` →
      Permissions → Repository permissions → **Actions: Read and write**.
   2. Sign up free at [cron-job.org](https://cron-job.org) and create a cronjob:
      - URL: `https://api.github.com/repos/Sinjanthu/trafikverket-bot/actions/workflows/poll.yml/dispatches`
      - Method: `POST`
      - Headers: `Authorization: Bearer <token from step 1>`,
        `Accept: application/vnd.github+json`,
        `X-GitHub-Api-Version: 2022-11-28`
      - Body: `{"ref":"main"}`
      - Schedule: every 5 minutes
   3. Confirm it worked: `gh run list --repo Sinjanthu/trafikverket-bot`
      should show runs genuinely ~5 minutes apart, not hours.

4. **State persistence across runs** is handled via `actions/cache` in the
   workflow — it restores the previous `state.json` before running and saves
   the updated one after, so you still only get notified once per slot, same
   as running locally. The very first run behaves like any first run (seeds
   silently, see above).

### ⚠️ Free-tier minutes: use a public repo

GitHub gives **unlimited free Actions minutes on public repos**, but only
**2,000 minutes/month on private repos** (Free plan). A job every 5 minutes
adds up to roughly 8,000+ minutes/month, which blows past the private-repo
quota fast. Since none of your secrets ever appear in the code or commit
history — only in GitHub's encrypted Secrets store, injected at runtime —
making the repo **public** is safe and is what most people running this
kind of scheduled bot do. If you'd rather keep it private, either bump
`cron: "*/5 * * * *"` to something like `*/15 * * * *`, or self-host with
`pm2` instead (see above).

When you start seeing `⚠️ session cookie has probably expired` in Discord:

1. Go back to <https://fp.trafikverket.se/Boka/>, log in again.
2. Repeat step 2 above (capture a fresh `Cookie` header).
3. Paste it into `config.json` → `"cookie"`. Nothing else needs to change.

## How it avoids spamming you

Every slot the bot notifies about is fingerprinted (city + date + time) and
saved to `state.json`. You'll only be pinged once per slot — if it
disappears (someone else books it) and a *different* one opens later,
that's a new notification.

**First run is silent by design.** The very first time you run the bot,
`state.json` doesn't exist yet, so every currently-open slot would count as
"new" — for a popular city that can be 100+ slots at once, and would flood
your channel and hit Discord's rate limit. Instead, the first run quietly
records what's currently open and notifies about nothing. From the second
run onward, you're only notified about slots that genuinely just appeared.
If you'd rather see everything that's open right now on the very first run,
set `"notifyOnFirstRun": true` in `config.json`.

## Does it run all the time?

Only while the process is actually running — `npm run watch` (or cron)
polls forever, but if you close the terminal / your laptop sleeps, it stops.
To make it truly "always on" 24/7, pick one:

- **Leave a terminal running** with `npm run watch` — simplest, but stops
  if you close the terminal or shut down your machine.
- **`pm2`** (process manager that survives terminal close and restarts on
  crash/reboot):
  ```bash
  npm install -g pm2
  pm2 start src/watch.js --name trafikverket-bot
  pm2 save
  pm2 startup   # follow the printed instructions to survive a reboot
  ```
- **A small always-on server / Raspberry Pi** running `pm2` or a systemd
  service — the most "set and forget" option if your own computer isn't
  always on.
- **GitHub Actions on a cron schedule** — no machine needed at all, GitHub
  runs it for you every 5 minutes. See the commented-out workflow idea in
  this README's earlier draft, or ask and I'll write the exact
  `.github/workflows/*.yml` file for this repo.

## Files

```
config.json      # your settings: cities, transmission, webhook (git-ignored)
payload.json     # your captured request body (git-ignored, has your personnummer)
state.json       # tracks which slots you've already been notified about
src/
  index.js       # one poll-and-check pass
  trafikverket.js# sends the request, extracts occasions, filters by transmission
  discord.js     # webhook delivery
  config.js      # loads + validates config.json/payload.json
  state.js       # dedup tracking
  watch.js        # optional: loops index.js on an interval
```

## Disclaimer

This talks to an internal, undocumented Trafikverket endpoint that can
change or start rate-limiting/blocking without notice. It only *reads*
availability — it does not book anything for you. Poll at a reasonable
interval (5 min is plenty) and use at your own risk.
