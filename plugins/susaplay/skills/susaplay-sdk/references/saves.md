# Cloud saves — `SusaPlaySDK.CloudSave`

Saves are kept per player, per game, in named slots.

```csharp
// Write: data must be JSON text — the SDK puts it into the request as a JSON value.
var saved = await SusaPlaySDK.CloudSave.Save("main", JsonUtility.ToJson(state));
if (saved.Success)
{
    Debug.Log($"Saved version {saved.Version}");
}

// Read
var loaded = await SusaPlaySDK.CloudSave.Load("main");
if (loaded.Success && !string.IsNullOrEmpty(loaded.Data))
{
    state = JsonUtility.FromJson<GameState>(loaded.Data);
}
else if (loaded.Success)
{
    // Empty slot: a new player. Start a fresh game.
}
```

| Type | Fields |
| --- | --- |
| `SaveResult` | `Success`, `Version`, `Error` |
| `LoadResult` | `Success`, `Data` (the JSON text you saved), `Version`, `Error` |

- **`Data` must be valid JSON** — an object from `JsonUtility.ToJson` is the usual choice. A plain,
  unquoted string makes the request invalid. Empty data is refused.
- **An empty slot is a success**: `Success` is true, `Data` is empty and `Version` is 0. Check
  `Data`, not `Success`, to tell a new player from a returning one.
- You never pass a version. The SDK keeps the slot's last version itself. On a
  `409` conflict — another tab or device saved first — it re-reads the slot and retries, so the
  last write wins.
- Writes to one slot are serialized; calls made while a write is in flight are merged into the
  next write with the newest data. Writes to a slot are at least 2 seconds apart.
- A slot holds at most 500,000 characters.
- Separate data that changes at different rates into different slots (`"progress"`,
  `"settings"`).
- On failure (`Success` false, reason in `Error`), keep the state in memory and try again later
  rather than losing progress.
