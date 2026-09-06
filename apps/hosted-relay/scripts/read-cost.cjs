/**
 * Read billed Durable Object duration for a time window, so the cost question
 * has a number rather than an opinion.
 *
 *   node scripts/read-cost.cjs <startISO> <endISO>
 *
 * Pairs with measure-cost.cjs, which holds a room open and prints the window.
 *
 * Auth: `CLOUDFLARE_API_TOKEN` if it is set, otherwise the OAuth token wrangler
 * already stores for this machine - the same credential `wrangler deploy` uses,
 * read here for a read-only query and never printed. If neither works, the same
 * numbers are on the Workers dashboard under the Durable Objects metrics for
 * the `Room` class; this script exists so nobody has to remember that.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ACCOUNT = "c9b5a04c1a901e52c8d99c576ee55f90";

function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return { value: process.env.CLOUDFLARE_API_TOKEN, from: "CLOUDFLARE_API_TOKEN" };
  const candidates = [
    path.join(os.homedir(), "AppData", "Roaming", "xdg.config", ".wrangler", "config", "default.toml"),
    path.join(os.homedir(), ".wrangler", "config", "default.toml"),
    path.join(os.homedir(), ".config", ".wrangler", "config", "default.toml"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const toml = fs.readFileSync(file, "utf8");
    const value = /^oauth_token\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
    const expires = /^expiration_time\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
    if (value) {
      if (expires && Date.parse(expires) < Date.now()) {
        console.warn(`wrangler's token expired at ${expires} - run any wrangler command to refresh it`);
      }
      return { value, from: "wrangler login" };
    }
  }
  return null;
}

const QUERY = `
query DurableObjectDuration($account: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      durableObjectsInvocationsAdaptiveGroups(
        limit: 100
        filter: { datetime_geq: $start, datetime_leq: $end }
      ) {
        sum { requests responseBodySize }
      }
      durableObjectsPeriodicGroups(
        limit: 100
        filter: { datetime_geq: $start, datetime_leq: $end }
      ) {
        # duration is the billed quantity itself, in GB*s - introspection says
        # so, which beats converting activeTime and hoping about the unit
        sum { duration activeTime inboundWebsocketMsgCount outboundWebsocketMsgCount }
      }
    }
  }
}`;

(async () => {
  const [start, end] = process.argv.slice(2);
  if (!start || !end) {
    console.error("usage: node scripts/read-cost.cjs <startISO> <endISO>");
    process.exit(1);
  }
  const auth = token();
  if (!auth) {
    console.error("no Cloudflare credential found - set CLOUDFLARE_API_TOKEN or run `wrangler login`");
    process.exit(1);
  }
  console.log(`window ${start} .. ${end}   (auth: ${auth.from})`);

  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.value}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { account: ACCOUNT, start, end } }),
  });
  const body = await res.json();
  if (body.errors?.length) {
    console.error("GraphQL said:", JSON.stringify(body.errors, null, 2));
    process.exit(1);
  }
  const account = body?.data?.viewer?.accounts?.[0];
  if (!account) {
    console.error("no account data came back:", JSON.stringify(body).slice(0, 400));
    process.exit(1);
  }

  const periodic = account.durableObjectsPeriodicGroups ?? [];
  const invocations = account.durableObjectsInvocationsAdaptiveGroups ?? [];
  const sum = (rows, field) => rows.reduce((n, g) => n + (g.sum?.[field] ?? 0), 0);

  const gbs = sum(periodic, "duration");
  const activeSeconds = sum(periodic, "activeTime") / 1_000_000;
  const requests = sum(invocations, "requests");
  const wsIn = sum(periodic, "inboundWebsocketMsgCount");
  const windowMinutes = (Date.parse(end) - Date.parse(start)) / 60000;

  console.log(`requests      ${requests}   (hibernating WebSocket messages count here, not as periodic)`);
  console.log(`ws messages   ${wsIn} inbound`);
  console.log(`active time   ${activeSeconds.toFixed(2)} s`);
  console.log(`billed        ${gbs.toFixed(4)} GB-s`);
  if (windowMinutes > 0) {
    console.log("");
    console.log(`per hour of live room, at this rate:`);
    console.log(`  active      ${((activeSeconds / windowMinutes) * 60).toFixed(1)} s`);
    console.log(`  billed      ${((gbs / windowMinutes) * 60).toFixed(3)} GB-s`);
  }
})().catch((err) => {
  console.error("read failed:", err?.message || err);
  process.exit(1);
});
