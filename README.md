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
  { "name": "Upplands Väsby", "locationId": "1000337" },
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
"discord": { "webhookUrl": "" }
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

## Refreshing your session

When you start seeing `⚠️ session cookie has probably expired` in Discord:

1. Go back to <https://fp.trafikverket.se/Boka/>, log in again.
2. Repeat step 2 above (capture a fresh `Cookie` header).
3. Paste it into `config.json` → `"cookie"`. Nothing else needs to change.

## How it avoids spamming you

Every slot the bot notifies about is fingerprinted (city + date + time) and
saved to `state.json`. You'll only be pinged once per slot — if it
disappears (someone else books it) and a *different* one opens later,
that's a new notification.

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
