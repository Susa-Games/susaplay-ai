---
name: susaplay-analytics
description: Instrument a SusaPlay Unity WebGL game with analytics events and read its player activity — logging events, parameters, flushing, the reserved level_up event, the SDK version needed for reporting, and what the dashboards show. Use when the user adds analytics to a SusaPlay game or asks about its players, DAU, MAU or retention.
---

# Analytics on SusaPlay

## Sessions are automatic

`SusaPlaySDK.Initialize()` queues a `session_start` event (SDK **1.3.0** or later). Daily and
monthly active players and retention are counted from it. A game built against an older SDK sends
nothing unless it logs events itself — rebuild against a current SDK to appear in the reports.

There is no session-end event: `OnApplicationQuit` is not reliable in a browser, so session length
comes from event timestamps on the server.

## Logging events

```csharp
SusaPlaySDK.Analytics.LogEvent("tutorial_complete");

// Parameters are a JSON object, passed as a string
SusaPlaySDK.Analytics.LogEvent("level_start", "{\"levelId\":\"world_2_level_3\"}");
```

- `LogEvent(name, parameters = "{}")` is synchronous and only queues the event — safe in
  gameplay code. Do not await anything in hot paths.
- Name events in `snake_case`, such as `level_complete`. An event without a name is dropped.
- Never put personal data (email, real name, phone) in names or parameters.
- **`level_up` is reserved**: it reports the player's level and needs a non-negative integer
  `level` parameter — `"{\"level\":7}"`. Without one the event is dropped and the rest of the
  batch is kept.
- To unlock an achievement, use `SusaPlaySDK.Achievements` or the webhook event
  `achievement_unlocked` — not an analytics event.

## Recommended events

SusaPlay asks every game to send these events where the game has the moment they describe. They
cover what only the game knows; sessions, purchases, achievements, saves and `level_up` are
already recorded by the platform, so do not log those again.

| Event | Parameters | Send when |
| --- | --- | --- |
| `level_start` | `levelId` | A level, stage or round begins |
| `level_complete` | `levelId`, `durationSeconds`; `score` if the game has one | The player finishes it |
| `level_fail` | `levelId`, `durationSeconds`; `reason` if known, such as `"timeout"` | The player fails or quits it |
| `tutorial_begin` | — | The tutorial starts |
| `tutorial_complete` | — | The tutorial ends |
| `currency_earn` | `currency`, `amount`, `source` | The player earns the game's **own** currency (not the SusaPlay wallet) |
| `currency_spend` | `currency`, `amount`, `itemId` | The player spends the game's own currency |
| `store_open` | `placement`, such as `"main_menu"` | The game's store or shop screen opens |

```csharp
SusaPlaySDK.Analytics.LogEvent("level_complete",
    "{\"levelId\":\"world_1_3\",\"durationSeconds\":74,\"score\":1200}");
```

- Use exactly these names and parameter names, so reports work the same across games. Add any
  other events the game needs alongside them.
- `levelId` is a stable string the game already uses for the level — not a display name.
- Skip an event the game has no moment for: a game without levels sends no `level_*` events.
- Today these events appear in the raw event export, not yet in the Developer Portal's charts.

## Flushing

Events are sent in batches: by default on initialization, every five minutes, and when the game
is paused or quits. Force a send at a moment that matters, such as the end of a tutorial:

```csharp
await SusaPlaySDK.Analytics.Flush();
```

The interval and the lifecycle flushes are settings on the `PlatformConfig` asset; the minimum
interval is 10 seconds.

Purchases are recorded on the server when the payment completes. The game does not log purchase
events for revenue.

## Reading activity

- The Developer Portal → the game → **Analytics**.
- With the SusaPlay MCP tools: `get_analytics` returns daily and 30-day active players and D1, D7
  and D30 retention for the last 1–90 days. It needs the `analytics:read` permission.
- **Revenue is deliberately not part of `get_analytics`.** The analytics pipeline's revenue figure
  is not SusaPlay's record of money. Do not present an analytics number as revenue.
- An empty series is normal for a game with no players in the period, or one built against an SDK
  older than 1.3.0.
