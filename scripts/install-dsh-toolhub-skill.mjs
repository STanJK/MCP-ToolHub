import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const source = path.join(repoRoot, "dsh", "skills", "toolhub-localbuild", "SKILL.md");

const dshHome =
  process.env.DSH_HOME ??
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dsh");

if (!dshHome) {
  throw new Error("Unable to resolve DSH home; set DSH_HOME explicitly");
}

const destinationDir = path.join(dshHome, "skills", "toolhub-localbuild");
const destination = path.join(destinationDir, "SKILL.md");

await mkdir(destinationDir, { recursive: true });
await copyFile(source, destination);

console.log(`Installed ToolHub LocalBuild skill to ${destination}`);
