import type { MainWorldRequest, MainWorldResult } from "./mainWorld";

export type MainWorldGuard = {
  applicationId: string;
  documentId: string;
  operation: number;
};

const marker = "data-application-lane-main";
const pending = new Map<
  string,
  { element: Element; guard: MainWorldGuard; valid: () => boolean }
>();

export function authorizeMainWorld(
  guard: MainWorldGuard,
  token: string,
): boolean {
  const entry = pending.get(token);
  return Boolean(
    entry &&
    entry.guard.applicationId === guard.applicationId &&
    entry.guard.documentId === guard.documentId &&
    entry.guard.operation === guard.operation &&
    entry.element.isConnected &&
    entry.element.getAttribute(marker) === token &&
    entry.valid(),
  );
}

// Both the MAIN world and the debugger act on the page from outside this
// content script, so both claim the element through the same one-shot token:
// the background can only write where `authorizeMainWorld` still agrees.
async function claimed<T>(
  element: Element,
  guard: MainWorldGuard,
  signal: AbortSignal | undefined,
  valid: () => boolean,
  send: (token: string) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (!valid()) throw new Error("Field write is stale or locked.");
  const token = crypto.randomUUID();
  element.setAttribute(marker, token);
  pending.set(token, {
    element,
    guard,
    valid: () => !signal?.aborted && valid(),
  });
  const revoke = () => {
    pending.delete(token);
    if (element.getAttribute(marker) === token) element.removeAttribute(marker);
  };
  signal?.addEventListener("abort", revoke, { once: true });
  try {
    const result = await send(token);
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener("abort", revoke);
    revoke();
  }
}

export async function requestMainWorld(
  element: Element,
  guard: MainWorldGuard,
  request: Omit<MainWorldRequest, "token">,
  signal?: AbortSignal,
  valid: () => boolean = () => true,
): Promise<MainWorldResult> {
  return claimed(element, guard, signal, valid, async (token) => {
    const response = await chrome.runtime.sendMessage({
      type: "MAIN_WORLD_APPLY",
      ...guard,
      request: { ...request, token },
    });
    if (!response?.ok)
      throw new Error(response?.error || "MAIN-world write failed.");
    return response.data as MainWorldResult;
  });
}

// Real keystrokes for a widget that ignores synthetic events. The element must
// already be focused: CDP types into the focused node, so `valid` is what keeps
// the keys from landing anywhere else.
export async function requestTrustedType(
  element: Element,
  guard: MainWorldGuard,
  text: string,
  clear: number,
  signal?: AbortSignal,
  valid: () => boolean = () => true,
  enter = false,
  choose: boolean | number = false,
  hold = false,
  click?: { x: number; y: number },
): Promise<MainWorldResult> {
  return claimed(element, guard, signal, valid, async (token) => {
    const response = await chrome.runtime.sendMessage({
      type: "TRUSTED_TYPE",
      ...guard,
      request: { clear, text, token, ...(enter ? { enter: true } : {}), ...(choose ? { choose } : {}), ...(hold ? { hold: true } : {}), ...(click ? { click } : {}) },
    });
    if (!response?.ok)
      throw new Error(response?.error || "Trusted typing failed.");
    return (response.data as MainWorldResult) || { ok: true };
  });
}
