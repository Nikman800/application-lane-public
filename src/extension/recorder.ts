// Records what happens on a page while another tool (or the user) fills it:
// the events that reach the page, the menus and options that appear, the
// requests the page makes, and every field's value before and after. It only
// observes; it never touches the page.

export type RecordedTarget = {
  tag: string;
  id?: string;
  name?: string;
  role?: string;
  type?: string;
  label?: string;
  classes?: string;
  text?: string;
};

export type RecordedEvent = {
  t: number;
  kind:
    | "event"
    | "menu"
    | "attribute"
    | "network"
    | "fields"
    | "navigation"
    | "value"
    | "call"
    | "page-calls"
    // What this extension set out to write, and from where (content.ts).
    | "write";
  frameId?: number;
  data: Record<string, unknown>;
};

type RecorderOptions = {
  session: string;
  startedAt: number;
  send: (events: RecordedEvent[]) => void;
  label: (element: Element) => string;
  value: (element: Element) => string | undefined;
  secret: (element: Element) => boolean;
  fields: () => { label: string; value: string; kind: string }[];
  redactURL: (url: string) => string;
};

const eventTypes = [
  "pointerdown",
  "mousedown",
  "mouseup",
  "click",
  "keydown",
  "input",
  "change",
  "focusin",
  "focusout",
  "submit",
];
const menuSelector =
  '[role="listbox"],[role="option"],[role="menu"],[role="dialog"],[class*="menu" i],[class*="dropdown" i]';
const watchedAttributes = [
  "aria-expanded",
  "aria-selected",
  "aria-activedescendant",
  "aria-checked",
];
const maxEvents = 10_000;

export function startRecorder(options: RecorderOptions) {
  const clip = (text: string | null | undefined, max = 80) =>
    (text || "").replace(/\s+/g, " ").trim().slice(0, max);
  const describe = (node: EventTarget | null): RecordedTarget | undefined => {
    if (!(node instanceof Element)) return;
    const control = node.matches(
      'input,textarea,select,[role="combobox"],[role="option"],[role="checkbox"],[role="radio"],button',
    );
    return {
      tag: node.tagName.toLowerCase(),
      id: node.id || undefined,
      name: node.getAttribute("name") || undefined,
      role: node.getAttribute("role") || undefined,
      type: node.getAttribute("type") || undefined,
      label: control ? clip(options.label(node)) || undefined : undefined,
      classes:
        clip([...node.classList].slice(0, 3).join(" "), 120) || undefined,
      text:
        !["input", "textarea", "select"].includes(node.tagName.toLowerCase())
          ? clip(node.textContent, 60) || undefined
          : undefined,
    };
  };
  let recorded = 0;
  let buffer: RecordedEvent[] = [];
  const now = () => Date.now() - options.startedAt;
  const push = (kind: RecordedEvent["kind"], data: Record<string, unknown>) => {
    if (recorded >= maxEvents) return;
    recorded++;
    buffer.push({ t: now(), kind, data });
    if (recorded === maxEvents)
      buffer.push({
        t: now(),
        kind: "event",
        data: { note: "Event limit reached; later activity was not recorded." },
      });
  };
  const flush = () => {
    const batch = buffer;
    buffer = [];
    // An empty batch still keeps the background worker awake.
    options.send(batch);
  };
  const fieldSnapshot = (moment: "start" | "checkpoint" | "end") =>
    push("fields", { moment, fields: options.fields() });

  // Recent events, to tell whether a value change had a cause on the page.
  const recent: { at: number; target: Element; type: string; trusted: boolean }[] = [];
  const controlSelector =
    'input:not([type="hidden"]),textarea,select,[role="combobox"],[role="checkbox"],[role="radio"],[role="switch"]';
  const related = (target: Element, control: Element) => {
    if (control === target || control.contains(target) || target.contains(control))
      return true;
    if (target instanceof HTMLLabelElement && target.htmlFor && target.htmlFor === control.id)
      return true;
    // The same small field wrapper (a custom dropdown's shell, a label).
    let wrapper = control.parentElement;
    for (let depth = 0; wrapper && depth < 5; depth++, wrapper = wrapper.parentElement) {
      if (wrapper.querySelectorAll(controlSelector).length > 3) return false;
      if (wrapper.contains(target)) return true;
    }
    return false;
  };
  const values = new WeakMap<Element, string>();
  const roots = new Set<Document | ShadowRoot>();
  const controls = () => {
    const found: Element[] = [];
    const visit = (root: Document | ShadowRoot) => {
      if (!roots.has(root)) {
        roots.add(root);
        observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: watchedAttributes });
      }
      found.push(...root.querySelectorAll(controlSelector));
      for (const node of root.querySelectorAll("*"))
        if (node.shadowRoot && roots.size < 100) visit(node.shadowRoot);
    };
    visit(document);
    return found.slice(0, 400);
  };
  const sample = () => {
    const at = Date.now();
    while (recent.length && at - recent[0].at > 2000) recent.shift();
    for (const control of controls()) {
      const value = options.value(control) ?? "";
      const before = values.get(control);
      values.set(control, value);
      if (before === undefined || before === value) continue;
      const cause = [...recent].reverse().find((event) => related(event.target, control));
      const secret = options.secret(control);
      push("value", {
        target: describe(control),
        from: secret ? "[redacted]" : before.slice(0, 200),
        to: secret ? "[redacted]" : value.slice(0, 200),
        // No event touched this field just before: it was set directly.
        direct: !cause,
        cause: cause ? { type: cause.type, trusted: cause.trusted } : undefined,
      });
    }
  };

  const onEvent = (event: Event) => {
    const target = (event.composedPath()[0] || event.target) as Element | null;
    if (target instanceof Element)
      recent.push({ at: Date.now(), target, type: event.type, trusted: event.isTrusted });
    const data: Record<string, unknown> = {
      type: event.type,
      trusted: event.isTrusted,
      target: describe(target),
    };
    const secret = target instanceof Element && options.secret(target);
    if (event instanceof KeyboardEvent)
      data.key =
        secret && event.key.length === 1 ? "[redacted]" : event.key;
    if (["input", "change"].includes(event.type) && target instanceof Element)
      data.value = secret ? "[redacted]" : options.value(target);
    push("event", data);
  };
  for (const type of eventTypes)
    window.addEventListener(type, onEvent, { capture: true, passive: true });

  const optionTexts = (node: Element) =>
    [
      ...(node.matches('[role="option"]') ? [node] : []),
      ...node.querySelectorAll('[role="option"]'),
    ]
      .slice(0, 12)
      .map((option) => clip(option.textContent, 60));
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        const target = mutation.target as Element;
        push("attribute", {
          target: describe(target),
          name: mutation.attributeName,
          value: target.getAttribute(mutation.attributeName || ""),
        });
        continue;
      }
      for (const [op, nodes] of [
        ["added", mutation.addedNodes],
        ["removed", mutation.removedNodes],
      ] as const)
        for (const node of nodes) {
          if (!(node instanceof Element)) continue;
          const menu = node.matches(menuSelector)
            ? node
            : node.querySelector(menuSelector);
          if (!menu) continue;
          push("menu", {
            op,
            target: describe(menu),
            options: op === "added" ? optionTexts(node) : undefined,
            optionCount: node.querySelectorAll('[role="option"]').length,
          });
        }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: watchedAttributes,
  });

  let network: PerformanceObserver | undefined;
  try {
    network = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceResourceTiming[])
        if (["fetch", "xmlhttprequest", "beacon"].includes(entry.initiatorType))
          push("network", {
            url: options.redactURL(entry.name).slice(0, 500),
            initiator: entry.initiatorType,
            durationMs: Math.round(entry.duration),
          });
    });
    network.observe({ type: "resource", buffered: false });
  } catch {
    /* Resource timing is unavailable in this frame. */
  }

  // Calls reported by the page-world monitor, for this session only.
  const onMonitor = (event: Event) => {
    try {
      const { token, call } = JSON.parse(String((event as CustomEvent).detail));
      if (token !== options.session) return;
      if (call?.pageCalls) push("page-calls", { counts: call.pageCalls });
      else if (call) push("call", call);
    } catch {
      /* Not ours. */
    }
  };
  document.addEventListener("application-lane-monitor", onMonitor);

  fieldSnapshot("start");
  for (const control of controls())
    values.set(control, options.value(control) ?? "");
  const sampler = setInterval(sample, 300);
  const timer = setInterval(() => {
    if (buffer.length) flush();
  }, 500);
  const keepAlive = setInterval(() => {
    if (!buffer.length) flush();
  }, 10_000);
  const onHide = () => flush();
  window.addEventListener("pagehide", onHide);
  flush();

  const take = () => {
    const remaining = buffer;
    buffer = [];
    return remaining;
  };
  const stop = () => {
    for (const type of eventTypes)
      window.removeEventListener(type, onEvent, { capture: true });
    observer.disconnect();
    network?.disconnect();
    clearInterval(timer);
    clearInterval(keepAlive);
    clearInterval(sampler);
    sample();
    document.removeEventListener("application-lane-monitor", onMonitor);
    window.removeEventListener("pagehide", onHide);
    fieldSnapshot("end");
    return take();
  };
  return Object.assign(stop, {
    checkpoint: () => {
      sample();
      fieldSnapshot("checkpoint");
      return take();
    },
    note: (data: Record<string, unknown>) => push("write", data),
  });
}
