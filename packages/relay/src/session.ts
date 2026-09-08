import {
  Languages,
  ServerToViewer,
  SubtitleLatency,
  ServerToPublisher,
  clampChannels,
  isLocalStt,
  maskProfanity,
  DEFAULT_CONFIG,
} from "@callout-relay/shared";
import {
  SAMPLE_RATE,
  createDeepgramStream,
  createMockSttStream,
  SttEvents,
  SttStream,
} from "./deepgram";
import { createLocalSttStream, LocalSttOptions } from "./localStt";
import {
  createGeminiTranslator,
  createMockTranslator,
  Translator,
} from "./gemini";

export interface SessionConfig {
  stt: string;
  translation: string;
  languages: Languages;
  /** false = skip Gemini, source-language subtitles only */
  translationEnabled: boolean;
  /** false = strip latency badges from viewer broadcasts (publisher echo keeps them) */
  latencyVisible: boolean;
  /** true = mask profanity in source captions sent to viewers (publisher echo
   *  keeps the words as heard, same split as `latencyVisible`) */
  profanityFilter: boolean;
  /** 1 or 2 interleaved capture channels */
  channels: number;
  /** speaker tag per channel (only sent when channels > 1) */
  channelLabels?: string[];
  /** `#rrggbb` per channel, already sanitised by the hello parser */
  channelColors?: string[];
  /** what viewers are told this stream is called; already sanitised */
  brandName?: string;
  /** `#rrggbb`, already sanitised by the hello parser */
  brandColor?: string;
}

/**
 * Capture posts a frame every 100 ms while it is running, so five missed in a
 * row is a real stall rather than delivery jitter.
 */
/**
 * How often a translation failure is worth repeating. Long enough that a
 * flapping translator does not fill the log, short enough that a wall the user
 * hits mid-session is reported again rather than swallowed by a transient one
 * from minute 1.
 */
const TRANSLATE_ERROR_EVERY_MS = 30_000;

/**
 * How long to wait before each attempt to reopen a speech stream that closed on
 * its own. There was no reconnect anywhere in this package - only gemini.ts had
 * a retry ladder - so a socket dropped by a blip, an idle timeout or a moment
 * of bad wifi ended captions for the entire session, and the only way back was
 * for the streamer to notice and restart.
 *
 * Starts fast because this is a live tool and a caption missed is gone, then
 * backs off so a genuinely dead engine is not hammered. Running out of the
 * list no longer means giving up - it switches the session onto
 * STT_REOPEN_TAIL_MS's slow, endless tail instead.
 */
const STT_REOPEN_DELAYS_MS = [300, 1_000, 3_000, 8_000];

/**
 * After the fast ladder is spent we keep trying, for ever, at this interval.
 * A captioning tool that has already lost captions has nothing left to protect
 * by staying down, and the thing that ends a session is a person pressing STOP.
 * Before this, four failures inside ~12 s - which is what an offline machine
 * produces, since the connect fails on DNS in milliseconds rather than waiting -
 * ended captions permanently for that session.
 */
const STT_REOPEN_TAIL_MS = 30_000;

const GAP_MS = 500;

/**
 * A chunk's peak sample has to clear this many units, out of a possible
 * 32767, to count as "audio" for the idle-billing gate in `audio()`. Chosen
 * low on purpose - about -47 dBFS. Digital silence from a loopback / Stereo
 * Mix source with nothing playing reads as exact zero, or at most a few LSBs
 * of mixer noise, nowhere near this; a real voice, even a quiet or distant
 * one, clears it easily. The failure mode worth documenting for whoever
 * tunes this later is the other direction: set it too high and a genuinely
 * quiet speaker gets billed silence and their captions stop, which is worse
 * than the bug this gate exists to fix.
 */
const SILENCE_PEAK_FLOOR = 150;

/**
 * Peak absolute sample in a chunk of 16-bit signed PCM (interleaved across
 * however many channels this session captures - a real sample on any one of
 * them is enough to call the chunk "audio").
 *
 * Peak, not RMS. RMS averages a whole chunk's energy down, so a chunk that is
 * mostly quiet with one loud burst at the very end - the onset of a word
 * after a pause - can read as below the floor even though real speech is
 * sitting right there. Peak catches that first sample. It is also the
 * cheaper of the two: one comparison per sample, no multiply-accumulate and
 * no square root.
 */
function peakAmplitude(chunk: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < chunk.length; i += 2) {
    const sample = chunk.readInt16LE(i);
    const abs = sample < 0 ? -sample : sample;
    if (abs > peak) peak = abs;
  }
  return peak;
}

export interface GeminiStats {
  count: number;
  cacheHits: number;
  tokensIn: number;
  tokensOut: number;
}

export interface SttStats {
  /** seconds of audio billed by Deepgram (channels multiply) */
  seconds: number;
  /** seconds of audio transcribed on this PC */
  localSeconds: number;
}

export interface SessionDeps {
  deepgramApiKey?: string;
  geminiApiKey?: string;
  /** true = canned gameplay callouts; an array = say exactly these, in order */
  mockStt?: boolean | string[];
  mockGemini?: boolean;
  /** stand in for Gemini (tests, and any embedder that brings its own engine) */
  translator?: Translator;
  /**
   * Stand in for the STT socket itself. Everything the session does with the
   * stream stays real; only the connection is supplied. This is what lets a
   * test kill the stream the way Deepgram does - `mockStt` never closes, and
   * without a seam the only way to reach the close path was to dial the real
   * service from a test and hope it hung up.
   */
  /**
   * How long to wait before each attempt to reopen a closed speech stream.
   * Defaults to STT_REOPEN_DELAYS_MS. An embedder can tune it; the tests use a
   * short ladder so the give-up path can be reached without a twelve-second
   * test, which is the only honest way to cover the end of it.
   */
  sttReopenDelaysMs?: readonly number[];
  makeStt?(events: SttEvents): SttStream;
  /** where local models live + the worker script; absent = local STT unavailable */
  localStt?: LocalSttOptions;
  /** fan-out to all viewers */
  toViewers(msg: ServerToViewer): void;
  /** echo subtitles to the publisher (in-app live log) */
  toPublisher?(msg: Extract<ServerToPublisher, { type: "subtitle" | "partial" }>): void;
  /** aggregate translation usage (process lifetime) */
  geminiStats?: GeminiStats;
  /** aggregate STT audio (process lifetime) */
  sttStats?: SttStats;
  /** STT engine errors, forwarded to the publisher's app log */
  onSttError?(message: string): void;
  /**
   * Translation errors, on the same channel. There was no hook at all: a
   * translator that had stopped working was one line to a console nobody in a
   * packaged build can see, while viewers watched the target half of every
   * caption sit on its placeholder.
   */
  onTranslateError?(message: string): void;
  setLive(live: boolean): void;
  log(level: "info" | "warn" | "error", message: string): void;
  /**
   * Minutes of unbroken silence - measured locally, per chunk peak against
   * SILENCE_PEAK_FLOOR, never from STT finals - before `audio()` stops
   * forwarding to the STT engine and stops counting billed seconds. `0`
   * disables the bound entirely. Undefined falls back to
   * `DEFAULT_CONFIG.idleBillingStopMinutes` (60), so an embedder that never
   * sets this still gets the bound rather than an unmetered leak.
   */
  idleBillingStopMinutes?: number;
}

/**
 * One publisher session: PCM in -> STT finals -> Gemini -> viewer broadcast.
 * Source text goes out immediately (final:true, no target) so viewers see it
 * within the STT budget; the translation patches the same segment id.
 *
 * With two capture channels every channel has its own interim segment id so
 * "YOU" and "CHAT" can talk over each other without clobbering one another.
 */
export class PublisherSession {
  private segId = 0;
  /** id reserved for the interim line of each channel */
  private pendingId: (number | undefined)[] = [];
  private stt: SttStream | null = null;
  private translator: Translator | null = null;
  private inflight = 0;
  /**
   * When the last translation failure was reported, not WHETHER one has been.
   *
   * It was a boolean that latched for the life of the session and was never
   * reset. One transient 503 in minute 1 burned it, and the Gemini quota wall in
   * minute 40 was then completely silent - every translate() rejecting, every
   * viewer's target half stuck on the placeholder, and nothing said anywhere.
   * Reporting every failure would be its own noise, so it is rate-limited
   * instead of latched.
   */
  private lastTranslateErrorAt = 0;
  /** how many times the speech stream has been reopened since it last worked */
  private sttReopens = 0;
  /**
   * Whether the session has already announced entry into the endless retry
   * tail. Set once, the first time the fast ladder is exhausted; cleared by
   * onOpen, which is the only way out short of stop().
   *
   * Fix-round Finding 2: without this, the whole reopen-failure cycle - the
   * "closed unexpectedly" warn, the "speech pipeline lost" viewer broadcast,
   * the give-up line, and onError's own line for whatever actually failed -
   * repeated every STT_REOPEN_TAIL_MS forever. On a real offline machine
   * that is ~295 bytes/cycle, about 850 KB/day, enough to evict the give-up
   * line itself - and everything logged before it - from the 1 MB relay.log
   * within about a day. A later feature uploads relay.log on request; a log
   * that is nothing but retry churn is worthless exactly when that matters.
   * A viewer does not need "speech pipeline lost" repeated at it for a week
   * either - a viewer who joins mid-outage gets the true state from its own
   * hello (server.ts's `stamp()`/`isLive()`), which reads `sttLive` and is
   * unaffected by any of this.
   */
  private sttDegraded = false;
  private reopenTimer: ReturnType<typeof setTimeout> | null = null;
  /** rebuilt on every open, so a reconnect uses the same handlers */
  private sttEvents: SttEvents | null = null;
  private closing = false;
  /**
   * Wall clock of the session's first audio byte. Kept only to gate the
   * mute-gap check below against a false gap on that very first frame
   * (`lastAudioAt` starts at 0, which is not a real timestamp to diff
   * against). NOT used for latency any more - see `currentStreamWallStart`.
   */
  private streamWallStart = 0;
  /**
   * Wall clock of the moment the CURRENT speech stream opened. STT word
   * timings (`audioEndSec`) restart at zero on every new stream - Deepgram's
   * word `end` on a fresh socket, the local worker's `fed / SAMPLE_RATE` on a
   * freshly constructed state - and the reopen ladder builds that new stream
   * without touching `streamWallStart`. So the latency arithmetic has to
   * measure from here, stamped fresh in `onOpen` on every open including
   * reopens, not from the session's own start.
   */
  private currentStreamWallStart = 0;
  /** wall clock of the most recent audio byte */
  private lastAudioAt = 0;
  /**
   * How long the publisher sent no audio at all - muted, or capture stalled.
   * The STT clock cannot advance across a gap but the wall clock does, so
   * without this every latency figure for the rest of the session reads the
   * total muted time too high.
   */
  private silentMs = 0;
  /**
   * Wall clock of the last chunk whose peak cleared SILENCE_PEAK_FLOOR.
   * Seeded on the session's first chunk regardless of whether it was loud -
   * same reason `streamWallStart` is seeded rather than left at 0: diffing
   * against the epoch on the very first chunk would read as the session
   * having been silent since 1970 and trip the bound immediately.
   */
  private lastAboveFloorAt = 0;
  /**
   * Whether chunks are currently being forwarded to the STT engine and
   * counted toward billed seconds. Flips to false once
   * `idleBillingStopMinutes` of unbroken silence has passed, and back to
   * true the instant a chunk clears the floor again - see `audio()`. This is
   * the ONLY thing the idle-billing gate touches: the session stays live,
   * capture keeps running, and powerSaveBlocker is untouched, so a streamer
   * who stepped away for lunch gets working captions again the moment they
   * start talking, not a session they have to notice is dead and restart.
   */
  private billingOpen = true;
  /** whether Gemini runs for this session */
  translates = true;
  readonly local: boolean;

  constructor(
    private readonly cfg: SessionConfig,
    private readonly deps: SessionDeps,
    /**
     * Where to continue numbering segments from.
     *
     * Viewers key their caption rows by segment id and nothing tells them to
     * start again, so a session that restarts at 0 hands out ids the viewer is
     * already showing: the next caption rewrites an existing row in place,
     * under the old line's timestamp, and the line it replaced is gone. A
     * settings change mid-stream is enough to trigger it, since that rebuilds
     * the session without kicking anyone.
     */
    startSegId = 0,
  ) {
    this.local = isLocalStt(cfg.stt);
    this.segId = startSegId;
  }

  /** the last segment id handed out, so a replacement can carry on from it */
  get lastSegId(): number {
    return this.segId;
  }

  private tag(channel: number): { channel?: number; speaker?: string; color?: string } {
    if (this.cfg.channels <= 1) return {};
    const color = this.cfg.channelColors?.[channel];
    return {
      channel,
      speaker: this.cfg.channelLabels?.[channel] || `CH${channel + 1}`,
      // absent rather than a default: the viewer has its own, and a colour
      // this end could not name is not one this end should invent
      ...(color ? { color } : {}),
    };
  }

  /**
   * Source text as an audience should see it. Everything fanned out to viewers
   * goes through here - the phone link, the OBS overlay, and the uplink, which
   * bridges the same viewer broadcast up to the remote relay.
   *
   * The publisher echo deliberately does not: the streamer's own console shows
   * what the STT actually heard, which is the only place a mishearing can be
   * spotted. Same split as `latencyVisible`.
   */
  private forViewers(text: string): string {
    return this.cfg.profanityFilter === false ? text : maskProfanity(text);
  }

  start(): void {
    const { source, target } = this.cfg.languages;
    const translates = this.cfg.translationEnabled !== false;
    this.translates = translates;

    this.translator = !translates
      ? null
      : this.deps.translator
        ? this.deps.translator
        : this.deps.mockGemini || !this.deps.geminiApiKey
        ? createMockTranslator(target)
        : createGeminiTranslator({
            apiKey: this.deps.geminiApiKey!,
            model: this.cfg.translation || "gemini-3.1-flash-lite",
            source,
            target,
            stats: this.deps.geminiStats
              ? {
                  onUse: (use) => {
                    const s = this.deps.geminiStats!;
                    if (use.cached) s.cacheHits += 1;
                    else {
                      s.count += 1;
                      s.tokensIn += use.tokensIn;
                      s.tokensOut += use.tokensOut;
                    }
                  },
                }
              : undefined,
          });

    const events = {
      onOpen: () => {
        // this stream's word timings (audioEndSec) start counting from here,
        // not from whenever the session itself started - see
        // currentStreamWallStart's own comment. Stamped on every open,
        // including reopens, which is the whole fix.
        this.currentStreamWallStart = Date.now();
        // a stream that opened is a stream that works: the ladder starts again
        // from the top next time, rather than a session slowly using it up
        this.sttReopens = 0;
        // and it is out of the degraded tail, so the next loss narrates
        // again rather than staying quiet on the strength of an outage that
        // is now over
        this.sttDegraded = false;
        this.deps.log(
          "info",
          `stt open (${this.cfg.stt}, ${source}${this.cfg.channels > 1 ? `, ${this.cfg.channels} channels` : ""})`,
        );
        this.deps.toViewers({ type: "status", live: true });
        this.deps.setLive(true);
      },
      onPartial: (text: string, channel: number) => {
        if (this.closing) return;
        if (this.pendingId[channel] === undefined) this.pendingId[channel] = ++this.segId;
        const id = this.pendingId[channel]!;
        const tag = this.tag(channel);
        // partials flash on the broadcast as they stream, so they have to be
        // masked too - filtering only the finals shows the word and then tidies
        // it up a moment later, which reads as deliberate
        this.deps.toViewers({ type: "partial", id, source: this.forViewers(text), ...tag });
        this.deps.toPublisher?.({ type: "partial", id, source: text, ...tag });
      },
      onFinal: (text: string, meta: { audioEndSec?: number; channel: number }) => {
        const channel = meta.channel;
        const id = this.pendingId[channel] ?? ++this.segId;
        this.pendingId[channel] = undefined;
        const tag = this.tag(channel);
        const finalAt = Date.now();
        const sttMs =
          meta.audioEndSec !== undefined && this.currentStreamWallStart > 0
            ? Math.max(0, Math.round(finalAt - this.currentStreamWallStart - this.silentMs - meta.audioEndSec * 1000))
            : undefined;
        const latency: SubtitleLatency = sttMs !== undefined ? { stt: sttMs } : {};
        const viewerLatency = this.cfg.latencyVisible !== false ? latency : undefined;
        this.deps.toViewers({
          type: "subtitle",
          id,
          source: this.forViewers(text),
          final: true,
          latency: viewerLatency,
          ...tag,
        });
        this.deps.toPublisher?.({ type: "subtitle", id, source: text, latency, ...tag });
        if (!this.translator) return;
        this.inflight += 1;
        this.translator
          .translate(text)
          .then((targetText) => {
            const full: SubtitleLatency = {
              ...latency,
              translate: Math.round(Date.now() - finalAt),
            };
            this.deps.toViewers({
              type: "subtitle",
              id,
              // Gemini is given the unmasked line above, so the translation is
              // of what was actually said. Only the source shown to viewers is
              // masked; the target is not filtered.
              source: this.forViewers(text),
              target: targetText,
              final: true,
              latency: this.cfg.latencyVisible !== false ? full : undefined,
              ...tag,
            });
            this.deps.toPublisher?.({ type: "subtitle", id, source: text, target: targetText, latency: full, ...tag });
          })
          .catch((err) => {
            const now = Date.now();
            if (now - this.lastTranslateErrorAt < TRANSLATE_ERROR_EVERY_MS) return;
            this.lastTranslateErrorAt = now;
            const message = `translation failed: ${err.message}`;
            this.deps.log("error", message);
            this.deps.onTranslateError?.(message);
          })
          .finally(() => {
            this.inflight -= 1;
          });
      },
      onError: (message: string) => {
        // once the session is already known to be in the degraded tail,
        // every reopen attempt fails for the same underlying reason (an
        // offline machine's DNS lookup, a still-missing local model) and
        // this would otherwise fire on the same cadence as the tail itself
        if (this.sttDegraded) return;
        this.deps.log("error", `stt error: ${message}`);
        this.deps.onSttError?.(message);
      },
      onClose: () => {
        if (this.closing) return;
        // captured before anything below can flip it - true here means the
        // pipeline was already known to be down when this close came in, so
        // this cycle has nothing new to say (see sttDegraded's own comment)
        const alreadyDegraded = this.sttDegraded;
        if (!alreadyDegraded) {
          // onError reached the app and onClose did not, so the failure that
          // matters most - the socket simply going away, on a quota or an
          // idle timeout - was the one nobody was told about. The desktop
          // stayed ON AIR with the clock running and every chunk quietly
          // dropped.
          this.deps.log("warn", "stt closed unexpectedly");
          this.deps.toViewers({ type: "status", live: false, message: "speech pipeline lost" });
        }
        this.deps.setLive(false);

        const ladder = this.deps.sttReopenDelaysMs ?? STT_REOPEN_DELAYS_MS;
        const delay = ladder[this.sttReopens];
        if (delay === undefined) {
          // the fast ladder is spent. A session that has already lost
          // captions has nothing left to protect by staying down, so this
          // does not return: it keeps retrying, for ever, on the long tail -
          // the only thing that ends a session is a person pressing STOP.
          // sttReopens keeps climbing past the ladder's own length so the
          // message can say how many attempts have actually been made.
          this.sttReopens += 1;
          if (!this.sttDegraded) {
            // the transition into the tail, and the only time this cycle's
            // outcome gets narrated - every cycle after this one repeats for
            // the same reason, which is not news
            this.sttDegraded = true;
            const message = `speech pipeline exhausted ${ladder.length} fast attempts - now retrying every ${Math.round(STT_REOPEN_TAIL_MS / 1_000)}s (attempt ${this.sttReopens}) until stopped`;
            this.deps.log("error", message);
            this.deps.onSttError?.(message);
          }
          this.armReopen(source, STT_REOPEN_TAIL_MS);
          return;
        }
        this.sttReopens += 1;
        this.deps.onSttError?.(
          `speech pipeline closed - reconnecting (attempt ${this.sttReopens} of ${ladder.length})`,
        );
        this.armReopen(source, delay);
      },
    };
    this.sttEvents = events;

    this.openStt(events, source);
  }

  /**
   * Schedule the next reopen attempt. Shared by the fast ladder and its
   * endless tail so the two cannot drift apart on how a reconnect actually
   * fires - only the delay differs.
   */
  private armReopen(source: string, delay: number): void {
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      if (this.closing || !this.sttEvents) return;
      try {
        this.openStt(this.sttEvents, source);
      } catch (err) {
        // Fix-round Finding 4. Not reachable through this package's own
        // engines today - every guarded failure inside openStt returns a
        // fail() stub rather than throwing - but a custom `makeStt` is an
        // embedder's own code, and the guarantee this session now makes is
        // that the reopen chain never terminates. A synchronous throw here
        // is the one way left to end it silently: reopenTimer is already
        // null above, and without this nothing would ever re-arm it. Land
        // on the tail rather than try to reconstruct where the fast ladder
        // was - a reopen that throws synchronously is not the transient
        // kind that ladder is for.
        if (!this.sttDegraded) {
          this.sttDegraded = true;
          const reason = err instanceof Error ? err.message : String(err);
          this.deps.log(
            "error",
            `speech pipeline reopen threw - retrying every ${Math.round(STT_REOPEN_TAIL_MS / 1_000)}s: ${reason}`,
          );
        }
        this.armReopen(source, STT_REOPEN_TAIL_MS);
      }
    }, delay);
  }

  /**
   * Build the speech stream. Called from start(), and again by the reconnect
   * ladder - which is why it takes the events rather than closing over them.
   */
  private openStt(events: SttEvents, source: string): void {
    const channels = clampChannels(this.cfg.channels);
    if (this.deps.makeStt) {
      this.stt = this.deps.makeStt(events);
    } else if (this.deps.mockStt) {
      this.stt = createMockSttStream(
        events,
        channels,
        Array.isArray(this.deps.mockStt) ? this.deps.mockStt : undefined,
      );
    } else if (this.local) {
      if (!this.deps.localStt) {
        // the worst case Finding 2 named: genuinely unrecoverable, so every
        // reopen attempt lands right back here. Once the tail has already
        // announced it once, repeating this exact line every cycle for ever
        // is exactly the flooding this gate exists to stop.
        if (!this.sttDegraded) {
          this.deps.log("error", "local STT requested but this relay has no local model support");
        }
        setImmediate(() => events.onClose?.());
        this.stt = { sendAudio: () => false, close() {} };
      } else {
        this.stt = createLocalSttStream(
          this.deps.localStt,
          { model: this.cfg.stt, language: source, channels },
          events,
        );
      }
    } else if (!this.deps.deepgramApiKey) {
      this.stt = createMockSttStream(events, channels);
    } else {
      this.stt = createDeepgramStream(
        {
          apiKey: this.deps.deepgramApiKey,
          model: this.cfg.stt || "deepgram-nova-3",
          language: source,
          channels,
        },
        events,
      );
    }
  }

  /** sample rate expected from the publisher */
  get sampleRate(): number {
    return SAMPLE_RATE;
  }

  audio(chunk: Buffer): void {
    const now = Date.now();
    if (this.streamWallStart === 0) this.streamWallStart = now;
    else if (now - this.lastAudioAt > GAP_MS) this.silentMs += now - this.lastAudioAt;
    this.lastAudioAt = now;

    // Idle-billing gate. Runs on every chunk, whether or not forwarding is
    // currently open - that is what makes recovery possible. A design gated
    // on STT finals instead cannot work: once forwarding stops, no audio
    // reaches the engine, so no final can ever arrive to turn it back on and
    // the session would be wedged silent for ever. Locally-measured level has
    // no such trap, and it targets the real failure mode more precisely
    // anyway - a loopback source streaming digital silence after the game
    // closed - since a streamer speaking a language the engine mistranscribes
    // is still producing audio worth paying for.
    if (this.lastAboveFloorAt === 0) this.lastAboveFloorAt = now;
    if (peakAmplitude(chunk) > SILENCE_PEAK_FLOOR) {
      const wasClosed = !this.billingOpen;
      this.lastAboveFloorAt = now;
      this.billingOpen = true;
      if (wasClosed) {
        this.deps.log("info", "audio above the silence floor again - resuming billed transcription");
      }
    } else {
      const idleMinutes = this.deps.idleBillingStopMinutes ?? DEFAULT_CONFIG.idleBillingStopMinutes ?? 0;
      if (idleMinutes > 0 && this.billingOpen && now - this.lastAboveFloorAt >= idleMinutes * 60_000) {
        this.billingOpen = false;
        const silentMinutes = Math.round((now - this.lastAboveFloorAt) / 60_000);
        // written once, on the transition - not on every silent chunk after
        // it, which at capture's own chunk rate would flood relay.log and
        // evict everything before it long before this line was ever read
        this.deps.log(
          "error",
          `no audio above the silence floor for ${silentMinutes}m - pausing billed transcription until sound returns`,
        );
      }
    }
    // gate stops here: nothing below this line runs while it is shut, which
    // is what actually stops the spend - the STT engine never sees these
    // bytes, and the stats block below (the only place seconds are counted)
    // never runs either
    if (!this.billingOpen) return;

    // bill what was actually sent. This ran before the send and ignored its
    // result, so a stream that had closed under us kept charging for audio the
    // readyState guard was dropping on the floor.
    const sent = this.stt?.sendAudio(chunk) ?? false;
    if (sent && this.deps.sttStats) {
      // bytes -> seconds of (mono-equivalent) audio; Deepgram bills every channel
      const seconds = chunk.length / (SAMPLE_RATE * 2 * Math.max(1, this.cfg.channels));
      if (this.local) this.deps.sttStats.localSeconds += seconds;
      else this.deps.sttStats.seconds += seconds * Math.max(1, this.cfg.channels);
    }
  }

  stop(): void {
    if (this.closing) return;
    this.closing = true;
    // a reopen armed by the ladder would otherwise fire into a stopped session
    if (this.reopenTimer) {
      clearTimeout(this.reopenTimer);
      this.reopenTimer = null;
    }
    try {
      this.stt?.close();
    } catch {
      /* noop */
    }
    this.stt = null;
    this.deps.setLive(false);
  }

  /**
   * Wait for translations that were already in flight when the session stopped.
   * The last thing said before STOP finals late, so its translation is usually
   * still running; without this it races whoever is tearing the session down.
   * Resolves with the number still outstanding, which is 0 unless the timeout
   * won - a wedged translator must not hold a shutdown open.
   */
  async drain(timeoutMs = 5000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.inflight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.inflight;
  }
}
