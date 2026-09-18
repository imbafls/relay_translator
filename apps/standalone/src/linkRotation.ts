import { rotateRemoteLink } from "@callout-relay/companion";
import { rotateUrlFor } from "@callout-relay/shared";
import type { AppConfig, LinkRotation } from "@callout-relay/shared";

/**
 * NEW, START in the default link mode, and the tray's Rotate viewer link all
 * come here. Kept free of Electron - like transcripts.ts - so it runs under
 * plain Node against real relays, because the outcome it returns decides
 * whether the streamer is told the old link is dead.
 */
export async function rotateLinks(deps: {
  /** the embedded relay's own link: in-process, and it cannot fail */
  rotateLocal: () => void;
  config: () => AppConfig;
  saveViewerToken: (viewerToken: string) => void;
  log: (level: "info" | "warn" | "error", message: string) => void;
  timeoutMs?: number;
}): Promise<LinkRotation> {
  deps.rotateLocal();
  const cfg = deps.config();
  // the same address rule the phone link is built with: an address it would
  // not build a link from has no internet link to replace
  if (!cfg.relayUrl || !cfg.publisherToken || !rotateUrlFor(cfg.relayUrl)) return { remote: "none" };

  const result = await rotateRemoteLink(cfg.relayUrl, cfg.publisherToken, cfg.viewerToken, { timeoutMs: deps.timeoutMs });
  if (result.remote !== "rotated") {
    deps.log("error", `remote rotate ${result.remote}: ${result.reason}`);
    return result;
  }
  // The relay has replaced it, so the old link is dead whatever happens next.
  // A save that throws - a scanner holding config.json on Windows - must not
  // turn that into "the old one still works": ConfigStore sets its in-memory
  // copy before it writes, so the footer shows the new link anyway, and the
  // next uplink start pulls the relay's token back into the file.
  try {
    deps.saveViewerToken(result.viewerToken);
  } catch (err) {
    deps.log("error", `the new viewer link could not be saved: ${String((err as Error)?.message || err)}`);
  }
  return { remote: "rotated" };
}

/**
 * Whether the tray opens the viewer link after a rotation. It opens what the
 * footer shows, and with OUTPUT on OBS that is the local link, which rotated
 * in-process and is new whatever the relay said. Otherwise it is the phone link,
 * and opening one the relay did not confirm would look like the new link when
 * it may be the old one still working - or a dead one.
 */
export function trayOpensLink(rotation: LinkRotation, output: AppConfig["output"]): boolean {
  return rotation.remote === "none" || rotation.remote === "rotated" || output === "obs";
}
