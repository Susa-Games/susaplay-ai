# The player — `SusaPlaySDK.Auth`

The page resolves the player before `Initialize()` returns. There is nothing to call.

| Property | Type | Notes |
| --- | --- | --- |
| `Uid` | `string` | The platform player ID |
| `DisplayName` | `string` | May be empty for a guest |
| `IsGuest` | `bool` | The player has not signed in |
| `IsAuthenticated` | `bool` | The player has an account |

All of them are null or false before `Initialize()` completes.

```csharp
await SusaPlaySDK.Initialize();
if (SusaPlaySDK.Auth.IsGuest)
{
    // Guest progress is tied to the browser. Suggest signing in at a natural break.
}
```

- Guests can use saves, the wallet and analytics like signed-in players.
- When a guest signs in, the platform links their progress to the account. The game does not
  drive or migrate anything.
- A guest's `Uid` can change when they later sign in. Do not use it as a permanent key in your
  own backend without handling that.
- The SDK attaches the player's token to every platform request itself. Never trust a player ID
  sent from the client to your own server.
