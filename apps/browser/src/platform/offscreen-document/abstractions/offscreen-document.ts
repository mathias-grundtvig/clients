export type OffscreenDocumentExtensionMessage = {
  [key: string]: any;
  command: string;
  text?: string;
  intervalMs?: number;
};

type OffscreenExtensionMessageEventParams = {
  message: OffscreenDocumentExtensionMessage;
  sender: chrome.runtime.MessageSender;
};

export type OffscreenDocumentExtensionMessageHandlers = {
  [key: string]: ({ message, sender }: OffscreenExtensionMessageEventParams) => any;
  offscreenCopyToClipboard: ({ message }: OffscreenExtensionMessageEventParams) => any;
  offscreenReadFromClipboard: () => any;
  startServiceWorkerKeepAlive: ({ message }: OffscreenExtensionMessageEventParams) => any;
  stopServiceWorkerKeepAlive: () => any;
};

export interface OffscreenDocument {
  init(): void;
}

export abstract class OffscreenDocumentService {
  abstract offscreenApiSupported(): boolean;
  abstract withDocument<T>(
    reasons: chrome.offscreen.Reason[],
    justification: string,
    callback: () => Promise<T> | T,
  ): Promise<T>;
  /**
   * Opens the offscreen document and keeps it open until the returned release function is
   * called. The hold sits outside the `withDocument` reference count, so a caller that needs
   * the document for an open-ended stretch does not have to park a never-settling callback
   * inside `withDocument` to keep it alive.
   */
  abstract holdDocument(
    reasons: chrome.offscreen.Reason[],
    justification: string,
  ): Promise<() => Promise<void>>;
}
