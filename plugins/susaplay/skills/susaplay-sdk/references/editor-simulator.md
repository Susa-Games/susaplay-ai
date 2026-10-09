# Testing in Play Mode — the Editor Simulator

From SDK **1.9.0**, pressing Play in the Unity Editor works: the Editor Simulator answers the game
in place of the SusaPlay page and platform. `Initialize()` completes, every module is ready, and
saves, achievements, the store, purchases and ads follow the platform's rules — status codes,
error codes and response shapes included. Nothing is sent to SusaPlay. Older SDKs time out in the
Editor and leave every module null.

## Set up

1. SDK 1.9.0 or later.
2. Get the game's configuration (achievements, store items, top-up packs, ad settings):
   - with the SusaPlay MCP tools, run `sync_simulator_config` — it finds the game by the project's
     game key and writes `ProjectSettings/Packages/com.susaplay.sdk/SimulatorConfig.json`;
   - or in the Developer Portal, **Download for Unity Editor**, then in Unity
     **SusaPlay → Simulator**, then **Import configuration…** in the window's Configuration
     section.
3. Commit `SimulatorConfig.json` so the team shares it. It holds nothing secret and never reaches a
   build. Fetch it again after changing achievements, items or ad settings in the portal.

Without a configuration the simulator behaves like a game with nothing configured: the store is
empty, every achievement is `NOT_FOUND`, wallet spends fail with `ITEM_NOT_FOUND`, and checkout
purchases return `Status` `token-failed`. Saves,
analytics, webhooks, sign-in and ads still work.

## The window — SusaPlay → Simulator

- **Player**: switch to a guest, sign a guest in during Play, or **Reset player**.
- **Simulation**: purchases answer **Paid** and ads **Complete** by default; set **Ask** to answer
  each one under **Pending** (canceled, closed, skipped, no ad). **Next request fails** injects a
  `401`, `500` or network error once.
- **State**: saves, achievements, inventory, wallet. State is kept in
  `Library/SusaPlaySimulator/` between Plays.
- **Request log**: every request with its status and error.

`SusaPlaySDK.IsSimulated` is true while the simulator answers and always false in a build. Use it
for a debug badge only, never to change game logic.

## Still needs a build preview

Upload a build and open it with **Preview** or **Share** in the portal (or `create_preview_link`)
to test what the Editor cannot: WebGL and IL2CPP behaviour (no threads, code stripping), memory and
load time in a browser, audio and input focus, the real checkout and real ads, `.jslib` code, and
webhook delivery to the developer's server.
