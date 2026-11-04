// Real keystrokes through the Chrome debugger, for widgets that keep their own
// state and ignore synthetic events. Workday's date sections are the reason
// this exists: assigning the value updates the display but leaves Workday's
// own validation reporting "The field From is required", and synthetic key
// events do not reach the section at all.
//
// CDP input goes to whatever the page has focused, so the content script
// focuses the field and the background verifies that focus through the same
// token handshake the MAIN-world bridge uses before a single key is sent.
// Nothing here can submit: only the characters given plus Backspace, and the
// character set excludes Enter and every modifier.

import { claimDebugger, debuggerTabs, forgetDebugger, holdsDebugger, releaseDebugger } from "./debugger-session";

// Backspace in an empty Workday date section moves focus to the previous
// section and clears it, so the caller says exactly how many characters are
// there to delete and never one more.
const maxClear = 16;

// Deliberately small: no Enter, no Tab, no modifier, nothing a form could read
// as "submit". Characters outside this set are refused rather than guessed at.
const typable = /^[\p{L}\p{N} .,'/-]{1,200}$/u;
// A widget that reads event.keyCode must see the code the real key carries.
const punctuation: Record<string, { code: string; keyCode: number }> = {
  " ": { code: "Space", keyCode: 32 },
  "'": { code: "Quote", keyCode: 222 },
  ",": { code: "Comma", keyCode: 188 },
  "-": { code: "Minus", keyCode: 189 },
  ".": { code: "Period", keyCode: 190 },
  "/": { code: "Slash", keyCode: 191 },
};

const keyCode = (character: string) =>
  punctuation[character]?.keyCode ??
  (/[a-z]/i.test(character)
    ? character.toUpperCase().charCodeAt(0)
    : character.charCodeAt(0));

const keyName = (character: string) =>
  punctuation[character]?.code ??
  (/[0-9]/.test(character)
    ? `Digit${character}`
    : /[a-z]/i.test(character)
      ? `Key${character.toUpperCase()}`
      : "");

export const trustedTypingAvailable = () => Boolean(chrome.debugger);

export async function releaseTrustedInput(tabId: number): Promise<void> {
  await releaseDebugger(tabId, "input");
}

// A debugger session Chrome ended for us (DevTools opened, tab closed, crash).
export function forgetTrustedInput(tabId: number): void {
  forgetDebugger(tabId);
}

export function trustedInputTabs(): number[] {
  return debuggerTabs("input");
}

export async function typeTrusted(
  tabId: number,
  text: string,
  clear = 0,
  enter = false,
): Promise<void> {
  if (!trustedTypingAvailable())
    throw new Error("Real keystrokes need the debugger permission.");
  if (!typable.test(text))
    throw new Error("Refused to type an unexpected value.");
  if (!Number.isInteger(clear) || clear < 0 || clear > maxClear)
    throw new Error("Refused an unexpected number of deletions.");
  if (!holdsDebugger(tabId, "input")) await claimDebugger(tabId, "input");
  const send = (params: Record<string, unknown>) =>
    chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", params);
  const press = async (extra: Record<string, unknown>) => {
    await send({ type: "keyDown", ...extra });
    await send({ type: "keyUp", ...extra });
  };
  for (let cleared = 0; cleared < clear; cleared++)
    await press({
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
  for (const character of text) {
    const code = keyCode(character);
    await send({
      type: "keyDown",
      key: character,
      code: keyName(character),
      text: character,
      unmodifiedText: character,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    });
    await send({
      type: "keyUp",
      key: character,
      code: keyName(character),
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    });
  }
  // A search box that runs its search on Enter (Workday's field of study at
  // KLA ignores a synthetic Enter, and a blurred box ignores any).
  if (enter)
    await press({
      key: "Enter",
      code: "Enter",
      text: "\r",
      unmodifiedText: "\r",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
}
