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
// Skill names need a few more: "C#", "C++", "R&D", "Large Language Models
// (LLM)" fell back to synthetic keys, which one employer's search ignores.
const typable = /^[\p{L}\p{N} .,'/#+&()-]{1,200}$/u;
// A widget that reads event.keyCode must see the code the real key carries.
const punctuation: Record<string, { code: string; keyCode: number }> = {
  " ": { code: "Space", keyCode: 32 },
  "'": { code: "Quote", keyCode: 222 },
  ",": { code: "Comma", keyCode: 188 },
  "-": { code: "Minus", keyCode: 189 },
  ".": { code: "Period", keyCode: 190 },
  "/": { code: "Slash", keyCode: 191 },
  "#": { code: "Digit3", keyCode: 51 },
  "+": { code: "Equal", keyCode: 187 },
  "&": { code: "Digit7", keyCode: 55 },
  "(": { code: "Digit9", keyCode: 57 },
  ")": { code: "Digit0", keyCode: 48 },
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
  // Picked from the menu the typing opens: once it has come, Down to its
  // first entry, then Enter. SmartRecruiters' Title, Company and School keep
  // only a value chosen there.
  // How many entries down the one to choose is (true: the first).
  choose: boolean | number = false,
  // Down only, with no Enter: the caller reads which entry is highlighted
  // before taking it.
  hold = false,
  // A real click at this point of the page (CSS pixels from the top-left of
  // the tab's view), for an entry the menu's own keys will not reach:
  // SmartRecruiters' menus let every Down pass now and then, and ignore a
  // script's click.
  click?: { x: number; y: number },
  // The text as one insertion (one input event), not a key at a time: a
  // search box that takes the text of a burst's first key to look up, and
  // sets itself to that text when the answer comes, kept only "323" of
  // "323 E. Veterans Way" (Paylocity's address).
  insert = false,
): Promise<void> {
  if (!trustedTypingAvailable())
    throw new Error("Real keystrokes need the debugger permission.");
  if (click) {
    if (![click.x, click.y].every((value) => Number.isFinite(value) && value >= 0 && value < 20_000))
      throw new Error("Refused an unexpected click position.");
    if (!holdsDebugger(tabId, "input")) await claimDebugger(tabId, "input");
    const mouse = (type: string) =>
      chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type, x: click.x, y: click.y, button: "left", clickCount: 1 });
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mouseMoved", x: click.x, y: click.y });
    await mouse("mousePressed");
    await mouse("mouseReleased");
    return;
  }
  // Choosing from a menu already open types nothing more.
  if (!((choose || enter) && text === "") && !typable.test(text))
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
  if (insert && text) await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text });
  for (const character of insert ? "" : text) {
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
  // an employer ignores a synthetic Enter, and a blurred box ignores any).
  const downs = choose === true ? 1 : typeof choose === "number" ? choose : 0;
  // A negative count is that many entries up.
  if (!Number.isInteger(downs) || downs < -30 || downs > 30) throw new Error("Refused an unexpected menu position.");
  if (downs) {
    // Typed just now: the menu is given time to come. Asked once it is
    // open (a position counted in it), at once.
    if (text) await new Promise((resolve) => setTimeout(resolve, 1_500));
    for (let step = 0; step < Math.abs(downs); step++) {
      await press(downs > 0
        ? { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 }
        : { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  if ((enter || downs) && !hold)
    await press({
      key: "Enter",
      code: "Enter",
      text: "\r",
      unmodifiedText: "\r",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
}
