import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tryLoadDotenv } from "../src/config";

/**
 * This is not only a dev convenience. cli.ts is the binary that runs on the
 * VPS, and it calls this on the directory beside itself - so this parses
 * /opt/callout-relay/.env, the file holding DEEPGRAM_API_KEY and
 * GEMINI_API_KEY. A value it reads slightly wrong is an API key that fails
 * authentication for a reason nothing on the box will explain.
 */

let dir: string;
const TOUCHED = [
  "TEST_DOTENV_A",
  "TEST_DOTENV_B",
  "TEST_DOTENV_QUOTED",
  "TEST_DOTENV_SQUOTED",
  "TEST_DOTENV_EQUALS",
  "TEST_DOTENV_EMPTY",
  "TEST_DOTENV_EXISTING",
  "TEST_DOTENV_HASH",
  "TEST_DOTENV_SPACED",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dotenv-"));
  for (const k of TOUCHED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

const load = (contents: string): void => {
  fs.writeFileSync(path.join(dir, ".env"), contents, "utf8");
  tryLoadDotenv([dir]);
};

describe("reading a .env", () => {
  it("takes a plain assignment", () => {
    load("TEST_DOTENV_A=hello\n");
    expect(process.env.TEST_DOTENV_A).toBe("hello");
  });

  it("takes several lines and skips blanks and comments", () => {
    load("# a comment\n\nTEST_DOTENV_A=one\n   \nTEST_DOTENV_B=two\n");
    expect(process.env.TEST_DOTENV_A).toBe("one");
    expect(process.env.TEST_DOTENV_B).toBe("two");
  });

  it("handles CRLF, which is how the file leaves a Windows machine", () => {
    load("TEST_DOTENV_A=one\r\nTEST_DOTENV_B=two\r\n");
    expect(process.env.TEST_DOTENV_A).toBe("one");
    expect(process.env.TEST_DOTENV_B).toBe("two");
  });

  it("strips surrounding quotes", () => {
    load('TEST_DOTENV_QUOTED="quoted"\nTEST_DOTENV_SQUOTED=\'single\'\n');
    expect(process.env.TEST_DOTENV_QUOTED).toBe("quoted");
    expect(process.env.TEST_DOTENV_SQUOTED).toBe("single");
  });

  it("keeps an equals sign inside a value", () => {
    load("TEST_DOTENV_EQUALS=a=b=c\n");
    expect(process.env.TEST_DOTENV_EQUALS).toBe("a=b=c");
  });

  it("allows an empty value", () => {
    load("TEST_DOTENV_EMPTY=\n");
    expect(process.env.TEST_DOTENV_EMPTY).toBe("");
  });

  it("does not overwrite something already in the environment", () => {
    process.env.TEST_DOTENV_EXISTING = "from-the-shell";
    load("TEST_DOTENV_EXISTING=from-the-file\n");
    expect(process.env.TEST_DOTENV_EXISTING).toBe("from-the-shell");
  });

  it("takes a line written as a shell export", () => {
    // .env files are regularly sourced by a shell as well, so they carry these
    load("export TEST_DOTENV_A=hello\n");
    expect(process.env.TEST_DOTENV_A).toBe("hello");
  });

  it("does nothing when there is no file", () => {
    tryLoadDotenv([path.join(dir, "nowhere")]);
    expect(process.env.TEST_DOTENV_A).toBeUndefined();
  });
});

describe("whitespace a real file picks up", () => {
  it("does not keep a trailing space in the value", () => {
    // a copy-pasted key regularly arrives with one, and a key with a space on
    // the end fails authentication while looking correct in every log
    load("TEST_DOTENV_SPACED=secret-key   \n");
    expect(process.env.TEST_DOTENV_SPACED).toBe("secret-key");
  });

  it("does not keep a trailing tab either", () => {
    load("TEST_DOTENV_A=secret-key\t\n");
    expect(process.env.TEST_DOTENV_A).toBe("secret-key");
  });

  it("does not keep a stray carriage return", () => {
    // a lone CR survives a split on /\r?\n/ when the file mixes endings
    load("TEST_DOTENV_A=secret-key\r\rTEST_DOTENV_B=other\n");
    expect(process.env.TEST_DOTENV_A).toBe("secret-key");
  });

  it("ignores space around the assignment itself", () => {
    load("TEST_DOTENV_A  =  hello\n");
    expect(process.env.TEST_DOTENV_A).toBe("hello");
  });

  it("keeps whitespace that was deliberately quoted", () => {
    load('TEST_DOTENV_QUOTED="  padded  "\n');
    expect(process.env.TEST_DOTENV_QUOTED).toBe("  padded  ");
  });
});
