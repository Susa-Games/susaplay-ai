# The player — `SusaPlaySDK.Auth`

The page resolves the player before `Initialize()` returns. There is nothing to call.

| Property | Type | Notes |
| --- | --- | --- |
| `Uid` | `string` | The platform player ID. Null for a guest |
| `DisplayName` | `string` | Null for a guest |
| `IsGuest` | `bool` | The player has not signed in |
| `IsAuthenticated` | `bool` | The player has an account |

`SusaPlaySDK.Auth` itself is null until `Initialize()` completes; reading `Auth.Uid` before that
throws. Await `Initialize()` first.

```csharp
await SusaPlaySDK.Initialize();
if (SusaPlaySDK.Auth.IsGuest)
{
    // Guest progress is tied to the browser. Suggest signing in at a natural break.
}
```

- **A guest has no platform session.** Cloud saves, achievements, wallet and inventory calls,
  analytics and webhook events are refused until the player signs in (401 without a session;
  403 `SIGN_IN_REQUIRED` for buying, spending or earning coins). Design guest play to
  work without them: keep a guest's progress locally and save it after sign-in.
- Rewarded ads work for a guest, and `Rewarded` is true when the ad is watched — grant the game's
  own reward. A guest earns no platform coins, not even held for later; paying, spending coins
  and earning coins need a signed-in player. Nothing carries over automatically on sign-in.
- A guest's `Uid` is null; it is set when the player signs in.
- The SDK attaches the player's token to every platform request itself. Never trust a player ID
  sent from the client to your own server.
