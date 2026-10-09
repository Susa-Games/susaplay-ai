# Game-side webhooks — `SusaPlaySDK.Webhooks`

Sends the game's own events to SusaPlay, which forwards them to every webhook endpoint the
developer subscribed to `CUSTOM_WEBHOOK_EVENT`. Use it when the developer's server needs to know
what happens in the game. Endpoints are created in the Developer Portal; their signing secret is
shown there and must never pass through the chat.

```csharp
SusaPlaySDK.Webhooks.SendEvent("boss_defeated", 1, new Dictionary<string, object>
{
    { "bossId", "dragon" },
    { "seconds", 94.5 },
});

// To wait for the platform's answer:
var response = await SusaPlaySDK.Webhooks.SendEventAsync("boss_defeated", 1);
if (!response.Success) Debug.LogWarning(response.Error);
```

- `SendEvent(eventName, value = null, parameters = null)` returns at once. `SendEventAsync`
  returns an `HttpResponse` (`Success`, `Data`, `Error`, `StatusCode`). An empty name is not sent.
- Values can be strings, numbers, booleans, lists and dictionaries.

## Reserved names

| Event | Effect | Without it |
| --- | --- | --- |
| `level_up` | Reports the player's level: a non-negative integer as the value or as `level` in the parameters | `400 INVALID_ARGUMENT` |
| `achievement_unlocked` | Unlocks the one-shot achievement named by the `achievementId` parameter, then forwards the event | `400 INVALID_ARGUMENT`; an unregistered ID gets `404 NOT_FOUND` |

```csharp
SusaPlaySDK.Webhooks.SendEvent("level_up", 7);
SusaPlaySDK.Webhooks.SendEvent("achievement_unlocked", null, new Dictionary<string, object>
{
    { "achievementId", "first_win" },
});
```

`Analytics.LogB2BEvent` is obsolete; use `Webhooks.SendEvent`.
