import streamDeck, {
  action,
  Action,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import { ControlClient } from "@callout-relay/companion";
import { ControlStatus } from "@callout-relay/shared";

const client = new ControlClient(`http://127.0.0.1:47477`, "streamdeck-plugin");

function isLive(status: ControlStatus | null): boolean {
  return status?.session.state === "live";
}

/**
 * Toggle key: starts/stops the companion session. Mirrors live state via
 * the control API's SSE stream so the key stays in sync no matter who
 * started the session (app button, tray, or another Stream Deck press).
 */
@action({ UUID: "com.callout-relay.toggle" })
class ToggleAction extends SingletonAction {
  private status: ControlStatus | null = null;
  private instances = new Set<Action>();

  constructor() {
    super();

    client.onStatus((status) => {
      this.status = status;
      this.renderAll();
    });

    // initial fetch + retry while the app isn't up yet
    const poll = (): void => {
      client
        .status()
        .then((s) => {
          this.status = s;
          this.renderAll();
        })
        .catch(() => {
          this.status = null;
          this.renderAll();
        });
    };
    poll();
    setInterval(poll, 10000);
  }

  private renderAll(): void {
    const live = isLive(this.status);
    for (const action of this.instances) {
      void action.setState(live ? 1 : 0);
      void action.setTitle(live ? "LIVE" : "RELAY");
    }
  }

  override onWillAppear(ev: WillAppearEvent<object>): void {
    this.instances.add(ev.action);
    void ev.action.setState(isLive(this.status) ? 1 : 0);
    void ev.action.setTitle(isLive(this.status) ? "LIVE" : "RELAY");
  }

  override onWillDisappear(ev: WillDisappearEvent<object>): void {
    this.instances.delete(ev.action);
  }

  override async onKeyDown(ev: KeyDownEvent<object>): Promise<void> {
    try {
      if (isLive(this.status)) {
        this.status = await client.stop();
      } else {
        this.status = await client.start();
      }
      void ev.action.setState(isLive(this.status) ? 1 : 0);
      void ev.action.setTitle(isLive(this.status) ? "LIVE" : "RELAY");
      streamDeck.logger?.info(`toggle -> ${this.status.session.state}`);
    } catch (err) {
      streamDeck.logger?.error(`toggle failed: ${String(err)}`);
      await ev.action.showAlert();
    }
  }
}

streamDeck.connect();
