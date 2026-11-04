// One Chrome debugger attachment per tab, shared by everything that needs
// one: real keystrokes (trusted-input.ts) and the network capture for issue
// reports (network-capture.ts). Chrome allows an extension a single
// attachment per tab, so each user holds a claim and the tab is detached only
// when the last claim is released.

const claims = new Map<number, Set<string>>();

export async function claimDebugger(tabId: number, purpose: string): Promise<void> {
  const held = claims.get(tabId);
  if (held) {
    held.add(purpose);
    return;
  }
  await chrome.debugger.attach({ tabId }, "1.3");
  claims.set(tabId, new Set([purpose]));
}

export async function releaseDebugger(tabId: number, purpose: string): Promise<void> {
  const held = claims.get(tabId);
  if (!held || !held.delete(purpose) || held.size) return;
  claims.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

export function holdsDebugger(tabId: number, purpose: string): boolean {
  return Boolean(claims.get(tabId)?.has(purpose));
}

// Chrome ended the session itself (the tab closed, DevTools opened): every
// claim on it is gone.
export function forgetDebugger(tabId: number): void {
  claims.delete(tabId);
}

export function debuggerTabs(purpose?: string): number[] {
  return [...claims].filter(([, held]) => !purpose || held.has(purpose)).map(([tabId]) => tabId);
}
