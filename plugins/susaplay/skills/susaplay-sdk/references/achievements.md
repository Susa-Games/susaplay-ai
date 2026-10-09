# Achievements — `SusaPlaySDK.Achievements`

Achievements are defined in the Developer Portal (ID, name, description, icon, type, points). The
game sends only the ID. **Register an achievement in the portal before the game uses it**: an
unknown ID is refused with `404 NOT_FOUND` and nothing is recorded.

| Type | Call | Unlocks when |
| --- | --- | --- |
| One-shot | `Unlock(id)` | `Unlock` is called |
| Incremental | `Increment(id, amount)` | The server's counter reaches the target set in the portal |

```csharp
var unlocked = await SusaPlaySDK.Achievements.Unlock("first_win");
var progress = await SusaPlaySDK.Achievements.Increment("collector", 1);
var all = await SusaPlaySDK.Achievements.List();
```

- `Unlock` on an incremental achievement, or `Increment` on a one-shot one, fails with
  `400 INVALID_ARGUMENT`. `amount` must be greater than zero.
- Unlocking twice is safe: the second awards nothing.
- The server keeps the counter; the game never tracks the threshold.
- All three return an `HttpResponse`: `Success`, `Data` (the response body as JSON text:
  `{"success": true, "data": {...}}`), `Error`, `StatusCode`.
  - `Unlock` data: `achievementId`, `unlockedAt`, `newlyUnlocked`, `points`, `progression`.
  - `Increment` data: `achievementId`, `currentValue`, `targetValue`, `justUnlocked`, `points`,
    `progression`.
  - `List` data: `achievements`, each with `achievementId`, `name`, `description`, `iconUrl`,
    `type`, `targetValue`, `currentValue`, `points`, `unlocked`, `unlockedAt`.
- The webhook event `achievement_unlocked` with an `achievementId` parameter also unlocks a
  one-shot achievement — see [webhooks.md](webhooks.md).
