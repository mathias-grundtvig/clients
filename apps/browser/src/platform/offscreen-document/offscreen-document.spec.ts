import { flushPromises, sendMockExtensionMessage } from "../../autofill/spec/testing-utils";
import { BrowserApi } from "../browser/browser-api";
import BrowserClipboardService from "../services/browser-clipboard.service";

describe("OffscreenDocument", () => {
  let browserClipboardServiceCopySpy: jest.SpyInstance;
  let browserClipboardServiceReadSpy: jest.SpyInstance;
  let browserApiMessageListenerSpy: jest.SpyInstance;
  let browserApiSendMessageSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(async () => {
    browserApiMessageListenerSpy = jest.spyOn(BrowserApi, "messageListener");
    browserApiSendMessageSpy = jest.spyOn(BrowserApi, "sendMessage");
    browserClipboardServiceCopySpy = jest.spyOn(BrowserClipboardService, "copy");
    browserClipboardServiceReadSpy = jest.spyOn(BrowserClipboardService, "read");
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();

    await import("./offscreen-document");
  });

  describe("init", () => {
    it("sets up a `chrome.runtime.onMessage` listener", () => {
      expect(browserApiMessageListenerSpy).toHaveBeenCalledWith(
        "offscreen-document",
        expect.any(Function),
      );
    });
  });

  describe("extension message handlers", () => {
    it("ignores messages that do not have a handler registered with the corresponding command", () => {
      sendMockExtensionMessage({ command: "notAValidCommand" });

      expect(browserClipboardServiceCopySpy).not.toHaveBeenCalled();
      expect(browserClipboardServiceReadSpy).not.toHaveBeenCalled();
    });

    it("shows a console message if the handler throws an error", async () => {
      const error = new Error("test error");
      browserClipboardServiceCopySpy.mockRejectedValueOnce(new Error("test error"));

      sendMockExtensionMessage({ command: "offscreenCopyToClipboard", text: "test" });
      await flushPromises();

      expect(browserClipboardServiceCopySpy).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error resolving extension message response",
        error,
      );
    });

    describe("handleOffscreenCopyToClipboard", () => {
      it("copies the message text", async () => {
        const text = "test";

        browserClipboardServiceCopySpy.mockResolvedValueOnce(undefined);
        sendMockExtensionMessage({ command: "offscreenCopyToClipboard", text });
        await flushPromises();

        expect(browserClipboardServiceCopySpy).toHaveBeenCalledWith(window, text);
      });
    });

    describe("handleOffscreenReadFromClipboard", () => {
      it("reads the value from the clipboard service", async () => {
        browserClipboardServiceReadSpy.mockResolvedValueOnce("");
        sendMockExtensionMessage({ command: "offscreenReadFromClipboard" });
        await flushPromises();

        expect(browserClipboardServiceReadSpy).toHaveBeenCalledWith(window);
      });
    });

    describe("the service worker keep alive heartbeat", () => {
      const intervalMs = 20_000;

      beforeEach(() => {
        jest.useFakeTimers();
        // The module under test is imported once for the whole suite, so the spies carry calls
        // over between tests unless they are cleared here.
        browserApiSendMessageSpy.mockClear();
        browserApiSendMessageSpy.mockResolvedValue(undefined);
        consoleErrorSpy.mockClear();
      });

      afterEach(() => {
        sendMockExtensionMessage({ command: "stopServiceWorkerKeepAlive" });
        jest.useRealTimers();
      });

      it("pings the service worker on the requested interval", () => {
        sendMockExtensionMessage({ command: "startServiceWorkerKeepAlive", intervalMs });

        expect(browserApiSendMessageSpy).not.toHaveBeenCalled();

        jest.advanceTimersByTime(intervalMs);
        expect(browserApiSendMessageSpy).toHaveBeenCalledWith("serviceWorkerKeepAlivePing");

        jest.advanceTimersByTime(intervalMs * 2);
        expect(browserApiSendMessageSpy).toHaveBeenCalledTimes(3);
      });

      it("stops pinging once the heartbeat is stopped", () => {
        sendMockExtensionMessage({ command: "startServiceWorkerKeepAlive", intervalMs });
        jest.advanceTimersByTime(intervalMs);
        expect(browserApiSendMessageSpy).toHaveBeenCalledTimes(1);

        sendMockExtensionMessage({ command: "stopServiceWorkerKeepAlive" });
        jest.advanceTimersByTime(intervalMs * 5);

        expect(browserApiSendMessageSpy).toHaveBeenCalledTimes(1);
      });

      it("replaces a running heartbeat rather than stacking a second one", () => {
        sendMockExtensionMessage({ command: "startServiceWorkerKeepAlive", intervalMs });
        sendMockExtensionMessage({ command: "startServiceWorkerKeepAlive", intervalMs });
        jest.advanceTimersByTime(intervalMs);

        expect(browserApiSendMessageSpy).toHaveBeenCalledTimes(1);
      });

      it("swallows a ping that no service worker answers", async () => {
        browserApiSendMessageSpy.mockRejectedValue(new Error("Receiving end does not exist."));

        sendMockExtensionMessage({ command: "startServiceWorkerKeepAlive", intervalMs });
        jest.advanceTimersByTime(intervalMs);
        await flushPromises();

        expect(consoleErrorSpy).not.toHaveBeenCalled();
      });

      it.each([undefined, 0, -1, Number.NaN, 999])(
        "ignores a start request with an interval of %s",
        (invalidInterval) => {
          sendMockExtensionMessage({
            command: "startServiceWorkerKeepAlive",
            intervalMs: invalidInterval,
          });
          jest.advanceTimersByTime(60_000);

          expect(browserApiSendMessageSpy).not.toHaveBeenCalled();
        },
      );
    });
  });
});
