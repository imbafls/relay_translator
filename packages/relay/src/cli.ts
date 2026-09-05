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
