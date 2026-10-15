/**
 * Build, and later check, the Hugging Face mirror of every local model.
 *
 *   node scripts/mirror-models.mjs stage <out-dir>
 *   node scripts/mirror-models.mjs verify <revision>
 *
 * Why it exists: on the machine that reported B6, every archive download fails
 * in the bz2 decoder while per-file Hugging Face downloads install and run in
 * the same session (docs/LOG-REVIEW-2026-10.md). The mirror publishes each
 * model as the plain files the worker loads, under the names it loads them by,
 * so the app needs no bz2 or tar and every file is one Range-resumable download.
 *
 * `stage` lays out `<out-dir>/<model id>/<local name>` for every local model in
 * the shipped catalogue, plus the shared VAD:
 *   - a loose-file model is fetched from its catalogue URL and held to its
 *     pinned size and SHA-256;
 *   - an archive model's tar.bz2 is fetched, held to ITS pinned SHA-256, and
 *     unpacked by the system tar (bsdtar or GNU tar with bzip2), never by the
 *     JS decoder under suspicion. Each picked entry is copied out under its
 *     local name and must match the catalogue's declared size.
 * It then writes `manifest.json` ({ id: { name: { size, sha256 } } }) and a
 * model card, and prints the upload command. Re-running skips anything already
 * staged and correct, so an interrupted run just continues.
 *
 * Uploading is the one step that needs the owner: `hf auth login` with a write
 * token for the imbafls account. Nothing here reads, prints or stores a token.
 *
 * `verify <revision>` asks the mirror, at that exact commit, for every file in
 * the catalogue's `mirrors` and checks Hugging Face's own record of each one
 * (`x-linked-size` and `x-linked-etag`, which is the SHA-256 for LFS files)
 * against the catalogue. Run it before setting `MIRROR_REV`, the same way the
 * HF_REV pins were checked before they were written down.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LOCAL_VAD, MIRROR_REPO, STT_MODELS } from "../packages/shared/dist/index.js";

const [mode, arg] = process.argv.slice(2);

function sha256File(file) {
  const h = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(8 << 20);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/** true when `file` is already the bytes described */
function holds(file, size, sha256) {
  return fs.existsSync(file) && fs.statSync(file).size === size && (!sha256 || sha256File(file) === sha256);
}

async function fetchTo(url, file) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(`${file}.part`));
  fs.renameSync(`${file}.part`, file);
}

function systemTar() {
  // bsdtar ships with Windows 10+ and reads bz2 itself; elsewhere GNU tar
  // shells out to bzip2. Either way it is not unbzip2-stream.
  const win = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return process.platform === "win32" && fs.existsSync(win) ? win : "tar";
}

async function stage(out) {
  const manifest = {};
  const local = [...STT_MODELS.filter((m) => m.provider === "local"), LOCAL_VAD];
  for (const info of local) {
    manifest[info.id] = {};
    const dest = path.join(out, info.id);
    fs.mkdirSync(dest, { recursive: true });
    if (!info.archive) {
      for (const f of info.files) {
        const file = path.join(dest, f.name);
        // the catalogue's own origin: the first URL that is not this mirror
        const origin = [f.url, ...(f.mirrors || [])].find((u) => u && !u.includes(MIRROR_REPO));
        if (!holds(file, f.size, f.sha256)) {
          console.log(`fetch ${info.id}/${f.name} (${Math.round(f.size / 1e6)} MB)`);
          await fetchTo(origin, file);
        }
        if (!holds(file, f.size, f.sha256)) throw new Error(`${info.id}/${f.name} does not match the catalogue`);
        manifest[info.id][f.name] = { size: f.size, sha256: f.sha256 };
      }
      continue;
    }
    const archive = path.join(out, "_archives", path.posix.basename(new URL(info.archive.url).pathname));
    if (!holds(archive, info.archive.size, info.archive.sha256)) {
      console.log(`fetch ${info.id} archive (${Math.round(info.archive.size / 1e6)} MB)`);
      await fetchTo(info.archive.url, archive);
    }
    if (!holds(archive, info.archive.size, info.archive.sha256)) {
      throw new Error(`${info.id}: the archive does not match its pinned SHA-256`);
    }
    const sizes = new Map(info.files.map((f) => [f.name, f.size]));
    const need = Object.keys(info.archive.pick).filter((name) => !fs.existsSync(path.join(dest, name)));
    if (need.length) {
      const scratch = path.join(out, "_extract", info.id);
      fs.rmSync(scratch, { recursive: true, force: true });
      fs.mkdirSync(scratch, { recursive: true });
      console.log(`unpack ${info.id}`);
      const r = spawnSync(systemTar(), ["-xjf", archive, "-C", scratch], { stdio: "inherit" });
      if (r.status !== 0) throw new Error(`${info.id}: tar exited ${r.status}`);
      const [top] = fs.readdirSync(scratch);
      for (const [name, entry] of Object.entries(info.archive.pick)) {
        fs.copyFileSync(path.join(scratch, top, entry), path.join(dest, name));
      }
      fs.rmSync(scratch, { recursive: true, force: true });
    }
    for (const name of Object.keys(info.archive.pick)) {
      const file = path.join(dest, name);
      const size = fs.statSync(file).size;
      if (size !== sizes.get(name)) throw new Error(`${info.id}/${name} is ${size} B, the catalogue says ${sizes.get(name)}`);
      manifest[info.id][name] = { size, sha256: sha256File(file) };
    }
  }
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(out, "README.md"), card(local));
  console.log(`\nstaged ${Object.keys(manifest).length} models in ${out}`);
  console.log("upload (needs `hf auth login` with a write token for imbafls first):");
  console.log(`  hf upload ${MIRROR_REPO} "${out}" . --repo-type model --exclude "_archives/*" "_extract/*"`);
  console.log("then take the commit hash it prints and run:");
  console.log("  node scripts/mirror-models.mjs verify <commit>");
}

function card(local) {
  const rows = local.map((m) => {
    const from = m.archive ? m.archive.url : m.files.map((f) => f.url).find(Boolean);
    return `| \`${m.id}\` | ${from} |`;
  });
  return [
    "---",
    "license: other",
    "tags: [sherpa-onnx, speech-recognition]",
    "---",
    "",
    "# Callout Relay model mirror",
    "",
    "Byte-for-byte copies of the speech models the Callout Relay desktop app",
    "downloads, published as plain files so the app needs no archive decoder and",
    "can resume any file. Every file is pinned by SHA-256 in the app's catalogue",
    "and fetched from a fixed commit of this repo.",
    "",
    "Nothing here was retrained or modified. Each model keeps the licence of its",
    "upstream release; see the source below and the sherpa-onnx documentation.",
    "",
    "| Folder | Taken from |",
    "|--------|------------|",
    ...rows,
    "",
  ].join("\n");
}

async function verify(rev) {
  if (!/^[0-9a-f]{40}$/.test(rev || "")) throw new Error("verify needs the full 40-character commit hash");
  let checked = 0;
  let bad = 0;
  const local = [...STT_MODELS.filter((m) => m.provider === "local"), LOCAL_VAD];
  for (const info of local) {
    for (const f of info.files) {
      const url = `https://huggingface.co/${MIRROR_REPO}/resolve/${rev}/${info.id}/${f.name}`;
      const res = await fetch(url, { method: "HEAD", redirect: "manual" });
      const size = Number(res.headers.get("x-linked-size") || res.headers.get("content-length"));
      const etag = (res.headers.get("x-linked-etag") || res.headers.get("etag") || "").replace(/"/g, "");
      const okStatus = res.status === 200 || res.status === 302;
      // small files are stored in git, not LFS, so their etag is not a SHA-256;
      // those are held to their size here and to their digest by the app
      const shaOk = !f.sha256 || etag.length !== 64 || etag === f.sha256;
      checked += 1;
      if (!okStatus || size !== f.size || !shaOk) {
        bad += 1;
        console.log(`MISMATCH ${info.id}/${f.name}: HTTP ${res.status}, ${size} B, etag ${etag}`);
      }
    }
  }
  if (checked === 0) throw new Error("checked nothing - the catalogue is empty?");
  console.log(`${checked} files checked, ${bad} wrong`);
  if (bad) process.exit(1);
}

try {
  if (mode === "stage" && arg) await stage(path.resolve(arg));
  else if (mode === "verify") await verify(arg);
  else {
    console.error("usage: node scripts/mirror-models.mjs stage <out-dir> | verify <revision>");
    process.exit(1);
  }
} catch (err) {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
}
