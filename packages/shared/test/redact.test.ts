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

  it("removes a Gemini-shaped key ending in a hyphen (fix for finding 2)", () => {
    // the base64url alphabet AIza keys are drawn from includes "-", so
    // roughly 1 in 64 real keys end in one; the old /\bAIza[\w-]{35,60}\b/g
    // has a non-word char (the trailing "-") right before a word boundary
    // that can never anchor, so the whole key used to sail through verbatim
    const secret = "AIzaSyD_0123456789abcdefghijklmnopqrst-";
    const out = redactLog(`key ${secret}`);
    expect(out).not.toContain(secret);
  });

  it("removes a Gemini-shaped key longer than the old 60-character cap", () => {
    // the old rule's {35,60} upper bound made a total miss - not a partial
    // match - out of any key longer than 60 characters after "AIza"
    const secret = "AIza" + "x".repeat(61);
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

  it("redacts a widened query-parameter name like access_token, not just exact token/key (finding 7)", () => {
    const secret = "xk9-Qm2vT7bNc4Lp8HjWr1YsFo6DdAe0z";
    const line = `https://api.example.com/v1?access_token=${secret}`;
    const out = redactLog(line);
    expect(out).not.toContain(secret);
  });

  it("redacts apiKey via the widened query-parameter name pattern (finding 7)", () => {
    const secret = "xk9-Qm2vT7bNc4Lp8HjWr1YsFo6DdAe0z";
    const line = `https://x.example.com/y?apiKey=${secret}`;
    const out = redactLog(line);
    expect(out).not.toContain(secret);
  });

  it("redacts basic-auth credentials embedded in a URL (finding 7)", () => {
    const secret = "hunter2";
    const line = `https://user:${secret}@example.com/path`;
    const out = redactLog(line);
    expect(out).not.toContain(secret);
    expect(out).toBe("https://<redacted>@example.com/path");
  });

  it("redacts a basic-auth password containing '@', matching the LAST '@' in the authority (round 2 finding 3)", () => {
    // [^/\s:@]+ can't cross "@", so the old rule took the FIRST "@" where
    // URL parsing takes the last - "p@ss" partially survived as "ss" glued
    // onto the host. This is the exact shape :1226-1228's "never a partial
    // mask" invariant forbids.
    const secret = "p@ss";
    const line = `https://u:${secret}@example.com/x`;
    const out = redactLog(line);
    expect(out).not.toContain(secret);
    expect(out).not.toContain("ss@example"); // the leftover fragment shape from the bug
    expect(out).toBe("https://<redacted>@example.com/x");
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
    // finding 6: assert the secret is fully ABSENT, not merely that one
    // composed substring ("Users\<secret>\") is gone - a check that narrow
    // cannot see a second surviving occurrence of the same secret
    expect(out).not.toContain(secret);
    // the rest of the path - the actually useful diagnostic content - survives
    expect(out).toContain("C:\\Users\\<user>\\AppData\\Local\\@callout-relaystandalone-updater\\pending\\");
  });

  it("removes a lowercase c:\\users\\ Windows path (finding 3)", () => {
    const secret = "omert";
    const line = "c:\\users\\omert\\AppData\\Local\\Temp\\relay.log";
    const out = redactLog(line);
    expect(out).not.toContain(secret);
    expect(out).toBe("c:\\users\\<user>\\AppData\\Local\\Temp\\relay.log");
  });

  it("redacts a second occurrence of the account name elsewhere on the line (finding 4)", () => {
    const secret = "omert";
    const line = "C:\\Users\\omert\\AppData\\Local\\Temp\\omert-cache\\x";
    const out = redactLog(line);
    expect(out).not.toContain(secret);
    expect(out).toBe("C:\\Users\\<user>\\AppData\\Local\\Temp\\<user>-cache\\x");
  });

  it("removes the account name from a forward-slash macOS-style path (round 2 finding 1)", () => {
    // the round-1 fix for finding 3 required a drive letter, UNC prefix, or
    // backslash before Users/users - narrowing out the bare-"/" case the
    // original (9a54b4c) rule accepted. Restore it via a case-SENSITIVE
    // "Users" alternative so the lowercase REST-path collision this rule was
    // fixed to avoid (https://api.github.com/users/imbafls) still doesn't fire.
    const secret = "omert";
    const line = "/Users/omert/Library/Logs/relay.log";
    const out = redactLog(line);
    expect(out).not.toContain(secret);
    expect(out).toBe("/Users/<user>/Library/Logs/relay.log");
  });

  it("redacts every distinct account name on a line, not just the first (round 2 finding 4)", () => {
    const line =
      "C:\\Users\\alice\\AppData\\Local\\a; C:\\Users\\bob\\AppData\\Local\\Temp\\bob-cache";
    const out = redactLog(line);
    expect(out).not.toContain("alice");
    expect(out).not.toContain("bob");
    expect(out).toBe(
      "C:\\Users\\<user>\\AppData\\Local\\a; C:\\Users\\<user>\\AppData\\Local\\Temp\\<user>-cache",
    );
  });

  it("redacts a longer account name whole when a shorter one is its prefix", () => {
    // JS alternation takes the FIRST branch that succeeds, not the longest. So
    // if "bob" is collected before "bob-smith", `\b(?:bob|bob-smith)\b` matches
    // "bob" inside "bob-smith" - the trailing \b succeeds because "-" is a
    // non-word character - and the engine never backtracks to the longer
    // branch. "-smith" would then be published in the clear. A directory scan
    // returns names alphabetically, so "bob" before "bob-smith" is the ordinary
    // case, not a contrived one, and "jane-smith" is an ordinary account name.
    const line = "C:\\Users\\bob\\a; C:\\Users\\bob-smith\\b";
    const out = redactLog(line);
    expect(out).not.toContain("smith");
    expect(out).toBe("C:\\Users\\<user>\\a; C:\\Users\\<user>\\b");
  });

  it("does not double-mark when the account name is literally 'user' (round 2 finding 2)", () => {
    // \buser\b matches inside the just-written "<user>" marker itself
    // ("<" and ">" are non-word, so \b anchors right next to them), turning
    // a second pass into "<<user>>". Redaction must converge in one pass.
    const line = "C:\\Users\\user\\AppData";
    const out = redactLog(line);
    expect(out).toBe("C:\\Users\\<user>\\AppData");
    expect(redactLog(out)).toBe(out); // idempotent - no <<user>> on a second pass
  });

  it("does not double-mark a DIFFERENT earlier account when one of several names is literally 'user'", () => {
    // found while re-verifying finding 2's fix under multiple distinct
    // names (finding 4): a per-name loop that calls .replace() once per
    // captured name, one after another, runs each replace against the
    // OUTPUT of the previous one - so once "omert" has been rewritten to
    // "<user>", a later pass for a second account literally named "user"
    // matches the "user" text inside that already-written marker, same as
    // the single-name case above but reached through a different name.
    // Every captured name must be matched in one combined pass, against the
    // original text, before any marker exists.
    const line = "C:\\Users\\omert\\a; C:\\Users\\user\\b";
    const out = redactLog(line);
    expect(out).toBe("C:\\Users\\<user>\\a; C:\\Users\\<user>\\b");
    expect(redactLog(out)).toBe(out);
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

  describe("account names whose first or last character is not [A-Za-z0-9_] (fix-round-3 finding 2)", () => {
    // `\b(?:${alternation})\b` used ASCII `\b`, which only anchors at a
    // transition between a word character ([A-Za-z0-9_]) and a non-word one.
    // A name whose first or last character falls outside that class means
    // the transition the boundary needs never happens, so the whole
    // alternation fails to match and the name survives - everywhere on the
    // line, not just at the boundary itself.
    it("removes an account name with a leading accented letter (Ö)", () => {
      const secret = "Ömer";
      const line = `C:\\Users\\${secret}\\AppData\\Local\\pending`;
      const out = redactLog(line);
      expect(out).not.toContain(secret);
      expect(out).toBe("C:\\Users\\<user>\\AppData\\Local\\pending");
    });

    it("removes a CJK account name (no ASCII characters at all)", () => {
      const secret = "张伟";
      const line = `C:\\Users\\${secret}\\AppData\\Local`;
      const out = redactLog(line);
      expect(out).not.toContain(secret);
      expect(out).toBe("C:\\Users\\<user>\\AppData\\Local");
    });

    it("removes an account name ending in a non-word character (trailing '.')", () => {
      // the captured name is "omer." (the collector reads up to the next
      // path separator) - "." is non-word, and the character after it in
      // the path is "\", also non-word, so the trailing \b could never
      // anchor between two non-word characters either
      const secret = "omer.";
      const line = `C:\\Users\\${secret}\\AppData`;
      const out = redactLog(line);
      expect(out).not.toContain(secret);
      expect(out).toBe("C:\\Users\\<user>\\AppData");
    });

    it("is idempotent for a non-ASCII account name", () => {
      const line = "C:\\Users\\Ömer\\AppData\\Local\\pending";
      const once = redactLog(line);
      const twice = redactLog(once);
      expect(twice).toBe(once);
      expect(once).not.toContain("Ömer");
    });
  });

  describe("hosted-relay token (finding 1, CRITICAL) - apps/hosted-relay/src/tokens.ts", () => {
    // p1_<rid>_<secret> / v1_<rid>_<secret> - the secret half is exactly
    // generateToken()'s 32 hex, but "_" is a \w character, so the old
    // \b[0-9a-f]{32}\b rule could never anchor inside it and the whole
    // token sailed through untouched wherever it appeared.
    function hostedToken(kind: "p1" | "v1") {
      const rid = crypto.randomBytes(8).toString("hex"); // 16 hex chars
      const secret = crypto.randomBytes(16).toString("hex"); // 32 hex chars
      return { rid, secret, token: `${kind}_${rid}_${secret}` };
    }

    it("removes the secret from a v1 token in a /watch/ path", () => {
      const { secret, token } = hostedToken("v1");
      const line = `https://textrelay.cc/watch/${token}`;
      const out = redactLog(line);
      expect(out).not.toContain(secret);
    });

    it("removes the secret from a p1 token in a Bearer header", () => {
      const { secret, token } = hostedToken("p1");
      const line = `Authorization: Bearer ${token}`;
      const out = redactLog(line);
      expect(out).not.toContain(secret);
    });

    it("removes the secret from a p1 token inside a JSON body", () => {
      const { secret, token } = hostedToken("p1");
      const line = `{"publisherToken":"${token}"}`;
      const out = redactLog(line);
      expect(out).not.toContain(secret);
    });

    it("removes the secret from a p1 token in an env-shaped line", () => {
      const { secret, token } = hostedToken("p1");
      const line = `RELAY_PUBLISHER_TOKEN=${token}`;
      const out = redactLog(line);
      expect(out).not.toContain(secret);
    });
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
    // path segment, not %USERPROFILE%, and it has neither a drive letter nor
    // a backslash before it, unlike a real (even lowercased) Windows path
    const line = "GET https://api.github.com/users/imbafls -> 200";
    expect(redactLog(line)).toBe(line);
  });

  it("leaves a 64-hex sha256 checksum untouched (no 40- or 32-char slice taken)", () => {
    const sha256 = "2092615dc04874e4051066966782913064c9bfaa01bc241b37e46a2f562e087e";
    expect(sha256).toHaveLength(64);
    const line = `checksum sha256=${sha256}`;
    expect(redactLog(line)).toBe(line);
  });

  it("leaves a base64 sha512 digest untouched", () => {
    const sha512 = "lXdvTxe2RjwUa4rUJvpHXSAiI5+AlaQ4TyJaCed/CvEVWrSoUNr3Jpw1D4uc6OJvlOdaQqbUENydv0G4EJ0Blg==";
    const line = `sha512: ${sha512}`;
    expect(redactLog(line)).toBe(line);
  });

  it("redacts only the account name in a full electron-updater-style block", () => {
    const sha512 = "lXdvTxe2RjwUa4rUJvpHXSAiI5+AlaQ4TyJaCed/CvEVWrSoUNr3Jpw1D4uc6OJvlOdaQqbUENydv0G4EJ0Blg==";
    const sha256 = "2092615dc04874e4051066966782913064c9bfaa01bc241b37e46a2f562e087e";
    const block = [
      "C:\\Users\\omert\\AppData\\Local\\@callout-relaystandalone-updater\\pending\\callout-relay-Setup-0.5.11.exe",
      `sha512=${sha512} size=87563200`,
      `checksum sha256=${sha256}`,
      "releaseUrl https://github.com/imbafls/callout-relay/releases/latest",
    ].join("\r\n");
    const expected = block.replace("omert", "<user>");
    const out = redactLog(block);
    expect(out).not.toContain("omert");
    expect(out).toBe(expected);
  });

  it("is idempotent on an already-redacted query-parameter value, in a real URL (finding 5)", () => {
    // the old rule's value class excluded "<" and ">", so re-running it
    // against its own "<redacted>" marker matched a zero-width value and
    // PREPENDED a second marker instead of leaving the line alone. The old
    // test named for this used "key=<hex> token=<hex>" with no "?" or "&",
    // so the query rule it was meant to exercise never actually fired -
    // this uses a real URL so the query rule is the one under test.
    const secret1 = crypto.randomBytes(16).toString("hex");
    const secret2 = "a".repeat(40);
    const line = `wss://textrelay.cc/ws?token=${secret1}&key=${secret2}`;
    const once = redactLog(line);
    expect(once).not.toContain(secret1);
    expect(once).not.toContain(secret2);
    expect(once).toBe("wss://textrelay.cc/ws?token=<redacted>&key=<redacted>");
    const twice = redactLog(once);
    expect(twice).toBe(once);
  });

  it("returns empty input unchanged", () => {
    expect(redactLog("")).toBe("");
  });

  it("is idempotent (x1 = x2 = x3) across all four round-2 fixes at once", () => {
    const line = [
      "/Users/omert/Library/Logs/relay.log", // finding 1: forward-slash path
      "C:\\Users\\user\\AppData", // finding 2: account name literally "user"
      "https://u:p@ss@example.com/x", // finding 3: '@' inside the password
      "C:\\Users\\alice\\a; C:\\Users\\bob\\Temp\\bob-cache", // finding 4: two names
    ].join("\r\n");
    const x1 = redactLog(line);
    const x2 = redactLog(x1);
    const x3 = redactLog(x2);
    expect(x1).toBe(x2);
    expect(x2).toBe(x3);
    expect(x1).not.toContain("omert");
    expect(x1).not.toContain("p@ss");
    expect(x1).not.toContain("alice");
    expect(x1).not.toContain("bob");
  });
});
