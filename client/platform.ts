/**
 * Platform gates for the plugin's client UI.
 *
 * The record-and-review flow (record a conversation, review every redacted value, edit it,
 * export or replay it) is a dense, desktop-sized screen: a long scroll of steps, per-value
 * decisions, inline editing and a file download. On a phone it does not work well, so iOS does
 * not get the entry point at all - the rest of the plugin (settings, slash commands, the
 * provider itself) keeps working there.
 *
 * Kept free of react-native imports so it can be unit tested.
 */

/** iOS has no record flow; every other platform (desktop, web, Android) does. */
export function supportsRecordFlow(platform: string): boolean {
  return platform !== "ios";
}
