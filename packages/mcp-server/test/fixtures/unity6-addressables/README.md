# Unity 6 / Addressables 2.9 fixtures

Files Unity 6000.3.13f1 wrote for a neutral test project with Addressables 2.9.1: a local default
group with one material, a `Remote Content` group with one prefab loading from
`https://games.susaplay.com/addressables/test-game`, a binary remote catalog with the Player
Version Override `1`, and a WebGL build.

- `project/` — the project's package and Addressables settings, as text-serialized YAML.
- `build/` — from the WebGL build: `index.html`, the loader and `StreamingAssets/aa`. The large
  `.wasm`, `.data` and framework files are left out; no check reads them.
- `serverData/` — the Addressables content to publish (`ServerData/WebGL`).

Rebuilt with the `SusaPlay Fixtures → Build All` menu of the editor script
`SusaPlayFixtureBuilder.cs` (kept with the test project, not in this repository).
