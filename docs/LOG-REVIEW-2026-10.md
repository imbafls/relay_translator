# Log review, 2026-10-15: local model downloads on 1.0.0

Written before any code change, from the logs alone, plus reproduction attempts
on this machine. B6 in [`OPEN-WORK.md`](OPEN-WORK.md) has asked for exactly this
material since 2026-09-07; this is the first time it has come back from a build
that carries every fix B6 lists.

## Where the logs came from

| Source | Machine | Build | Span |
|--------|---------|-------|------|
| SEND FEEDBACK report `2026/10/15/6ce63721d1c6b101` (message "Everything"), read from the `callout-relay-feedback` bucket with `apps/hosted-relay/scripts/read-feedback.cjs` | the reporting PC | **1.0.0** | 2026-09-07 to 2026-10-15 |
| SEND FEEDBACK report `2026/09/15/91be23e1e9002b52` | same PC | 0.8.0 | its log section for 2026-09-15 |
| `%APPDATA%\callout-relay\relay.log` | this laptop (flsmobile) | 0.5.11 to 1.0.0 | 2026-09-07 to 2026-09-21 |

The laptop's own log stops on 2026-09-21 and has no download in it after
2026-09-15, so today's failure did not happen here. The report's log has a
different history (it starts on 0.5.11 at 15:09Z on 09-07 and updates at
different times), so it is the other PC. The app had already redacted user
names and LAN addresses (`<user>`, `<lan-ip>`); neither log holds a key or
token.

**Build.** The report says `appVersion: 1.0.0`, and the session that failed
opens with `update: Update for version 1.0.0 is not available`. 1.0.0 contains
both earlier fixes: `git merge-base --is-ancestor` confirms `f3f3d98` (0.5.13,
"Stop handing the decoder bytes the socket is about to overwrite") and
`516247f` (0.8.1, SHA-256 pins and a fresh staging folder per retry) are
ancestors of `v1.0.0`. **So this failure is not one of the bugs already fixed.**

## What failed, model by model (2026-10-15, 1.0.0)

Every failure is the bz2 decoder rejecting the archive. None is an HTTP error
(the code logs `HTTP <status>`, and there is none), a full disk (`needs N MB
free` - none), a publish lock (no attempt got that far) or a checksum
mismatch (the digest is only compared after a stream that decodes, and none did).

| Model (archive size) | Attempt | Stopped at (bytes read) | Decoder error |
|----------------------|---------|-------------------------|---------------|
| `local-nemotron-streaming` (475 MB) | 1 | 2,488,054 | `meow i'm a kitty, that's an error` (bad Huffman selector) |
| | 2 | - | `fetch failed` at byte 0, then `cancelled` 0.4 s later |
| `local-parakeet-tdt-0.6b-v2` (482 MB) | 1 | 2,932,352 | `Error in bzip2: crc32 do not match` |
| | 2 | 2,936,192 | `I'm a monkey and I'm throwing something at someone` (bad block pointer) |
| | 3 | 2,939,904 | `crc32 do not match` - **failed** |
| `local-whisper-tiny-en` (118 MB) | 1 | 53,147,563 | `I'm a monkey ...` |
| | 2 | 52,737,536 | `crc32 do not match` |
| | 3 | 53,152,128 | `I'm a monkey ...` - **failed** |
| | retry 1 | 52,737,878 | `crc32 do not match` |
| | retry 2 | 53,153,408 | `I'm a monkey ...` - **failed** |
| `local-nemotron-streaming` (475 MB), again | 1 | 2,488,054 | `meow i'm a kitty ...` |
| | 2 | 2,476,224 | `crc32 do not match` |
| | 3 | 2,483,776 | `meow i'm a kitty ...` - **failed** |

Quoted as logged (paths already redacted by the app):

```
[2026-10-15T15:20:08.013Z] [warn] model download: local-nemotron-streaming archive attempt 1 failed (the archive would not unpack (2488054 bytes read) - meow i'm a kitty, that's an error) - trying a fresh copy
[2026-10-15T15:20:08.029Z] [warn] model download: local-nemotron-streaming lost the connection at 0% - resuming from byte 0 (fetch failed)
[2026-10-15T15:23:19.082Z] [error] model download failed: local-parakeet-tdt-0.6b-v2 - the archive would not unpack (2939904 bytes read) - Error in bzip2: crc32 do not match
[2026-10-15T15:28:36.086Z] [error] model download failed: local-whisper-tiny-en - the archive would not unpack (53153408 bytes read) - I'm a monkey and I'm throwing something at someone, namely you
[2026-10-15T15:30:25.281Z] [warn] could not clean up C:\Users\<user>\AppData\Roaming\callout-relay\models\local-nemotron-streaming.part: EPERM: operation not permitted, lstat '...\local-nemotron-streaming.part\joiner.int8.onnx'
```

The same shape is in the older logs:

- 0.8.0 on the same PC, 2026-09-15: nemotron at 2,489,508 bytes (`meow i'm a
  kitty`), zipformer at 250,739,847 (`I'm a monkey`).
- 0.8.1 on this laptop, 2026-09-15: zipformer at 1,735,378, then 255,718,415
  and 250,215,559 (all `I'm a monkey`).
- 0.5.12 on this laptop, 2026-09-07: whisper tiny at 52,361,323 (`crc32`) -
  the aliasing bug 0.5.13 fixed, but at the same offset as today.

In the same session, on the same PC, the per-file Hugging Face model
`local-zipformer-en-20m` was already installed and **ran two local sessions**
(`stt open (local-zipformer-en-20m, en)` at 15:20:46 and 15:21:16). Per-file
downloads work on that machine; the GitHub archive path does not.

## Patterns

1. **The failure point belongs to the model, not to the attempt.** Each model
   stops within a few KB of the same place every time: nemotron at about 2.48 MB,
   parakeet at about 2.93 MB, whisper tiny at 52.7 to 53.2 MB. That holds
   across retries, across builds (0.8.0 and 1.0.0 for nemotron) and, for whisper
   tiny and zipformer, across both machines. A random dropped connection would
   not land in the same place every time.
2. **The decoded bits differ from attempt to attempt.** The error alternates
   between a CRC mismatch and two different structural errors at nearly the
   same offset. A corrupt file that never changes would fail the same way every
   time. So whatever goes wrong goes wrong a little differently each time, in
   the same region of the archive.
3. **Every retry's first request fails instantly.** Every fresh attempt after a
   decode failure logs `lost the connection at 0% - resuming from byte 0 (fetch
   failed)` 8 to 20 ms after it starts, then carries on after the backoff.
4. **Each failed attempt costs about 32 s, and its folder is never removed.**
   The decode fails within about a second (about 2.5 MB in), but the attempt is only
   logged as failed 32 s later: that is `rmDir`'s 12 retries (400 ms to 4.8 s)
   failing on `ENOTEMPTY`. At the end every staging folder fails with `EPERM:
   operation not permitted, lstat <file>`, which on Windows means the file is
   deleted but **a handle to it is still open**.
5. **No antivirus-style delay at publish, no disk-space problem, no HTTP
   status, no proxy error text.** None of those shapes appears anywhere.

## Reproduction on this machine (flsmobile, Defender on)

The real `ModelStore` from `apps/standalone/src/models.ts`, bundled with the
app's own esbuild settings, against the live GitHub assets:

| Runtime | Model | Result |
|---------|-------|--------|
| Node 22 | nemotron, stopped at 3% (14 MB) | no decode error |
| Electron 33.4.11 as Node | nemotron, stopped at 3% | no decode error |
| Electron 33.4.11 main process | whisper tiny, full | **installed in 22.5 s** |
| unbzip2-stream alone, sink slowed to force backpressure | nemotron, first 6 MB | no decode error |

**Not reproduced.** The same code on the same runtime decodes past every offset
the reporting PC fails at.

**One finding did reproduce:** cancelling a download in the Electron runtime
left the staging folder impossible to delete (`ENOTEMPTY`, then `EPERM ...
lstat`) until the process exited, after which Windows removed the files on its
own. The handle belongs to the app itself: the file that `tar` was writing when
the pipeline was torn down is never closed. Under plain Node the same cleanup
succeeds in 2.5 s. That is pattern 4. It does not cause the decode errors, but
it turns every failure into a 32 s wait and leaves `.part` folders behind until
the next restart.

## Ranked hypotheses

1. **The archive bytes the decoder receives on that PC are not the published
   bytes, in a region set by the archive's contents.** HTTPS rules out ordinary
   corruption in transit, so the bytes changed either before TLS was terminated
   (the CDN edge serving that network) or after it (security software that
   inspects HTTPS and rewrites archive streams, or something in the app
   triggered by that machine's timing). Patterns 1 and 2 together fit software
   that inspects the archive's contents better than they fit a corrupt CDN copy,
   which would fail identically every time. **The test that decides it** is to
   run this on that PC:

   ```powershell
   curl.exe -L -o "$env:TEMP\wt.tar.bz2" https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2
   (Get-FileHash "$env:TEMP\wt.tar.bz2" -Algorithm SHA256).Hash
   ```

   The pinned hash is
   `2BD6CF965C8BB3E068EF9FA2191387EE63A9DFA2A4E37582A8109641C20005DD`. A
   mismatch means the network or security software. A match means the app
   corrupts the bytes on that machine and not this one. Also worth knowing:
   which antivirus is installed there, and whether it scans HTTPS.
2. **Whatever the cause, it only reaches the stream-decode path.** Per-file
   Hugging Face downloads work on the same PC in the same session. The archive
   path is the only one that runs a pure-JS bz2 decoder (`unbzip2-stream`
   1.4.3, unmaintained, whose errors are jokes), untars while downloading, and
   cannot resume across a restart because it never writes the compressed bytes
   to disk. Removing that path from the default route removes this class of
   failure without having to know which half of hypothesis 1 is true.
3. **Leaked file handles after a failed or cancelled extract (confirmed
   here).** Secondary. Explains the 32 s stalls and the leftover `.part`,
   `.part-2` ... folders (pattern 4). It is a bug to fix in its own right.
4. **A flaky connection from that PC to GitHub's asset host.** Pattern 3 (a
   `fetch failed` at byte 0 on every retry) is real, but the resume logic
   absorbs it. It is not why the downloads fail.

**Ruled out by the logs:** disk space, HTTP 4xx/5xx, a stale catalogue URL, the
publish-time Defender lock 0.5.13 widened, a leftover staging folder blocking
the start (0.8.1's numbered folders are in use), and the 0.5.12 aliasing bug
(its fix is in 1.0.0).

## What this means for the fix

- Ship every catalogue model as individual files from a Hugging Face repo
  (`imbafls/callout-relay-models`), each with its own size and SHA-256, at a
  pinned commit. That is the path already proven on the failing PC, and it
  needs no bz2 or tar.
- Download each file straight into `<file>.part` and resume it with `Range`,
  including after an app restart. Hash the file on disk once it is complete.
- Keep the GitHub archive as the second mirror rather than deleting it, and fall
  through to it on a transport failure, a 4xx or a checksum mismatch. Close the
  extract's file handles when it fails, so a fallback attempt does not cost
  32 s and leave a folder behind.
- Every failure message names the model, the mirror, the status or errno, the
  bytes received and what to do next, and the model screen gets COPY
  DIAGNOSTICS. That way the next report answers this review's open question
  without anyone having to dig through the bucket.

## Addendum, 2026-10-17: the cause, reproduced

The mirror moved the failure without ending it. On FLS the test build fetched
Whisper Turbo's encoder as one plain file, with no bz2 involved, and its
SHA-256 came out wrong (`13aba2a3…`, not `b02dcdf5…`). `curl` on the same PC
fetched the right bytes. So hypothesis 1 was half right: the bytes the app holds
are not the bytes that arrived, but nothing outside the app changes them.

Narrowed on FLS over SSH, then reproduced here:

| Where the download code ran | Result |
|-----------------------------|--------|
| Node 24, Electron 33's Node (`ELECTRON_RUN_AS_NODE`), on both machines | correct |
| A bare Electron 33 main process, in the background session and in the desktop session | correct |
| **The full app**, its DOWNLOAD driven over DevTools with a throwaway profile | **wrong, every time**, via fetch and via `https` alike |
| The full app, each chunk written with `fs.writeSync` as it arrives | **correct**, Turbo and Nemotron at once |

The wrong file, compared with the good one, held 32-64 KB runs whose bytes
belonged 16 KB further on. Data that arrived later had been written over
chunks still waiting in the `fs.WriteStream` queue. The archive path holds
received chunks in the bz2 decoder's queue in the same way, which is why the
1.0 failures were decoder errors a couple of MB in.

**The fix:** `fetchFrom` writes each chunk synchronously the moment it arrives,
so no received buffer waits in memory. The precise mechanism inside the app's
main process (which of its other work makes queued buffers unsafe there and
nowhere else) is still not identified. The guard holds the shape that fixed it.
