---
name: susaplay-sdk
description: Integrate the SusaPlay Unity SDK (com.susaplay.sdk) into a WebGL game, or use any of its modules — initialization, the player, cloud saves, the store and purchases, ads, achievements, analytics, game-side webhooks, Backend and Api — and test it in Play Mode with the Editor Simulator. Use when the user adds SusaPlay to a Unity project, asks to make a game SusaPlay-ready or set it up to SusaPlay's standards, or writes code against SusaPlaySDK.
---

# SusaPlay SDK

The SusaPlay SDK is a Unity package written in C#, for **WebGL games only**. The game runs
inside the SusaPlay page, and the SDK talks to the platform through that page. There is no
JavaScript SDK, and nothing here applies to Android or iOS.

Current release: **1.9.1**. Unity 2021.3 or later.

## Install and set up

1. Add the package, pinned to a release tag, in `Packages/manifest.json`:

   ```json
   "com.susaplay.sdk": "https://github.com/Susa-Games/com.susaplay.sdk.git#v1.9.1"
   ```

2. In Unity: **SusaPlay → Setup**, paste the game key, **Save**. This writes
   `Assets/Resources/PlatformConfig.asset`. Never hard-code the game key in scripts.
3. The game key is public — it ships in every build. The **developer API key** is not: it
   never goes into game code. If you need a key for the MCP tools, the developer sets it in the
   SusaPlay plugin's settings; never ask for it in the chat.

With the SusaPlay MCP tools available, run `check_project` after setup: it reports a missing
SDK (SP001), a missing game key (SP003) and Addressables settings problems.

## Initialize once, then use the modules

```csharp
using susaplay.SDK;
using UnityEngine;

public class Bootstrap : MonoBehaviour
{
    private async void Start()
    {
        await SusaPlaySDK.Initialize();
        // Every module is ready from here on.
        SusaPlaySDK.MarkGameLoaded(); // when the first scene is playable
    }
}
```

- Await `Initialize()` before touching any module: the module properties are null until it
  completes. If the page does not answer within 15 seconds it logs an error and returns with the
  modules still null — guard against that if the game can run on its own.
- Call `MarkGameLoaded()` once the first scene is playable, so the page hides its loading screen.
- Identity is resolved by the page during `Initialize()`. There is no login call to make.

## Modules

Every module hangs off the static `SusaPlaySDK` class. Read the reference file before writing
code for a module — the result types differ between modules.

| Property | For | Reference |
| --- | --- | --- |
| `Auth` | The player: `Uid`, `DisplayName`, `IsGuest`, `IsAuthenticated` | [references/identity.md](references/identity.md) |
| `CloudSave` | Versioned save slots | [references/saves.md](references/saves.md) |
| `Purchases` | Wallet, store, inventory, checkout | [references/purchases.md](references/purchases.md) |
| `Ads` | Rewarded and interstitial ads | [references/ads.md](references/ads.md) |
| `Achievements` | Unlock and increment achievements | [references/achievements.md](references/achievements.md) |
| `Analytics` | Custom events | the `susaplay-analytics` skill |
| `Webhooks` | The game's own events, forwarded to the developer's server | [references/webhooks.md](references/webhooks.md) |
| `Backend`, `Api` | Low-level calls, rarely needed | [references/backend-and-api.md](references/backend-and-api.md) |

Testing in Play Mode without a build: [references/editor-simulator.md](references/editor-simulator.md).

## Making a game SusaPlay-ready

When asked to set a game up "for SusaPlay" or to SusaPlay's standards, go through this list and do
each item that fits the game. Report what was done and what was skipped, and why.

1. The SDK installed and the game key set (**SusaPlay → Setup**).
2. `await SusaPlaySDK.Initialize()` at startup, then `MarkGameLoaded()` when the first scene is
   playable.
3. Progress saved with `CloudSave` — JSON data; an empty slot means a new player.
4. Purchases, the wallet and ads through `Purchases` and `Ads`, granting only on the platform's
   confirmation (`Success` for purchases, `Rewarded` for ads).
5. Achievements only with IDs registered in the Developer Portal; with the MCP tools,
   `sync_simulator_config` brings them into the Editor Simulator.
6. `level_up` with a `level` whenever the player's level changes, if the game has player levels.
7. The recommended analytics events — see the `susaplay-analytics` skill.
8. With the MCP tools, `check_project`; then test in Play Mode with the Editor Simulator.

Do not invent features or events beyond this list and the references. Never move the developer's
money or items logic to the client.

## Rules that apply everywhere

- **Calls do not throw for platform errors.** They return a result object; check its `Success`
  field (capital S — these are C# fields) before using the rest.
- **The server owns money and items.** Never keep a balance or inventory as the truth on the
  client, and never grant an item before the platform confirms it.
- **Purchases go through the SusaPlay page's checkout.** The game starts it and awaits the
  outcome; it never names or calls a payment provider.
- Only describe and use what the SDK has. If a feature is not in the references, check the
  SusaPlay docs (the `susaplay-docs` MCP server, or docs.susaplay.com) rather than guessing.
- Rebuild the game after upgrading the package; the SDK version is compiled into the build.
