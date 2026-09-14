import { Observable, map } from "rxjs";

import {
  GlobalState,
  KeyDefinition,
  SERVICE_WORKER_KEEP_ALIVE_DISK,
  StateProvider,
} from "@bitwarden/common/platform/state";

const KEEP_SERVICE_WORKER_ALIVE = new KeyDefinition<boolean>(
  SERVICE_WORKER_KEEP_ALIVE_DISK,
  "keepServiceWorkerAlive",
  {
    deserializer: (value) => value,
  },
);

/**
 * Whether the extension should hold its service worker resident while a vault is unlocked.
 *
 * The setting is global rather than per-user because a single service worker backs every
 * account, so there is no coherent way to honour two accounts that disagree.
 *
 * It defaults to off. Holding the worker resident keeps decrypted vault state in memory for the
 * whole browser session instead of the seconds around each use, and keeps an extra renderer
 * process alive, so the trade is the user's to make.
 */
export class KeepAliveSettingsService {
  private readonly keepServiceWorkerAliveState: GlobalState<boolean>;
  readonly keepServiceWorkerAlive$: Observable<boolean>;

  constructor(private readonly stateProvider: StateProvider) {
    this.keepServiceWorkerAliveState = this.stateProvider.getGlobal(KEEP_SERVICE_WORKER_ALIVE);
    this.keepServiceWorkerAlive$ = this.keepServiceWorkerAliveState.state$.pipe(
      map((enabled) => enabled ?? false),
    );
  }

  async setKeepServiceWorkerAlive(enabled: boolean): Promise<void> {
    await this.keepServiceWorkerAliveState.update(() => enabled);
  }
}
