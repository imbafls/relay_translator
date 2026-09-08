import { describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import { redactLog } from "../src/index";

/**
 * `redactLog` is what makes "keys never leave your machine" true for a
 * `relay.log` a user chooses to attach to a feedback report - it runs here,
 * client-side, before any upload exists to run it against.
 *
 * The discipline that matters: every test below asserts the secret is
 * ABSENT from the output (`not.toContain`), never merely that some
 * replacement marker showed up. A redactor that is only ever checked for
 * producing a replacement can pass while still leaving the secret sitting
 * right next to it - that is the vacuous-guard shape this repo has been
 * bitten by before (see CLAUDE.md: a past redaction "masked the token field
 * and left the token in the URL").
 */

describe("removes each kind of secret, not just marks it", () => {
  it("removes a Deepgram-shaped key (40 hex characters)", () => {
    const secret = "a".repeat(40);
    const out = redactLog(`key=${secret}`);
    expect(out).not.toContain(secret);
  });

  it("removes a Gemini-shaped key (AIza + 35 chars)", () => {
    const secret = "AIzaSyD-0123456789abcdefghijklmnopqrstu";
    const out = redactLog(`GEMINI_API_KEY=${secret}`);
    expect(out).not.toContain(secret);
  });

  it("removes a relay token (32 hex - generateToken() is 16 random bytes, hex-encoded)", () => {
    const secret = crypto.randomBytes(16).toString("hex");
    expect(secret).toHaveLength(32);
    const out = redactLog(`publisherToken=${secret}`);
    expect(out).not.toContain(secret);
  });

  it("removes a token= query parameter carrying the token out of a URL", () => {
    const secret = crypto.randomBytes(16).toString("hex");
    const line = `wss://textrelay.cc/ws?token=${secret}`;
    const out = redactLog(line);
    expect(out).not.toContain(secret);
  });

  it("removes a key= query parameter carrying a key out of a URL", () => {
    const secret = "AIzaSyD-0123456789abcdefghijklmnopqrstu";
    const line = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${secret}`;
    const out = redactLog(line);
    expect(out).not.toContain(secret);
  });

  it("removes a query-parameter token even when its shape matches nothing else", () => {
    // a value that is neither hex nor AIza-shaped - only the query-parameter
    // rule (position-based, not shape-based) can catch this one
    const secret = "xk9-Qm2vT7bNc4Lp8HjWr1YsFo6DdAe0z";
    const line = `wss://relay.example.com/ws?token=${secret}`;
    const out = redactLog(line);
    expect(out).not.toContain(secret);
  });

  it("removes a 192.168.x.x RFC1918 address", () => {
    const secret = "192.168.8.187";
    const out = redactLog(`[relay] listening on http://${secret}:8787`);
    expect(out).not.toContain(secret);
  });

  it("removes a 10.x.x.x RFC1918 address", () => {
    const secret = "10.0.0.42";
    const out = redactLog(`peer connected from ${secret}`);
    expect(out).not.toContain(secret);
  });

  it("removes a 172.16-31.x.x RFC1918 address", () => {
    const secret = "172.20.5.9";
    const out = redactLog(`peer connected from ${secret}`);
    expect(out).not.toContain(secret);
  });

  it("does not touch a 172.x.x.x address outside the 16-31 RFC1918 band", () => {
    // 172.15 and 172.32 are public ranges - redacting them would be wrong,
    // not merely over-cautious
    expect(redactLog("upstream 172.15.9.9")).toContain("172.15.9.9");
    expect(redactLog("upstream 172.32.9.9")).toContain("172.32.9.9");
  });

  it("removes the Windows account name from an update path", () => {
    const secret = "omert";
    const line =
      "C:\\Users\\omert\\AppData\\Local\\@callout-relaystandalone-updater\\pending\\callout-relay-Setup-0.5.11.exe";
    const out = redactLog(line);
    expect(out).not.toContain(`Users\\${secret}\\`);
    // the rest of the path - the actually useful diagnostic content - survives
    expect(out).toContain("C:\\Users\\<user>\\AppData\\Local\\@callout-relaystandalone-updater\\pending\\");
  });

  it("tags a hex-shaped Windows account name <user>, not <redacted>", () => {
    // an account name that happens to look like a 32-hex token must still be
    // recognised as a username (by position - it sits right after \Users\)
    // and not be silently absorbed by the generic token rule first
    const hexUser = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
    expect(hexUser).toHaveLength(32);
    const line = `C:\\Users\\${hexUser}\\AppData\\Local\\Temp\\relay.log`;
    const out = redactLog(line);
    expect(out).not.toContain(hexUser);
    expect(out).toContain("C:\\Users\\<user>\\AppData\\Local\\Temp\\relay.log");
  });
});

describe("ordinary lines survive unchanged", () => {
  it("leaves a secret-free relay.log excerpt byte-identical, CRLF included", () => {
    // real shapes from the sample inspected for this task: an app log line, a
    // config/session summary, a GitHub release URL, an electron-updater
    // sha512+size line, and a v8/electron error-stack frame. None of these
    // are secrets, and mangling them would corrupt exactly the diagnostics
    // this feature exists to preserve.
    const sample = [
      "[relay] embedded relay listening on port 8787",
      "[session] source=YOU/CHAT channels=2 stt=deepgram-nova-3 translation=gemini-3.1-flash-lite",
      "[updater] checking https://github.com/imbafls/callout-relay/releases/latest",
      "[updater] sha512=k9Fq2Xr5MtSaVb1DhIe0RyOwZp3TsUl7NqKgXmC6VbYoHrJt9EaFd2PsQwLz8mN4jH7bC1sE0aWv6oQd3fUiT8gRk5cYb2z size=87563200",
      "Uncaught Exception: at Object.<anonymous> (node:electron/js2c/browser_init:2:12345)",
    ].join("\r\n");

    expect(redactLog(sample)).toBe(sample);
  });

  it("does not treat a lowercase /users/<id> REST path as a Windows account name", () => {
    // e.g. a GitHub API URL a future feature might log - "users" here is a
    // path segment, not %USERPROFILE%, and Windows always capitalizes its
    // own directory as "Users"
    const line = "GET https://api.github.com/users/imbafls -> 200";
    expect(redactLog(line)).toBe(line);
  });

  it("is stable when run twice - a redacted line has nothing left to redact", () => {
    const line = `key=${"a".repeat(40)} token=${crypto.randomBytes(16).toString("hex")}`;
    const once = redactLog(line);
    expect(redactLog(once)).toBe(once);
  });

  it("returns empty input unchanged", () => {
    expect(redactLog("")).toBe("");
  });
});
