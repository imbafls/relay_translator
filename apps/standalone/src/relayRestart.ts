import { relayRollbackPatch } from "@callout-relay/shared";
import type { AppConfig } from "@callout-relay/shared";

/**
 * A config change that touches the relay restarts it, and this decides what a
 * failed restart does to the change. Kept free of Electron, like
 * linkRotation.ts, so it runs under plain Node.
 */
export async function restartAfterConfigChange(deps: {
  /** whether the embedded relay was running before this change */
  relayWasUp: boolean;
  before: AppConfig;
  after: AppConfig;
  restart: () => Promise<void>;
  /** writes a patch to the stored config */
  store: (patch: Partial<AppConfig>) => void;
  log: (level: "info" | "warn" | "error", message: string) => void;
}): Promise<void> {
  try {
    await deps.restart();
  } catch (err) {
    // The write already happened - configStore.update is synchronous and runs
    // before the restart - so a port that cannot be bound is now the SAVED
    // port. Without putting it back, every START fails with "local relay not
    // ready" and a relaunch re-reads the same bad value and fails the same
    // way. The app is dead, permanently, from one typo.
    const reason = String((err as Error)?.message || err);
    // ...but only when there is a working relay to go back to. When the relay
    // was already down - its port held by something else since launch - the
    // old settings cannot run it either, and putting them back only destroys
    // what was typed: on a fresh install, the Deepgram key from setup step 1,
    // put back to nothing, with setup refusing to move on and the port that
    // would fix it in SETTINGS, which a first run cannot reach.
    if (!deps.relayWasUp) {
      deps.log(
        "error",
        `relay still could not start (${reason}) - keeping the new settings, since the relay was not running on the old ones either`,
      );
      throw new Error(`relay could not start: ${reason} - the settings were saved`);
    }
    deps.log("error", `relay restart failed (${reason}) - putting the previous relay settings back`);
    deps.store(relayRollbackPatch(deps.before, deps.after));
    try {
      await deps.restart();
      deps.log("info", "previous relay settings restored and the relay is up again");
    } catch (again) {
      deps.log("error", `could not restart on the previous settings either: ${String((again as Error)?.message || again)}`);
    }
    throw new Error(`relay could not restart: ${reason}`);
  }
}
