/**
 * List and download what has accumulated in the `callout-relay-feedback` R2
 * bucket: the reports SEND FEEDBACK writes from the desktop app (Task 8) via
 * `POST /feedback` (Task 7).
 *
 *   node scripts/read-feedback.cjs <out-dir> [prefix]
 *
 * There is deliberately no read route on the Worker - `apps/hosted-relay/src/index.ts`
 * only ever calls `env.FEEDBACK.put`, never `.get` or `.list`, so no visitor,
 * however the request is shaped, can ever reach what somebody sent in. Reading
 * it back is an operator task against R2 itself, which is what this script is.
 *
 * A record is stored at `<YYYY>/<MM>/<DD>/<id>.json` -
 * `{ message, appVersion, timestamp }`, nothing that identifies a machine (see
 * `handleFeedback` in `src/index.ts`) - with an optional sibling
 * `<YYYY>/<MM>/<DD>/<id>.log` holding the redacted log the person chose to
 * attach. This script lists every record under `[prefix]` (default: the whole
 * bucket), prints one line per report, and downloads both files for each one
 * into `<out-dir>`, preserving that same day-prefixed layout - so a second run
 * over a wider prefix, or a re-run after more reports have arrived, just adds
 * files rather than needing to know what it already has.
 *
 * Auth: same as read-cost.cjs, and for the same reason - `CLOUDFLARE_API_TOKEN`
 * if it is set, otherwise the OAuth token `wrangler login` already stored on
 * this machine. That is not a guess: R2 objects are reachable three ways -
 * the S3-compatible API (its own Access Key ID / Secret, minted separately and
 * never needed anywhere else in this repo), the in-Worker API (no use to a
 * script running outside a Worker), and the plain `api.cloudflare.com` REST
 * API, which is "the API used by the Cloudflare Dashboard and Wrangler CLI"
 * for exactly this - bucket management and object operations - and is what
 * `wrangler r2 object get --remote` itself resolves to. Reusing the token
 * already sitting in wrangler's config is one fewer credential this project
 * has to mint, store and rotate, and it is provably enough: this script's
 * list and get calls were exercised against the real bucket while this was
 * written, with no credential beyond what `wrangler login` already left on
 * this machine.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ACCOUNT = "c9b5a04c1a901e52c8d99c576ee55f90";
const BUCKET = "callout-relay-feedback";
const API = "https://api.cloudflare.com/client/v4";

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

/**
 * Every object key under `prefix`, oldest-lexicographic-first (which for a
 * `YYYY/MM/DD/<id>` key is oldest day first). Pages with `start_after` rather
 * than trusting a `cursor`/`result_info` field this endpoint's docs do not
 * pin down: R2 guarantees lexicographic order and unique keys, so re-querying
 * with `start_after` set to the last key of the previous page is correct
 * regardless of what pagination metadata the response does or does not carry
 * - it stops the moment a page comes back shorter than the limit it asked
 * for, which only happens at the true end.
 */
async function listAll(bearer, prefix) {
  const keys = [];
  let startAfter;
  const LIMIT = 1000;
  for (;;) {
    const url = new URL(`${API}/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects`);
    url.searchParams.set("limit", String(LIMIT));
    if (prefix) url.searchParams.set("prefix", prefix);
    if (startAfter) url.searchParams.set("start_after", startAfter);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
    const body = await res.json();
    if (!res.ok || body.success === false) {
      throw new Error(`list failed (${res.status}): ${JSON.stringify(body.errors ?? body)}`);
    }
    const page = body.result ?? [];
    keys.push(...page);
    if (page.length < LIMIT) return keys;
    startAfter = page[page.length - 1].key;
  }
}

/** the raw body of one object, as text - every object this bucket holds is JSON or a plain-text log */
async function getObject(bearer, key) {
  const res = await fetch(`${API}/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects/${encodeURI(key)}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new Error(`get ${key} failed (${res.status}): ${body ? JSON.stringify(body.errors ?? body) : res.statusText}`);
  }
  return res.text();
}

function writeUnder(outDir, key, text) {
  const dest = path.join(outDir, ...key.split("/"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text, "utf8");
  return dest;
}

/** one line for the terminal - message trimmed to a screen width, not the file written to disk */
function preview(message) {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 72 ? `${oneLine.slice(0, 69)}...` : oneLine;
}

(async () => {
  const [outDir, prefix] = process.argv.slice(2);
  if (!outDir) {
    console.error("usage: node scripts/read-feedback.cjs <out-dir> [prefix]");
    console.error("  prefix narrows the listing, e.g. 2026/09 for a month or 2026/09/08 for a day");
    process.exit(1);
  }

  const auth = token();
  if (!auth) {
    console.error("no Cloudflare credential found - set CLOUDFLARE_API_TOKEN or run `wrangler login`");
    process.exit(1);
  }
  console.log(`bucket ${BUCKET}   prefix ${prefix || "(none - whole bucket)"}   auth: ${auth.from}`);

  const objects = await listAll(auth.value, prefix);
  const records = objects.filter((o) => o.key.endsWith(".json")).sort((a, b) => a.key.localeCompare(b.key));
  const logKeys = new Set(objects.filter((o) => o.key.endsWith(".log")).map((o) => o.key));

  if (records.length === 0) {
    console.log("nothing has accumulated under that prefix");
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  let withLog = 0;
  let bytes = 0;
  for (const obj of records) {
    const raw = await getObject(auth.value, obj.key);
    writeUnder(outDir, obj.key, raw);
    bytes += obj.size ?? Buffer.byteLength(raw);

    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      console.log(`${obj.key}  (could not parse as JSON - saved raw)`);
      continue;
    }

    const logKey = obj.key.replace(/\.json$/, ".log");
    const hasLog = logKeys.has(logKey);
    if (hasLog) {
      const logRaw = await getObject(auth.value, logKey);
      writeUnder(outDir, logKey, logRaw);
      bytes += Buffer.byteLength(logRaw);
      withLog += 1;
    }

    console.log(
      `${record.timestamp ?? "?"}  v${record.appVersion ?? "?"}  ${hasLog ? "[log]" : "     "}  ${preview(record.message ?? "")}`,
    );
  }

  console.log(`\n${records.length} report${records.length === 1 ? "" : "s"}, ${withLog} with a log attached, ${(bytes / 1024).toFixed(1)} KB written to ${outDir}`);
})().catch((err) => {
  console.error("read failed:", err?.message || err);
  process.exit(1);
});
