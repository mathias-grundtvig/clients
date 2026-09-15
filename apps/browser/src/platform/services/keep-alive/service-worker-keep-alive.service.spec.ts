import { MockProxy, mock } from "jest-mock-extended";
import { BehaviorSubject } from "rxjs";

import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { FakeStateProvider, mockAccountServiceWith } from "@bitwarden/common/spec";
import { UserId } from "@bitwarden/common/types/guid";

import { BrowserApi } from "../../browser/browser-api";
import { IDLE_DETECTION_INTERVAL_SECONDS } from "../../browser/idle-detection.constant";
import { OffscreenDocumentService } from "../../offscreen-document/abstractions/offscreen-document";

import { KeepAliveSettingsService } from "./keep-alive-settings.service";
import {
  KEEP_ALIVE_INTERVAL_MS,
  ServiceWorkerKeepAliveService,
} from "./service-worker-keep-alive.service";

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("ServiceWorkerKeepAliveService", () => {
  const userId = "user-id" as UserId;
  const logService = mock<LogService>();

  let authStatuses: BehaviorSubject<Record<UserId, AuthenticationStatus>>;
  let authService: MockProxy<AuthService>;
  let offscreenDocumentService: MockProxy<OffscreenDocumentService>;
  let keepAliveSettingsService: KeepAliveSettingsService;
  let idleStateHandler: (state: `${chrome.idle.IdleState}`) => void;
  let releaseOffscreenDocument: jest.Mock<Promise<void>, []>;
  let sut: ServiceWorkerKeepAliveService;

  beforeEach(async () => {
    authStatuses = new BehaviorSubject<Record<UserId, AuthenticationStatus>>({
      [userId]: AuthenticationStatus.Locked,
    });
    authService = mock<AuthService>();
    authService.authStatuses$ = authStatuses;

    releaseOffscreenDocument = jest.fn().mockResolvedValue(undefined);
    offscreenDocumentService = mock<OffscreenDocumentService>();
    offscreenDocumentService.offscreenApiSupported.mockReturnValue(true);
    offscreenDocumentService.holdDocument.mockResolvedValue(releaseOffscreenDocument);

    // The real settings service over fake state, so the tests exercise the same stream the
    // background does. Most of them are about the rest of the gating, so the setting starts
    // turned on; "does not start the heartbeat while the setting is off" covers the default.
    keepAliveSettingsService = new KeepAliveSettingsService(
      new FakeStateProvider(mockAccountServiceWith(userId)),
    );
    await keepAliveSettingsService.setKeepServiceWorkerAlive(true);

    jest.spyOn(BrowserApi, "queryIdleState").mockResolvedValue("active");
    jest.spyOn(BrowserApi, "sendMessage").mockResolvedValue(undefined);
    jest.spyOn(BrowserApi, "sendMessageWithResponse").mockResolvedValue(undefined);
    jest.spyOn(BrowserApi, "messageListener").mockImplementation(() => undefined);
    jest.spyOn(BrowserApi, "addListener").mockImplementation((event, handler) => {
      if (event === chrome.idle.onStateChanged) {
        idleStateHandler = handler as (state: `${chrome.idle.IdleState}`) => void;
      }
    });
    jest.spyOn(BrowserApi, "removeListener").mockImplementation(() => undefined);

    sut = new ServiceWorkerKeepAliveService(
      authService,
      offscreenDocumentService,
      keepAliveSettingsService,
      logService,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it("does nothing when the offscreen api is unavailable", () => {
    offscreenDocumentService.offscreenApiSupported.mockReturnValue(false);

    sut.init();
    authStatuses.next({ [userId]: AuthenticationStatus.Unlocked });

    expect(offscreenDocumentService.holdDocument).not.toHaveBeenCalled();
  });

  it("does not start the heartbeat while every account is locked", () => {
    sut.init();

    expect(offscreenDocumentService.holdDocument).not.toHaveBeenCalled();
  });

  it("does not start the heartbeat while the setting is off", async () => {
    await keepAliveSettingsService.setKeepServiceWorkerAlive(false);

    sut.init();
    authStatuses.next({ [userId]: AuthenticationStatus.Unlocked });
    await flushPromises();

    expect(offscreenDocumentService.holdDocument).not.toHaveBeenCalled();
  });

  it("does not start the heartbeat when the setting has never been set", async () => {
    keepAliveSettingsService = new KeepAliveSettingsService(
      new FakeStateProvider(mockAccountServiceWith(userId)),
    );
    sut = new ServiceWorkerKeepAliveService(
      authService,
      offscreenDocumentService,
      keepAliveSettingsService,
      logService,
    );

    sut.init();
    authStatuses.next({ [userId]: AuthenticationStatus.Unlocked });
    await flushPromises();

    expect(offscreenDocumentService.holdDocument).not.toHaveBeenCalled();
  });

  it("stops the heartbeat when the setting is turned off", async () => {
    sut.init();
    authStatuses.next({ [userId]: AuthenticationStatus.Unlocked });
    await flushPromises();

    await keepAliveSettingsService.setKeepServiceWorkerAlive(false);
    await flushPromises();

    expect(BrowserApi.sendMessage).toHaveBeenCalledWith("stopServiceWorkerKeepAlive");
    expect(releaseOffscreenDocument).toHaveBeenCalledTimes(1);
  });

  it("starts the heartbeat when the setting is turned on with a vault already unlocked", async () => {
    await keepAliveSettingsService.setKeepServiceWorkerAlive(false);

    sut.init();
    authStatuses.next({ [userId]: AuthenticationStatus.Unlocked });
    await flushPromises();

    await keepAliveSettingsService.setKeepServiceWorkerAlive(true);
    await flushPromises();

    expect(offscreenDocumentService.holdDocument).toHaveBeenCalledTimes(1);
  });

  it("starts the heartbeat once an account is unlocked", async () => {
    sut.init();
    authStatuses.next({ [userId]: AuthenticationStatus.Unlocked });
    await Promise.resolve();

    expect(offscreenDocumentService.holdDocument).toHaveBeenCalledTimes(1);
    expect(BrowserApi.sendMessageWithResponse).toHaveBeenCalledWith("startServiceWorkerKeepAlive", {
      intervalMs: KEEP_ALIVE_INTERVAL_MS,
    });
  });

  it("starts the heartbeat only once while it is already running", async () => {
    sut.init();
    authStatuses.next({ [userId]: AuthenticationStatus.Unlocked });
    authStatuses.next({
      [userId]: AuthenticationStatus.Unlocked,
      ["second-user-id" as UserId]: AuthenticationStatus.Unlocked,
    });
    await Promise.resolve();

    expect(offscreenDocumentService.holdDocument).toHaveBeenCalledTimes(1);
  });

  it("stops the heartbeat when the vault locks", async () => {
    sut.init();
    authStatuses.next({ [userId]: AuthenticationStatus.Unlocked });
    await Promise.resolve();

    authStatuses.next({ [userId]: AuthenticationStatus.Locked });

    expect(BrowserApi.sendMessage).toHaveBeenCalledWith("stopServiceWorkerKeepAlive");
  });

  it("silences an orphaned heartbeat left behind by a previous worker instance", () => {
    // A worker that boots while every account is locked holds no document, but a heartbeat
    // started by the previous instance can still be running in the offscreen document.
    sut.init();

    expect(BrowserApi.sendMessage).toHaveBeenCalledWith("stopServiceWorkerKeepAlive");
  });

  it("stops the heartbeat when the machine goes idle, and restarts it on activity", async () => {
    sut.init();
    authStatuses.next({ [userId]: AuthenticationStatus.Unlocked });
    await Promise.resolve();

    idleStateHandler("idle");
    expect(BrowserApi.sendMessage).toHaveBeenCalledWith("stopServiceWorkerKeepAlive");

    idleStateHandler("active");
    await Promise.resolve();
    expect(offscreenDocumentService.holdDocument).toHaveBeenCalledTimes(2);
  });

  it("reads the boot idle state with the extension-wide detection interval", () => {
    sut.init();

    expect(BrowserApi.queryIdleState).toHaveBeenCalledWith(IDLE_DETECTION_INTERVAL_SECONDS);
  });

  it("releases the offscreen document when the heartbeat fails to start", async () => {
    jest
      .spyOn(BrowserApi, "sendMessageWithResponse")
      .mockRejectedValue(new Error("Extension context invalidated."));

    sut.init();
    authStatuses.next({ [userId]: AuthenticationStatus.Unlocked });
    await flushPromises();

    expect(releaseOffscreenDocument).toHaveBeenCalledTimes(1);

    // A failed start must not strand its hold: the next start has to take exactly one more.
    jest.spyOn(BrowserApi, "sendMessageWithResponse").mockResolvedValue(undefined);
    authStatuses.next({ [userId]: AuthenticationStatus.Locked });
    authStatuses.next({ [userId]: AuthenticationStatus.Unlocked });
    await flushPromises();

    expect(offscreenDocumentService.holdDocument).toHaveBeenCalledTimes(2);
    expect(releaseOffscreenDocument).toHaveBeenCalledTimes(1);
  });

  it("releases the offscreen document when the heartbeat stops", async () => {
    sut.init();
    authStatuses.next({ [userId]: AuthenticationStatus.Unlocked });
    await flushPromises();

    authStatuses.next({ [userId]: AuthenticationStatus.Locked });
    await flushPromises();

    expect(releaseOffscreenDocument).toHaveBeenCalledTimes(1);
  });

  it("releases the offscreen document when the heartbeat stops before the hold resolves", async () => {
    let resolveHold: (release: () => Promise<void>) => void;
    offscreenDocumentService.holdDocument.mockReturnValue(
      new Promise((resolve) => (resolveHold = resolve)),
    );

    sut.init();
    authStatuses.next({ [userId]: AuthenticationStatus.Unlocked });
    authStatuses.next({ [userId]: AuthenticationStatus.Locked });
    resolveHold!(releaseOffscreenDocument);
    await flushPromises();

    expect(releaseOffscreenDocument).toHaveBeenCalledTimes(1);
    expect(BrowserApi.sendMessageWithResponse).not.toHaveBeenCalledWith(
      "startServiceWorkerKeepAlive",
      expect.anything(),
    );
  });
});
