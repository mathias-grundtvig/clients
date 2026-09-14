// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";

import { BrowserApi } from "../browser/browser-api";

import { OffscreenDocumentService } from "./abstractions/offscreen-document";

export class DefaultOffscreenDocumentService implements OffscreenDocumentService {
  private workerCount = 0;
  private holdCount = 0;

  constructor(private logService: LogService) {}

  offscreenApiSupported(): boolean {
    return BrowserApi.isOffscreenApiSupported;
  }

  async withDocument<T>(
    reasons: chrome.offscreen.Reason[],
    justification: string,
    callback: () => Promise<T> | T,
  ): Promise<T> {
    this.workerCount++;
    try {
      if (!(await this.documentExists())) {
        await this.create(reasons, justification);
      }

      return await callback();
    } finally {
      this.workerCount--;
      await this.closeIfUnused();
    }
  }

  async holdDocument(
    reasons: chrome.offscreen.Reason[],
    justification: string,
  ): Promise<() => Promise<void>> {
    this.holdCount++;

    try {
      if (!(await this.documentExists())) {
        await this.create(reasons, justification);
      }
    } catch (e) {
      this.holdCount--;
      throw e;
    }

    let released = false;
    return async () => {
      if (released) {
        return;
      }

      released = true;
      this.holdCount--;
      await this.closeIfUnused();
    };
  }

  private async closeIfUnused(): Promise<void> {
    if (this.workerCount === 0 && this.holdCount === 0) {
      await this.close();
    }
  }

  private async create(reasons: chrome.offscreen.Reason[], justification: string): Promise<void> {
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen-document/index.html",
        reasons,
        justification,
      });
    } catch (e) {
      // gobble multiple offscreen document creation errors
      // TODO: remove this when the offscreen document service is fixed PM-8014
      if (e.message === "Only a single offscreen document may be created.") {
        this.logService.info("Ignoring offscreen document creation error.");
        return;
      }
      throw e;
    }
  }

  private async close(): Promise<void> {
    await chrome.offscreen.closeDocument();
  }

  private async documentExists(): Promise<boolean> {
    return await chrome.offscreen.hasDocument();
  }
}
