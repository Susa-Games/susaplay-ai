import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Builds the bundle once, before any test file runs. Test files run in parallel,
// and two builds at once used to overwrite each other's output.
export default function setup(): void {
  execFileSync(process.execPath, ["build.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit",
  });
}
