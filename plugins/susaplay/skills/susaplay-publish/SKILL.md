---
name: susaplay-publish
description: Build a Unity WebGL game for SusaPlay and publish it — build settings, version numbers, checking the build, uploading it, review or the private-game ready state, preview links, build retention, and processing failures. Use when the user wants to upload, publish, release or preview a SusaPlay build, or asks why a build failed or disappeared.
---

# Publishing a WebGL build to SusaPlay

SusaPlay runs **WebGL builds only**. A build is uploaded as a version, processed, and then either
waits for SusaPlay's review or — for a game that is still private — is ready to test.

## With the SusaPlay MCP tools

1. `check_project` — SDK and Addressables setup. Fix errors before building.
2. Build the WebGL player in Unity (settings below).
3. `inspect_build` on the build folder or `.zip` — the same rules the server applies, so a
   build that would fail is caught before a long upload. Add `serverDataPath` when Addressables
   content was built with it (see the `susaplay-addressables` skill).
4. `get_game` — the latest version, what is in review, and which old builds the next upload
   would delete. Pick a version higher than the latest.
5. `publish_build` — zips, uploads with progress, and waits for processing. It ends on:
   - `pending_review`: waiting for SusaPlay's review; players see nothing yet;
   - `ready`: the game is private, so the build is not reviewed — test it, and when the game is
     ready the developer uses **Request public** in the Developer Portal;
   - `failed`: the reason is given; fix the build and publish again with the same version.
6. `create_preview_link` — a single-use link that expires in 30 minutes, to play a
   `pending_review` or `ready` build. Do not share it; make a new one to play again.

Tell the developer before `publish_build` that retention may delete old builds, naming them
(from `get_game`).

Without the tools: Developer Portal → the game → **Builds → Upload Build**, or the CI steps in the
SusaPlay docs (Build Uploads page). Never ask for the developer API key in the chat; CI reads it
from a secret.

## Unity build settings

- Platform: **WebGL**.
- Compression Format: **Brotli** is recommended, with Decompression Fallback off.
- The output folder must contain `index.html` and `Build/*.loader.js`. One wrapping folder is
  fine; several top-level folders without `index.html` are not.
- Do not leave `.zip` archives or other builds inside the output folder — they would be uploaded
  and served with the game.

## Version numbers

`x.y.z`, optionally with `-` and a run of letters and digits: `1.0.9`, `1.0.10`, `1.1.0-beta`
(`1.1.0-beta.1` and `1.1.0-rc-2` are refused). Each upload needs a new, unused version —
conventionally higher than the latest; a `failed` version may be uploaded again with the same
number.

## Limits and retention

| Rule | Value |
| --- | --- |
| Entries in the zip (folders included) | 1,000 |
| One file, uncompressed | 200 MB |
| Whole archive, uncompressed | 1.5 GB |
| The zip itself | 500 MB |
| Builds kept per game | the 5 most recent, plus older builds that are protected (below) |
| Grace period before a build can be removed | 24 hours |
| Builds in review at once | 3 (builds still processing count) |

Never deleted automatically: the live build, builds in review or processing, and anything inside
the grace period. A `ready` build of a private game is kept like any other build — among the 5
most recent — so upload sparingly while a **Request public** is pending, or its build can be
removed. A `failed` build is removed by the next successful upload, whatever its age. A fourth
build while three are in review is refused with `409`; developers cannot delete builds, so wait
for a review.

A build in `processing` or `extracting` for more than 15 minutes is reported as `failed`
(`PROCESSING_TIMEOUT`), and its version may be uploaded again.

## Statuses

| Status | Meaning |
| --- | --- |
| `processing`, `extracting` | Uploaded; SusaPlay is extracting it (usually under a minute) |
| `failed` | Processing failed; the reason is in `failure.message` |
| `pending_review` | Waiting for review |
| `ready` | A private game's build, playable with Preview and Share, not under review |
| `live` | Served to players |
| `deprecated` | Replaced by a newer live build |
| `rejected` | Did not pass review; the notes are in the portal |

A passing review makes the build live; SusaPlay sends the `BUILD_LIVE` webhook event, or
`BUILD_REJECTED`. For a private game, the developer's **Request public** sends one `ready` build
for review together with the game; it needs a thumbnail, a description of at least 200
characters and a URL slug.

## Before review

Reviewers start from a fresh player account and test every flow, including purchases and
rewarded ads. Release notes should say what changed and how to reach new features.
