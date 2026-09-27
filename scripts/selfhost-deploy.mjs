// `pnpm deploy:selfhost [alchemy flags]`. A single script instead of a `&&`
// chain so flags such as --yes and --profile reach `alchemy deploy` even
// though the Managed OAuth step runs after it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const envFile = ".env.selfhost";
const readEnvValue = (name) => {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] === name) {
      return match[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  return "";
};

const flags = process.argv.slice(2);
const profile = process.env.ALCHEMY_PROFILE || readEnvValue("ALCHEMY_PROFILE");
if (profile && !flags.includes("--profile")) {
  flags.push("--profile", profile);
}

run("node", ["scripts/selfhost-deploy-preflight.mjs"]);
run("pnpm", ["exec", "vite", "build", "--mode", "selfhost"]);
run("pnpm", ["exec", "tsc", "--noEmit"]);
run("pnpm", [
  "alchemy",
  "deploy",
  "--env-file",
  envFile,
  "--stage",
  "selfhost",
  ...flags,
]);
run("node", ["scripts/selfhost-enable-mcp-oauth.mjs"]);
