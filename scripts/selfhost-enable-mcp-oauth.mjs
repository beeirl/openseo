// Runs after `pnpm deploy:selfhost`. Alchemy's Access Application resource does
// not model Managed OAuth, which MCP clients need to authenticate through the
// Access gate, so this turns it on (idempotently) with a direct API call.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const envFile = ".env.selfhost";
const env = {};
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (match) env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
}
const get = (name) => (process.env[name] ?? env[name] ?? "").trim();

const skip = (reason) => {
  console.log(`Managed OAuth for MCP: skipped (${reason}).`);
  process.exit(0);
};

if ((get("AUTH_MODE") || "cloudflare_access") !== "cloudflare_access") {
  skip("AUTH_MODE is not cloudflare_access");
}
if (get("TEAM_DOMAIN") && get("POLICY_AUD")) {
  skip("Access application is managed outside the deploy");
}

const accountId = get("CLOUDFLARE_ACCOUNT_ID") || readProfileAccountId();
const token = get("CLOUDFLARE_API_TOKEN") || readProfileOAuthToken();
if (!accountId || !token) {
  skip(
    "no Cloudflare credentials found; enable it in Zero Trust > Applications",
  );
}

const api = async (method, route, body) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!json.success) {
    throw new Error(
      `${method} ${route} failed: ${json.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return json.result;
};

const hostname = await resolveHostname();
const apps = await api("GET", `/accounts/${accountId}/access/apps`);
const app = apps.find((candidate) => candidate.domain === hostname);
if (!app) skip(`no Access application found for ${hostname}`);

const allowedUris = (
  get("MCP_OAUTH_REDIRECT_URIS") ||
  "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback"
)
  .split(",")
  .map((uri) => uri.trim())
  .filter(Boolean);

const desired = {
  enabled: true,
  dynamic_client_registration: {
    enabled: true,
    allow_any_on_localhost: true,
    allow_any_on_loopback: true,
    allowed_uris: allowedUris,
  },
};

const current = app.oauth_configuration ?? {};
const currentDcr = current.dynamic_client_registration ?? {};
const unchanged =
  current.enabled === true &&
  currentDcr.enabled === true &&
  currentDcr.allow_any_on_localhost === true &&
  currentDcr.allow_any_on_loopback === true &&
  JSON.stringify(currentDcr.allowed_uris ?? []) === JSON.stringify(allowedUris);
if (unchanged) {
  console.log(`Managed OAuth for MCP: already enabled on ${hostname}.`);
  process.exit(0);
}

await api("PUT", `/accounts/${accountId}/access/apps/${app.id}`, {
  type: app.type,
  name: app.name,
  domain: app.domain,
  session_duration: app.session_duration,
  policies: app.policies.map((policy) => policy.id),
  oauth_configuration: desired,
});
console.log(
  `Managed OAuth for MCP: enabled on ${hostname}. MCP endpoint: https://${hostname}/mcp`,
);

async function resolveHostname() {
  const customDomain = get("CUSTOM_DOMAIN");
  if (customDomain) return customDomain;
  const workerName = get("WORKER_NAME") || "open-seo-selfhost";
  const configured = get("WORKERS_SUBDOMAIN");
  if (configured) return `${workerName}.${configured}`;
  const { subdomain } = await api(
    "GET",
    `/accounts/${accountId}/workers/subdomain`,
  );
  return `${workerName}.${subdomain}.workers.dev`;
}

function readProfile() {
  const profileName = get("ALCHEMY_PROFILE") || "default";
  const file = path.join(homedir(), ".alchemy", "profiles.json");
  if (!existsSync(file)) return { profileName, cloudflare: undefined };
  const profiles = JSON.parse(readFileSync(file, "utf8")).profiles ?? {};
  return { profileName, cloudflare: profiles[profileName]?.Cloudflare };
}

function readProfileAccountId() {
  return readProfile().cloudflare?.accountId ?? "";
}

function readProfileOAuthToken() {
  const { profileName, cloudflare } = readProfile();
  if (cloudflare?.method !== "oauth") return "";
  const file = path.join(
    homedir(),
    ".alchemy",
    "credentials",
    profileName,
    "cf-oauth.json",
  );
  if (!existsSync(file)) return "";
  const credentials = JSON.parse(readFileSync(file, "utf8"));
  return credentials.expires > Date.now() ? credentials.access : "";
}
