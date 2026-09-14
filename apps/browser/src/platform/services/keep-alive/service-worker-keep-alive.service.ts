import { Observable, combineLatest, distinctUntilChanged, map, startWith } from "rxjs";

import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";

import { BrowserApi, IDLE_DETECTION_INTERVAL_SECONDS } from "../../browser/browser-api";
import { OffscreenDocumentService } from "../../offscreen-document/abstractions/offscreen-document";

/**
 * How often the offscreen document pings the service worker. Chrome tears an idle extension
 * service worker down after 30 seconds, so the heartbeat has to land well inside that window.
 */
export const KEEP_ALIVE_INTERVAL_MS = 20_000;

/**
 * Keeps the extension service worker resident while the user has an unlocked vault and is
 * actively using the browser.
 *
 * Chrome terminates an idle service worker after 30 seconds. Every popup opened after that
 * point pays for a full background boot — evaluating a multi-megabyte bundle, constructing the
 * service graph, and rehydrating session state, which for the decrypted vault means reading,
 * decrypting and deserializing the whole blob out of local storage. That cost lands directly in
 * front of the user, on every open.
 *
 * The heartbeat is driven from the offscreen document rather than from the worker itself,
 * because the document outlives the worker: its ping both resets the idle timer while the
 * worker is running and revives a worker Chrome has already torn down.
 *
 * This changes no security property. The session key still lives only in session storage and
 * still dies with the browser session, lock and vault-timeout behaviour is untouched, and the
 * heartbeat stops as soon as every account is locked or logged out.
 */
export class ServiceWorkerKeepAliveService {
  private running = false;
  private releaseOffscreenDocument: (() => Promise<void>) | null = null;

  constructor(
    private readonly authService: AuthService,
    private readonly offscreenDocumentService: OffscreenDocumentService,
    private readonly logService: LogService,
  ) {}

  init() {
    if (!this.offscreenDocumentService.offscreenApiSupported() || !BrowserApi.isIdleApiSupported) {
      // Firefox runs a persistent background page and Safari has no offscreen API, so neither
      // needs — nor can drive — a heartbeat.
      return;
    }

    this.registerHeartbeatListener();

    // The subscription is never torn down: an MV3 worker has no shutdown hook to tear it down
    // from, and it should live for exactly as long as the worker does.
    combineLatest([this.anyAccountUnlocked$(), this.userIsActive$()])
      .pipe(
        map(([anyAccountUnlocked, userIsActive]) => anyAccountUnlocked && userIsActive),
        distinctUntilChanged(),
      )
      .subscribe((shouldStayResident) => {
        if (shouldStayResident) {
          this.start();
        } else {
          this.stop();
        }
      });
  }

  private anyAccountUnlocked$(): Observable<boolean> {
    return this.authService.authStatuses$.pipe(
      map((statuses) =>
        Object.values(statuses).some((status) => status === AuthenticationStatus.Unlocked),
      ),
      distinctUntilChanged(),
    );
  }

  /**
   * Emits whether the machine is in use. Holding the worker resident while the user is away
   * would spend memory and battery for nobody's benefit, and the next real interaction wakes
   * the worker anyway, which restarts the heartbeat.
   *
   * The boot reading uses `IDLE_DETECTION_INTERVAL_SECONDS` because `IdleBackground` feeds the
   * same value to `chrome.idle.setDetectionInterval`, which is global to the extension and
   * decides when `onStateChanged` fires no matter what this query asks for. Reading with any
   * other threshold would only make the boot reading disagree with every event after it.
   */
  private userIsActive$(): Observable<boolean> {
    return new Observable<boolean>((subscriber) => {
      const stateHandler = (newState: `${chrome.idle.IdleState}`) =>
        subscriber.next(newState === "active");

      BrowserApi.addListener(chrome.idle.onStateChanged, stateHandler);

      BrowserApi.queryIdleState(IDLE_DETECTION_INTERVAL_SECONDS)
        .then((initialState) => subscriber.next(initialState === "active"))
        .catch((error) => this.logService.error("Failed to read the machine idle state", error));

      return () => BrowserApi.removeListener(chrome.idle.onStateChanged, stateHandler);
    }).pipe(
      // Assume the machine is in use until told otherwise: the worker has just booted, which
      // itself implies activity.
      startWith(true),
      distinctUntilChanged(),
    );
  }

  /**
   * Answers the heartbeat so the ping does not leave an unanswered message port behind.
   * Receiving the message is the whole point; the worker is awake by the time this runs.
   */
  private registerHeartbeatListener() {
    BrowserApi.messageListener(
      "service-worker-keep-alive",
      (message: { command?: string }, _sender, sendResponse: (response?: unknown) => void) => {
        if (message?.command !== "serviceWorkerKeepAlivePing") {
          return;
        }

        sendResponse({ alive: true });
        return true;
      },
    );
  }

  private start() {
    if (this.running) {
      return;
    }

    this.running = true;
    void this.holdDocumentAndStartHeartbeat();
  }

  private async holdDocumentAndStartHeartbeat() {
    try {
      // The hold is what keeps the document alive for the whole heartbeat. It deliberately sits
      // outside `withDocument`'s reference count: an unrelated caller — clipboard, local
      // storage — must not be able to close the document out from under a running heartbeat
      // when its own callback finishes.
      const release = await this.offscreenDocumentService.holdDocument(
        [chrome.offscreen.Reason.WORKERS],
        "keep the service worker resident while the vault is unlocked",
      );

      if (!this.running) {
        // Locked, logged out or went idle while the document was opening.
        await release();
        return;
      }

      this.releaseOffscreenDocument = release;

      await BrowserApi.sendMessageWithResponse("startServiceWorkerKeepAlive", {
        intervalMs: KEEP_ALIVE_INTERVAL_MS,
      });
    } catch (error) {
      this.running = false;
      this.logService.error("Failed to start the service worker heartbeat", error);
    }
  }

  /**
   * The stop message is sent even when this instance holds no document, because Chrome can tear
   * the worker down while the heartbeat is running — the offscreen document survives that and
   * keeps pinging — so a freshly booted worker that decides it should not be resident has to be
   * able to silence a heartbeat it never started.
   */
  private stop() {
    this.running = false;

    BrowserApi.sendMessage("stopServiceWorkerKeepAlive").catch(() => {
      // Rejects when no offscreen document is listening, which is the common case and is
      // exactly the state we wanted.
    });

    const release = this.releaseOffscreenDocument;
    this.releaseOffscreenDocument = null;

    void release?.().catch((error) =>
      this.logService.error("Failed to release the offscreen document", error),
    );
  }
}
