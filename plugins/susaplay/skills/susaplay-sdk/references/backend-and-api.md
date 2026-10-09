# Backend and Api — low-level modules

Most games never need these: saves, achievements, purchases, ads, analytics and webhooks have
their own modules. Use these only when no module covers the need.

| Module | Calls | Works |
| --- | --- | --- |
| `SusaPlaySDK.Backend` | SusaPlay's API, as the signed-in player | Wherever the SDK is initialized |
| `SusaPlaySDK.Api` | The API of the partner whose site embeds the game | Only inside a partner embed |

Neither calls the developer's own server. For that, use [webhooks](webhooks.md), which the
platform forwards with a signature the server can verify.

## Backend

```csharp
var response = await SusaPlaySDK.Backend.Get("/engagement/achievements/list?gameId=" + SusaPlaySDK.GameId);
var posted = await SusaPlaySDK.Backend.Post("/engagement/achievements/increment",
    "{\"gameId\":\"" + SusaPlaySDK.GameId + "\",\"achievementId\":\"coins_100\",\"incrementBy\":1}");
```

- Only these route prefixes exist at `api.susaplay.com`: `/save`, `/engagement`, `/analytics`,
  `/webhooks`, `/catalog`, `/publicCatalog`, `/ai`, and the SDK's `/economy` routes. Anything else
  (for example `/identity/...`) is not found.
- The path must be relative and start with `/`; a full URL is refused, so the player's token never
  goes to another host. `Post` sends `{}` when the body is null.
- Returns `HttpResponse`: `Success`, `Data`, `Error`, `StatusCode`.
- In the Editor Simulator, a route it does not answer returns `501 SIMULATOR_UNSUPPORTED_ROUTE`;
  test such calls in a build preview.

## Api

```csharp
var result = await SusaPlaySDK.Api.Get("/profile");
if (!result.Success) Debug.Log($"{result.ErrorCode}: {result.ErrorMessage}");
```

- Methods: `Get(endpoint)`, `Get(endpoint, parameters)`, `Post(endpoint, json)`,
  `Request(method, endpoint, json)`. Only `GET` and `POST`, relative paths only.
- Returns `ApiResult`: `Success`, `Data`, `ErrorCode`, `ErrorMessage`.
- `UNAVAILABLE` means the game is not running in a partner embed. The partner's base URL, allowed
  paths and credentials are configured by SusaPlay; the game never sees the credentials.
