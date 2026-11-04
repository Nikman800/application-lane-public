// Page-world call monitor for recordings. While a recording runs, it wraps the
// page functions another tool must use to change a form from the page's own
// JavaScript world (value setters, dispatchEvent, click, react-select's
// component methods) and reports each call with who made it, read from the
// call's stack trace. It never changes what a call does.
//
// Both functions are deliberately self-contained: Chrome serializes them into
// the page's MAIN world, where module-scope helpers are unavailable.

export type MonitoredCall = {
  fn: string;
  source: string;
  target?: { tag: string; id?: string; name?: string; role?: string; label?: string };
  value?: string;
  frames: string[];
};

export function installMonitor(session: string, ownExtensionId: string) {
  const key = Symbol.for("application-lane.monitor");
  const global = window as unknown as Record<symbol, any>;
  const existing = global[key];
  if (existing) {
    existing.session = session;
    return true;
  }
  const state: {
    session: string;
    restore: (() => void)[];
    busy: boolean;
    pageCalls: Record<string, number>;
    emitted: number;
    flush?: () => void;
  } = { session, restore: [], busy: false, pageCalls: {}, emitted: 0 };
  global[key] = state;
  const emitEvent = EventTarget.prototype.dispatchEvent;
  const emit = (call: MonitoredCall | { pageCalls: Record<string, number> }) => {
    if (state.emitted++ > 20_000) return;
    emitEvent.call(
      document,
      new CustomEvent("application-lane-monitor", {
        detail: JSON.stringify({ token: state.session, call }),
      }),
    );
  };
  // Who made this call: the first stack frames outside this monitor.
  const caller = () => {
    const limit = (Error as any).stackTraceLimit;
    (Error as any).stackTraceLimit = 30;
    const stack = new Error().stack || "";
    (Error as any).stackTraceLimit = limit;
    const lines = stack
      .split("\n")
      .slice(1)
      .map((line) => line.trim().replace(/^at\s+/, ""));
    // Everything up to the wrapper is this monitor; the rest is the caller.
    let wrapper = -1;
    lines.forEach((line, index) => {
      if (/__laneMonitor/.test(line)) wrapper = index;
    });
    const frames = lines.slice(wrapper + 1);
    const origins = frames.map((line) => {
      const extension = line.match(/chrome-extension:\/\/([a-p]{32})/);
      if (extension)
        return extension[1] === ownExtensionId
          ? "application-lane"
          : `extension:${extension[1]}`;
      if (/https?:\/\//.test(line)) return "page";
      return "injected";
    });
    // An extension frame anywhere means the extension drove the call; a
    // script with no URL was injected (evaluated code), not loaded by the page.
    // Our own page-world writes run as an injected function named
    // applyMainWorld, which has no script URL of its own.
    if (frames.some((line) => /\bapplyMainWorld\b/.test(line)))
      origins.unshift("application-lane");
    const source =
      origins.find((origin) => origin.startsWith("extension:")) ||
      (origins.includes("application-lane") ? "application-lane" : "") ||
      (origins.includes("injected") ? "injected" : "page");
    return {
      source,
      frames: frames.slice(0, 6).map((line) => {
        const name = line.match(/^([^\s(]+)\s+\(/)?.[1] || "(anonymous)";
        const where = line.match(/(chrome-extension:\/\/[a-p]{32}|https?:\/\/[^/\s)]+)/)?.[1];
        return where ? `${name} @ ${where}` : `${name} @ injected`;
      }),
    };
  };
  const describe = (node: unknown) => {
    if (!(node instanceof Element)) return undefined;
    const labelled = node.getAttribute("aria-labelledby");
    return {
      tag: node.tagName.toLowerCase(),
      id: node.id || undefined,
      name: node.getAttribute("name") || undefined,
      role: node.getAttribute("role") || undefined,
      label:
        (
          node.getAttribute("aria-label") ||
          (labelled && document.getElementById(labelled.split(/\s+/)[0])?.textContent) ||
          (node as HTMLInputElement).labels?.[0]?.textContent ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80) || undefined,
    };
  };
  const secret = (node: unknown) =>
    node instanceof HTMLInputElement &&
    (node.type === "password" ||
      /password|passcode|otp|one.?time|csrf|token|secret/i.test(`${node.name} ${node.id}`));
  const record = (fn: string, target: unknown, value?: unknown) => {
    if (state.busy) return;
    state.busy = true;
    try {
      const { source, frames } = caller();
      if (source === "page") {
        state.pageCalls[fn] = (state.pageCalls[fn] || 0) + 1;
        return;
      }
      emit({
        fn,
        source,
        target: describe(target),
        value:
          value === undefined
            ? undefined
            : secret(target)
              ? "[redacted]"
              : String(
                  typeof value === "object" && value
                    ? ((value as any).label ?? (value as any).type ?? JSON.stringify(value))
                    : value,
                ).slice(0, 200),
        frames,
      });
    } catch {
      /* Monitoring must never break the page. */
    } finally {
      state.busy = false;
    }
  };
  const wrapSetter = (prototype: object, property: string, fn: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (!descriptor?.set) return;
    const original = descriptor.set;
    Object.defineProperty(prototype, property, {
      ...descriptor,
      set: function __laneMonitorSetter(this: unknown, value: unknown) {
        record(fn, this, property === "files" ? "(files)" : value);
        return original.call(this, value);
      },
    });
    state.restore.push(() => Object.defineProperty(prototype, property, descriptor));
  };
  const wrapMethod = (owner: any, method: string, fn: string, valueOf?: (args: unknown[]) => unknown) => {
    const original = owner?.[method];
    if (typeof original !== "function" || original.__laneMonitored) return;
    const wrapped = function __laneMonitorMethod(this: unknown, ...args: unknown[]) {
      const self = this as any;
      record(
        fn,
        self instanceof Element
          ? self
          : (self?.inputRef ??
            document.getElementById(self?.props?.inputId || self?.props?.id || "") ??
            self),
        valueOf?.(args),
      );
      return original.apply(this, args);
    };
    (wrapped as any).__laneMonitored = true;
    owner[method] = wrapped;
    state.restore.push(() => {
      owner[method] = original;
    });
  };
  wrapSetter(HTMLInputElement.prototype, "value", "input.value =");
  wrapSetter(HTMLInputElement.prototype, "checked", "input.checked =");
  wrapSetter(HTMLInputElement.prototype, "files", "input.files =");
  wrapSetter(HTMLTextAreaElement.prototype, "value", "textarea.value =");
  wrapSetter(HTMLSelectElement.prototype, "value", "select.value =");
  wrapMethod(EventTarget.prototype, "dispatchEvent", "dispatchEvent", (args) => args[0]);
  wrapMethod(HTMLElement.prototype, "click", "click");
  wrapMethod(HTMLElement.prototype, "focus", "focus");
  wrapMethod(HTMLElement.prototype, "blur", "blur");
  // react-select's component methods, found through any combobox's fiber.
  // v5 defines them per instance (arrow-function class fields); older
  // versions put them on the class prototype. Either is wrapped where it is.
  const methods = ["selectOption", "setValue", "clearValue", "openMenu", "onInputChange", "onMenuOpen"];
  const seen = new WeakSet<object>();
  const findSelects = () => {
    for (const input of document.querySelectorAll('input[role="combobox"]')) {
      const fiberKey = Object.keys(input).find((k) => k.startsWith("__reactFiber$"));
      let fiber = fiberKey ? (input as any)[fiberKey] : undefined;
      for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) {
        const instance = fiber.stateNode;
        if (typeof instance?.selectOption !== "function") continue;
        if (!seen.has(instance)) {
          seen.add(instance);
          const prototype = Object.getPrototypeOf(instance);
          for (const method of methods)
            wrapMethod(
              Object.prototype.hasOwnProperty.call(instance, method) ? instance : prototype,
              method,
              `react-select.${method}`,
              (args) => args[0],
            );
        }
        break;
      }
    }
  };
  findSelects();
  // Dropdowns rendered later (another step, a re-render) are picked up too.
  let scan: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => {
    if (scan) return;
    scan = setTimeout(() => {
      scan = undefined;
      findSelects();
    }, 500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  state.restore.push(() => {
    observer.disconnect();
    clearTimeout(scan);
  });
  // The page's own calls are only counted, never itemized.
  state.flush = () => {
    if (Object.keys(state.pageCalls).length) {
      emit({ pageCalls: state.pageCalls });
      state.pageCalls = {};
    }
  };
  const tally = setInterval(() => state.flush?.(), 2000);
  state.restore.push(() => clearInterval(tally));
  return true;
}

export function removeMonitor() {
  const key = Symbol.for("application-lane.monitor");
  const global = window as unknown as Record<symbol, any>;
  const state = global[key];
  if (!state) return false;
  state.flush?.();
  for (const restore of state.restore.reverse()) {
    try {
      restore();
    } catch {
      /* Keep restoring the rest. */
    }
  }
  delete global[key];
  return true;
}
