/**
 * The panel that says what changed, after the app has updated itself.
 *
 * Only the RENDERING moved. `showWhatsNewIfUpdated` stays in `app.ts` because it
 * is orchestration - it reads the bridge for the running version, the config for
 * the last one seen, and writes that back - and it is bound to module state this
 * file does not have. What is here takes a list of releases and builds the panel
 * out of them, which is the part with a shape worth pinning and no dependencies
 * beyond the DOM.
 *
 * Moved unchanged, so this is a relocation and nothing else.
 */

import type { ChangelogEntry } from "@callout-relay/shared";

import { $ } from "./dom";

const KIND_LABEL: Record<string, string> = { added: "NEW", fixed: "FIXED", changed: "CHANGED" };

export function renderWhatsNew(entries: ChangelogEntry[], from: string): void {
  const newest = entries[0];
  $("wnVersion").textContent = newest.version;
  $("wnHeadline").textContent = newest.headline;
  $("wnFrom").textContent = `UPDATED FROM ${from}`;

  const body = $("wnBody");
  body.innerHTML = "";
  for (const entry of entries) {
    const rel = document.createElement("div");
    rel.className = "wn-release";

    // the newest release's headline is already above the list; the older ones
    // in a multi-version jump still need naming
    if (entry !== newest) {
      const head = document.createElement("div");
      head.className = "wn-release-head";
      const ver = document.createElement("span");
      ver.className = "wn-release-ver";
      ver.textContent = entry.version;
      const date = document.createElement("span");
      date.className = "wn-release-date";
      date.textContent = entry.date;
      head.append(ver, date);
      rel.append(head);
    }

    for (const line of entry.changes) {
      const row = document.createElement("div");
      row.className = "wn-line";
      const kind = document.createElement("span");
      kind.className = "wn-kind";
      kind.dataset.kind = line.kind;
      kind.textContent = KIND_LABEL[line.kind] || line.kind.toUpperCase();
      const text = document.createElement("span");
      text.className = "wn-text";
      text.textContent = line.text;
      row.append(kind, text);
      rel.append(row);
    }
    body.append(rel);
  }
  $("whatsnew").hidden = false;
}
