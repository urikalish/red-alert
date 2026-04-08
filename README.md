# red-alert

A Node.js Telegram bot that monitors the Israeli Home Front Command (Pikud Ha-Oref) rocket alert feed and forwards matching alerts to configured Telegram channels, filtered by location and time schedule.

## How It Works

1. On startup, the bot fetches the current alerts history to pre-populate its deduplication cache — **without posting anything**. This prevents spamming old alerts that were already in the feed before the bot started.
2. It then polls the Pikud Ha-Oref alert history API on a configurable interval.
3. Each new alert (not seen before) is checked against every recipient's schedule in `notify-reqs.json`.
4. If a new alert's location matches a recipient's active schedule window, a Telegram message is sent to that recipient's channel.

### Alert Source

```
https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json
```

Fetch timeout is hardcoded to **10 seconds** (`FETCH_TIMEOUT_MS = 10000`).

### Deduplication

Alerts are deduplicated using a `BoundedSet` (capped at `ALERTS_CACHE_SIZE = 10000` entries). The key for each alert is:

```
alertDate|data|category
```

When the cap is reached, the oldest entry is evicted. The cache is **in-memory only** — it resets on every process restart.

### Alert Category Mapping

| Category | Display text      |
|----------|-------------------|
| `14`     | `התרעה מקדימה`   |
| other    | `alert.title`     |

### Telegram Message Format

Grouped by event type, locations sorted alphabetically (Hebrew locale):

```
<event> - <location1>, <location2>, ...
```

Multiple event types are joined with a double newline (`\n\n`) in a single message per recipient.

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and fill in values. Both `.env` and real environment variables are supported (environment variables take precedence).

| Variable                   | Description                                      |
|----------------------------|--------------------------------------------------|
| `BOT_TOKEN`                | Telegram bot token (from BotFather)              |
| `CHECK_ALERTS_INTERVAL_MS` | Polling interval in milliseconds (e.g. `10000`)  |

`.env` is git-ignored. Never commit it.

### Notification Requirements — `notify-reqs.json`

Defines who gets notified and when. Not git-ignored — commit changes to it.

Top-level array of recipient objects:

```json
[
  {
    "id": "unique-label",
    "telegramChatId": "-100xxxxxxxxxx",
    "schedule": [
      {
        "days": ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        "hours": [0, 1, 2, ..., 23],
        "locations": ["רחובות", "תל אביב - מרכז העיר"]
      }
    ]
  }
]
```

| Field            | Type             | Description                                                               |
|------------------|------------------|---------------------------------------------------------------------------|
| `id`             | string           | Human-readable label, used only for identification                        |
| `telegramChatId` | string           | Telegram channel/group chat ID (negative for channels/groups)             |
| `schedule`       | array of blocks  | List of active schedule windows                                           |
| `days`           | string[]         | Three-letter day names: `Sun`, `Mon`, `Tue`, `Wed`, `Thu`, `Fri`, `Sat`  |
| `hours`          | number[]         | Hours (0–23, inclusive) in **Israel time** (`Asia/Jerusalem`)            |
| `locations`      | string[]         | Location names in Hebrew, exactly as they appear in the Oref API         |

A recipient is notified only when **all three** — day, hour, and location — match an active schedule block.

## Running

### Prerequisites

- Node.js (project uses ES modules — `"type": "module"`)
- Yarn (or npm)

### Install dependencies

```bash
yarn install
```

### Start

```bash
yarn start
# or: node --disable-warning=DEP0040 server.js
```

The `--disable-warning=DEP0040` flag suppresses the Node.js punycode deprecation warning emitted by a transitive dependency.

### Graceful Shutdown

The process handles `SIGINT` and `SIGTERM` and stops the Telegraf bot cleanly.

## Project Structure

```
red-alert/
├── server.js           # All application logic
├── notify-reqs.json    # Recipient and schedule configuration
├── package.json        # Project metadata and dependencies
├── .env                # Secret env vars — git-ignored, never commit
├── .env.example        # Template for .env
└── .gitignore
```

## Dependencies

| Package    | Version  | Purpose                        |
|------------|----------|--------------------------------|
| `telegraf` | 4.16.3   | Telegram Bot API client        |
| `dotenv`   | 17.3.1   | `.env` file loader             |

## Notes for Maintainers

- **Cache is not persisted.** Every restart re-fetches the alert history and skips posting (first run uses `checkAlerts(false)`), so no duplicate storm on restart — but also no memory of what was sent before the restart. Alerts that arrived while the bot was down will be silently skipped.
- **Commented-out `writeDataObjectToFile` function** exists in `server.js` — it was scaffolded for future file-write persistence but is currently unused.
- **Polling uses `setTimeout`, not `setInterval`.** The next poll is scheduled only after the current one completes, preventing overlapping fetches.
- **Time zone.** Schedule hours are evaluated in `Asia/Jerusalem` time. The day is also derived from that time zone.
- **Location strings must match exactly** the Hebrew strings returned by the Oref API — including spacing and punctuation.
- **No bot commands are registered.** The Telegraf bot only sends messages; it does not respond to incoming commands.
