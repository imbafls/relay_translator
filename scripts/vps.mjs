/**
 * VPS deploy helper: run commands / upload files to the Hostinger VPS via
 * ssh2 (password auth). Usage:
 *   node scripts/vps.mjs exec "uname -a"
 *   node scripts/vps.mjs put <local> <remote>
 *
 * Credentials (never hardcoded): VPS_PASSWORD env var, or read from
 * F:\Ai\_projects\_secrets\hostinger_vps.txt
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("ssh2");

const HOST = process.env.VPS_HOST || "187.124.87.202";
const USER = process.env.VPS_USER || "root";

function resolvePassword() {
  if (process.env.VPS_PASSWORD) return process.env.VPS_PASSWORD;
  const candidates = [
    process.env.VPS_SECRETS_FILE,
    "F:\\Ai\\_projects\\_secrets\\hostinger_vps.txt",
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const m = readFileSync(file, "utf8").match(/password:\s*(\S+)/i);
      if (m) return m[1];
    } catch {
      /* try next */
    }
  }
  throw new Error("VPS password not found: set VPS_PASSWORD or create the _secrets file");
}

const PASSWORD = resolvePassword();

const [, , cmd, ...args] = process.argv;

function connect() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => resolve(conn))
      .on("error", reject)
      .connect({ host: HOST, username: USER, password: PASSWORD, readyTimeout: 20000 });
  });
}

async function exec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      let errOut = "";
      let code = 0;
      stream
        .on("close", () => resolve({ code, out, err: errOut }))
        .on("data", (d) => (out += d.toString()))
        .stderr.on("data", (d) => (errOut += d.toString()));
      stream.on("exit", (c) => (code = c));
    });
  });
}

async function put(conn, local, remote) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const rs = readFileSync(local);
      const ws = sftp.createWriteStream(remote, { mode: 0o755 });
      ws.on("error", reject);
      ws.on("close", () => resolve());
      ws.end(rs);
    });
  });
}

const conn = await connect();
try {
  if (cmd === "exec") {
    const { code, out, err } = await exec(conn, args.join(" "));
    process.stdout.write(out);
    if (err) process.stderr.write(err);
    process.exit(code);
  } else if (cmd === "put") {
    await put(conn, args[0], args[1]);
    console.log(`uploaded ${args[0]} -> ${args[1]}`);
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
} finally {
  conn.end();
}
