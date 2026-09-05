import * as path from "path";
import { startRelay, relayDataDir, tryLoadDotenv } from "./index";

// dev: repo root .env two levels up; packaged exe: .env next to the binary
const dotenvDirs: string[] = [process.cwd()];
try {
  dotenvDirs.push(path.dirname(process.execPath));
} catch {
  /* keep cwd only */
}
try {
  // eslint-disable-next-line no-undef
  dotenvDirs.push(path.resolve(__dirname, "..", "..", ".."));
} catch {
  /* __dirname unavailable (SEA) */
}
tryLoadDotenv(dotenvDirs);

/**
 * This runs unattended on a public host, so the useful failure mode is a
 * logged error and a relay that is still up rather than a clean exit and every
 * viewer disconnected. Node warns the process may be in an undefined state
 * after this, and that is a real cost - but the alternative here is one
 * malformed request ending the stream for everyone, and systemd restarting
 * into the same request until it gives up on the unit.
 */
process.on("uncaughtException", (err) => {
  console.error(`[relay] uncaught: ${err?.stack || String(err)}`);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[relay] unhandled rejection: ${String(reason)}`);
});

async function main(): Promise<void> {
  const handle = await startRelay({
    port: process.env.RELAY_PORT ? Number(process.env.RELAY_PORT) : undefined,
    dataDir: relayDataDir(),
    deepgramApiKey: process.env.DEEPGRAM_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
    mockStt: process.env.RELAY_MOCK_STT === "1",
    mockGemini: process.env.RELAY_MOCK_GEMINI === "1",
    log: (level, message) => console[level === "info" ? "log" : level](`[relay:${level}] ${message}`),
  });

  console.log("[relay] ready");
  console.log(`  local   ${handle.origin}/watch/${handle.state.viewerToken}`);
  console.log(`  health  ${handle.origin}/health`);
  console.log(`  tokens  -> ${relayDataDir()}\\relay-state.json`);
}

main().catch((err) => {
  console.error("[relay] fatal:", err);
  process.exit(1);
});
