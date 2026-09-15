/**
 * How long the machine has to go untouched before the browser reports it as idle.
 *
 * `chrome.idle.setDetectionInterval` is global to the extension, so this is the single
 * threshold every idle consumer sees. Querying the state with any other value only makes that
 * reading disagree with the `onStateChanged` events that follow.
 */
export const IDLE_DETECTION_INTERVAL_SECONDS = 60 * 5;
