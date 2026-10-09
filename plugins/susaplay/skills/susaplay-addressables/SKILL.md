---
name: susaplay-addressables
description: Configure, build and publish Unity Addressables remote content for a SusaPlay WebGL game — the required Addressables settings, building player and content together, staging versus live, the publish plan, the compatibility check and what each failure means, releases and rollback, and limits. Use when the user works with Addressables, remote content, catalogs or bundles on SusaPlay.
---

# Addressables on SusaPlay

Addressables let a WebGL game change remote content — levels, art, data — without a new build.
Content is uploaded to **staging** (players see nothing), then **published**: it goes live for
every player at once, with no review. Every publish creates a **release**, and a kept release can
be restored with a **rollback**.

Addressables are enabled once per game, in the Developer Portal (**Addressables → Enable**), which
shows the game's **Remote Load Path**: `https://games.susaplay.com/addressables/{gameId}/`.

## Required settings

| Setting | Value | Why |
| --- | --- | --- |
| Build Remote Catalog | On | Without it, published content never reaches players |
| Remote Load Path (active profile) | The exact URL from the portal | It is compiled into the build; a wrong path cannot be fixed without a new build |
| Bundle Naming Mode | `Filename And Hash` or `Full Path And Hash` | SusaPlay refuses bundles without Unity's 32-character hash in the name |
| Catalog format | **Binary** (`catalog_*.bin`) | SusaPlay refuses JSON catalogs |
| Player Version Override | A constant number, such as `1` or `1.0` (up to three numeric parts, optionally `-suffix`) | Otherwise the catalog name changes with every build, and SusaPlay refuses a name that is not a number, such as Unity's default timestamp |
| Built-in data and MonoScripts | In a **Remote** group | In a Local group they tie every content update to one player build |

A binary catalog is the default in Addressables 2.x (Unity 6): leave **Enable Json Catalog** off.
On Unity 2021.3 or 2022.3, use Addressables 1.21.3 or later and add `ENABLE_BINARY_CATALOG` to the
WebGL Scripting Define Symbols, then rebuild player and content.

With the SusaPlay MCP tools, `check_project` reports each of these: SP010 (Remote Load Path),
SP011 (Build Remote Catalog), SP012 (built-in data in a Local group), SP013 (no constant player
version override), SP014 (bundle names without a hash), SP015 (JSON catalog).

## Build player and content together

The catalog a build requests and the bundles it ships must match the published content.

- Build the Addressables content (**New Build** or **Update a Previous Build**) and then the WebGL
  player from the same project and profile.
- `inspect_build` with `serverDataPath` (the content folder, such as `ServerData/WebGL`) checks the
  build against that content before anything is uploaded.
- When built-in data stays in a Local group, content built with a new player build only works with
  that build: publish it after the new build is live.

## Publish with the MCP tools

1. `upload_addressables` with `serverDataPath` — uploads the catalog pair and the remote bundles
   that catalog names, skipping bundles SusaPlay already has. Unity's `ServerData` folder keeps
   earlier builds' bundles; those are ignored. If the folder has several catalogs, pass `catalog`.
   Players see nothing yet.
2. `plan_addressables_publish` — what would change: files added, replaced and removed, the catalog
   version, the compatibility check, and which old release would no longer be kept. **Show the
   plan to the developer.**
3. `publish_addressables` with the plan's `expectedLiveReleaseId` and `expectedStagingHash` —
   **only after the developer confirms**. It is refused if anything changed since the plan.
4. To undo: `get_addressables` lists the kept releases; `rollback_addressables` restores one —
   again only after the developer confirms which release.

Without the tools: the portal's Addressables tab (drop the content folder, **Review and publish**,
**Roll back to this release**), or the API steps on the SusaPlay docs' Addressables page.

Uploading and planning need `addressables:write` (the "AI assistant" preset has it). Publishing
and rolling back need `addressables:publish` (the "AI assistant with live publishing" or "CI
publishing" preset); with the plain AI assistant preset, show the plan and let the developer
publish in the portal. The developer changes the key in
the plugin settings — never in the chat.

## The compatibility check

Every publish and rollback is checked against the game's live WebGL build first. A failure
refuses it (`INCOMPATIBLE_CATALOG`) and nothing changes.

| Check | Fails when | Usual fix |
| --- | --- | --- |
| C1 | The live build requests a catalog the content does not have, or requests it from another path | Keep the Player Version Override constant; set the Remote Load Path and publish a new build |
| C2 | The catalog names a bundle that is neither in the content nor inside the live build | Build content and player together; move built-in data to a Remote group |
| C3 | A remote bundle loads from outside the game's Remote Load Path, or from an unresolved `{…}` placeholder | Set the Remote Load Path to the portal's exact URL and rebuild the content |
| C4 | The catalog cannot be read | Build a binary catalog |

Without a live build, or when the live build loads no remote catalog, C1 and the check for
bundles inside the build are skipped. A developer cannot skip a failed check — fix the content or
the build; only a SusaPlay admin can override it, with an audited reason.

## Releases and rollback

- SusaPlay keeps the **three newest releases plus the live one**. Publishing deletes older ones.
- A rollback is checked like a publish, against the **current** live build — a release made for
  an older build may fail.
- A rollback creates no release and leaves staging untouched; undo it with another rollback.
- Only one publish or rollback runs per game at a time (`OPERATION_IN_PROGRESS`: wait and retry).

## Limits

| Limit | Value |
| --- | --- |
| Files in one release | 1,500 |
| Size of one release | 5 GB |
| Catalog file | 10 MB |
| Bundle | 200 MB |

Catalogs are served uncached, so a publish reaches players on their next catalog check. Bundles
are cached for a year, which is safe because a changed bundle gets a new name.

If SusaPlay suspends a game's Addressables, content requests that are not already cached fail, the
base build keeps running, and uploading and publishing are blocked until SusaPlay reinstates
them.
