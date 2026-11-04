export type MainWorldFile = {
  id?: string;
  applicationId: string;
  operation: number;
  data: string;
  mime: string;
  name: string;
};

export type MainWorldRequest = {
  event?: string;
  eventOptions?: Record<string, boolean | number | string>;
  file?: MainWorldFile;
  method: string;
  token: string;
  values: string[];
};

export type MainWorldResult = { ok: boolean; reason?: string; value?: string };

// This function is deliberately self-contained: Chrome serializes it into the
// page's MAIN world, where module-scope helpers are unavailable.
export function applyMainWorld(
  request: MainWorldRequest,
): MainWorldResult | Promise<MainWorldResult> {
  const marker = "data-application-lane-main";
  const fail = (reason: string): MainWorldResult => ({ ok: false, reason });
  if (
    !request ||
    typeof request.token !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(request.token) ||
    !Array.isArray(request.values) ||
    request.values.length > 100 ||
    request.values.some(
      (value) => typeof value !== "string" || value.length > 10_000,
    )
  )
    return fail("Invalid MAIN-world request.");
  const matches: Element[] = [];
  const visit = (root: Document | ShadowRoot) => {
    matches.push(
      ...root.querySelectorAll(`[${marker}="${CSS.escape(request.token)}"]`),
    );
    for (const host of root.querySelectorAll("*"))
      if (host.shadowRoot) visit(host.shadowRoot);
  };
  visit(document);
  if (matches.length !== 1)
    return fail("The guarded field marker was missing or ambiguous.");
  const element = matches[0] as HTMLElement;
  element.removeAttribute(marker);
  const prohibited =
    /\b(submit|send|finish|sign|agree|certify|certification)\b|\bcomplete application\b/i;
  const clicks =
    ["click", "reactClick"].includes(request.method) ||
    request.event === "click";
  for (
    let node: Element | null = element;
    node;
    node = node.parentElement || (node.getRootNode() as ShadowRoot).host || null
  ) {
    const label =
      node.getAttribute("aria-label") ||
      [...((node as HTMLInputElement).labels || [])]
        .map((label) => label.textContent || "")
        .join(" ") ||
      node.textContent ||
      (node as HTMLInputElement).value ||
      "";
    if (
      (node instanceof HTMLButtonElement &&
        node.type === "submit" &&
        node.form) ||
      node.matches('input[type="submit"],input[type="image"]') ||
      (clicks &&
        node.matches('button,a,[role="button"]') &&
        prohibited.test(label))
    )
      return fail("Refused to activate a submit or certification control.");
  }
  const supported = new Set([
    "event",
    "click",
    "reactClick",
    "blur",
    "uploadResume",
    "uploadCoverLetter",
    "uploadFile",
    "scrollToBottom",
    "clearValue",
    "default",
    "defaultWithoutBlur",
    "react",
    "jQuery",
    "selectOption",
    "selectCheckboxOrRadio",
    "checkOption",
    "setValue",
    "setValueOnly",
    "keyType",
    "reactSelectOptions",
    "reactSelectChoose",
    "ui5",
  ]);
  if (!supported.has(request.method))
    return fail("Unsupported MAIN-world method.");
  if (
    request.method === "reactSelectOptions" ||
    request.method === "reactSelectChoose"
  ) {
    // react-select ignores synthetic mouse and key events, so it is driven
    // through its own component API. Only options the component itself
    // holds can be selected; nothing is fabricated.
    type Instance = {
      props: Record<string, any>;
      selectOption: (option: unknown) => void;
    };
    const fiberKey = Object.keys(element).find((key) =>
      key.startsWith("__reactFiber$"),
    );
    let fiber = fiberKey ? (element as any)[fiberKey] : undefined;
    let instance: Instance | undefined;
    let citrus: Record<string, any> | undefined;
    // Async and paginated wrappers sit above the select and own the loader.
    let loader: { loadOptions: (...args: any[]) => any; additional?: unknown } | undefined;
    for (let depth = 0; fiber && depth < 80; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (
        !citrus && element.closest(".pcty-input-select__input") &&
        props?.id === element.id && Array.isArray(props.options) &&
        typeof props.onChange === "function"
      ) citrus = props;
      if (
        !instance &&
        typeof fiber.stateNode?.selectOption === "function" &&
        Array.isArray(fiber.stateNode.props?.options)
      )
        instance = fiber.stateNode;
      if (instance && !loader && typeof props?.loadOptions === "function")
        loader = { loadOptions: props.loadOptions, additional: props.additional };
      if (instance && depth > 30) break;
    }
    if (instance) {
      // A class API constructed during SSR hydration may still belong only
      // to the pending tree. Reading options or choosing through that API
      // must wait for its first commit; never mutate an unmounted instance.
      let node = fiberKey ? (element as any)[fiberKey] : undefined;
      let root: any;
      for (let depth = 0; node && depth < 80; depth++, node = node.return)
        if (node.tag === 3) root = node.stateNode?.current;
      if (root) {
        const stack = [root];
        let committed = false;
        for (let visited = 0; stack.length && visited < 10_000; visited++) {
          const current = stack.pop()!;
          if (current.stateNode === instance) { committed = true; break; }
          if (current.child) stack.push(current.child);
          if (current.sibling) stack.push(current.sibling);
        }
        if (!committed) return fail("not-react-select");
      }
    }
    // Citrus is a functional component. Its search text is separate from the
    // selected item, and its onChange receives { id, item }, not a DOM event.
    if (!instance && citrus) {
      const props = citrus;
      if (props.disabled || props.readOnly || props.isMulti)
        return fail("The Citrus picker is disabled or unsupported.");
      const options = props.options.flatMap((option: any) =>
        Array.isArray(option?.options) ? option.options : [option],
      ).filter((option: any) =>
        option && typeof option.label === "string" &&
        !option.disabled && !option.header && !option.creatable && !option.empty,
      );
      if (request.method === "reactSelectOptions")
        return { ok: true, value: JSON.stringify([...new Set(options.map((option: any) => option.label))].slice(0, 500)) };
      const wanted = request.values[0];
      if (!wanted) return { ok: true, value: "" };
      const matches = options.filter((option: any) => option.label === wanted);
      if (matches.length !== 1)
        return fail("The chosen option is missing or ambiguous.");
      props.onChange({ id: props.id, item: matches[0] });
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const value = element.closest(".pcty-input-select__input")?.parentElement
          ?.querySelector(".input-select-input-single-value")?.textContent?.trim();
        return value === wanted
          ? { ok: true, value: wanted }
          : fail("The dropdown did not keep the selection.");
      })();
    }
    if (!instance) return fail("not-react-select");
    const select = instance as Instance & { __laneLoaded?: any[] };
    const wait = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    const labelOf = (option: any): string =>
      String(
        typeof select.props.getOptionLabel === "function"
          ? select.props.getOptionLabel(option)
          : (option?.label ?? ""),
      ).trim();
    const idOf = (option: any): string | undefined => {
      if (!option) return undefined;
      const id = typeof select.props.getOptionValue === "function"
        ? select.props.getOptionValue(option) : option.value;
      return (typeof id === "string" && id !== "") || typeof id === "number"
        ? String(id) : undefined;
    };
    const flat = (): any[] =>
      [...(select.props.options as any[]), ...(select.__laneLoaded || [])].flatMap(
        (option) => (Array.isArray(option?.options) ? option.options : [option]),
      );
    // The site's own loader, as its menu would call it: (search, loaded,
    // additional) for paginated selects, (search) for plain async ones.
    const load = async (search: string) => {
      if (!loader) return false;
      try {
        const result = await Promise.race([
          Promise.resolve(loader.loadOptions(search, [], loader.additional)),
          wait(5000).then(() => undefined),
        ]);
        const options = Array.isArray(result) ? result : (result as any)?.options;
        if (!Array.isArray(options)) return false;
        select.__laneLoaded = options.slice(0, 500);
        return true;
      } catch {
        return false;
      }
    };
    const reset = () => {
      if (select.props.inputValue)
        select.props.onInputChange?.("", {
          action: "input-blur",
          prevInputValue: select.props.inputValue,
        });
      select.props.onMenuClose?.();
    };
    if (request.method === "reactSelectOptions")
      return (async () => {
        const search = request.values[0];
        if (loader && (search || !select.props.options.length)) {
          if (await load(search || ""))
            return {
              ok: true,
              value: JSON.stringify([...new Set(flat().map(labelOf))].slice(0, 500)),
            };
        }
        if (!flat().length) {
          // Some lists load when the menu opens; searchable ones stay empty.
          select.props.onMenuOpen?.();
          for (let i = 0; i < 8 && (!flat().length || select.props.isLoading); i++)
            await wait(100);
        }
        if (search) {
          const before = JSON.stringify(flat().map(labelOf));
          select.props.onInputChange?.(search, {
            action: "input-change",
            prevInputValue: select.props.inputValue || "",
          });
          // Wait for the search to start and finish; give up quickly when the
          // list neither loads nor changes.
          let started = false;
          for (let i = 0; i < 30; i++) {
            await wait(100);
            if (select.props.isLoading) started = true;
            else if (JSON.stringify(flat().map(labelOf)) !== before) break;
            else if (started || i >= 8) break;
          }
        }
        return {
          ok: true,
          value: JSON.stringify([...new Set(flat().map(labelOf))].slice(0, 500)),
        };
      })();
    const wanted = request.values[0];
    if (!wanted) {
      reset();
      return { ok: true, value: "" };
    }
    const matches = [
      ...new Map(
        flat()
          .filter((option) => labelOf(option) === wanted)
          .map((option) => [
            String(
              typeof select.props.getOptionValue === "function"
                ? select.props.getOptionValue(option)
                : (option?.value ?? labelOf(option)),
            ),
            option,
          ]),
      ).values(),
    ];
    if (matches.length !== 1) {
      reset();
      return fail("The chosen option is missing or ambiguous.");
    }
    // Greenhouse stores { value: "us", label: "United States" } after its
    // menu's exact "United States +1" option is selected. A stable site ID
    // verifies that canonical value only when no other menu label shares it.
    // This does not change which option is eligible for selection.
    const selectedId = idOf(matches[0]);
    const uniqueId = selectedId !== undefined && flat()
      .filter(option => idOf(option) === selectedId)
      .every(option => labelOf(option) === wanted);
    select.selectOption(matches[0]);
    reset();
    const kept = () => {
      const value = select.props.value;
      return (Array.isArray(value) ? value : [value]).some(
        (option) => {
          if (!option) return false;
          const retainedId = idOf(option);
          if (selectedId !== undefined && retainedId !== undefined && retainedId !== selectedId)
            return false;
          return labelOf(option) === wanted || (uniqueId && retainedId === selectedId);
        },
      );
    };
    // A form that keeps its answers in its own state shows the pick only
    // once that state comes back: Greenhouse's Location (City) took 330 ms,
    // and a single look at 50 ms reported a kept pick as lost (Khan Academy,
    // report deb4cb8d; Pinterest, 300dba70). It is read until it shows, for
    // up to 2 s.
    return (async () => {
      const deadline = Date.now() + 2_000;
      do await wait(50);
      while (!kept() && Date.now() < deadline);
      return kept()
        ? { ok: true, value: wanted }
        : fail("The dropdown did not keep the selection.");
    })();
  }
  // Mouse events carry a left button: widgets (iCIMS dropdowns open on
  // mousedown) check which button was pressed.
  const dispatch = (type: string, options: EventInit = {}) =>
    element.dispatchEvent(
      /^(mouse|pointer|click|dblclick)/.test(type)
        ? new MouseEvent(type, {
            bubbles: true,
            composed: true,
            cancelable: true,
            button: 0,
            buttons: 1,
            view: window,
            ...options,
          })
        : new Event(type, { bubbles: true, composed: true, ...options }),
    );
  const valueOf = () => {
    if (element instanceof HTMLInputElement) {
      if (["checkbox", "radio"].includes(element.type))
        return element.checked ? element.value || "true" : "";
      if (element.type === "file") return element.files?.[0]?.name || "";
      return element.value;
    }
    if (
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    )
      return element.value;
    return element.getAttribute("aria-valuetext") || "";
  };
  const nativeValue = (value: string) => {
    const prototype =
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) return false;
    setter.call(element, value);
    return true;
  };
  const uniqueOption = (values: string[]) => {
    if (!(element instanceof HTMLSelectElement)) return;
    const options = [...element.options].filter(
      (option) =>
        !option.disabled &&
        option.value !== "" &&
        !/^(month|day|year)$/i.test(option.label.trim()) &&
        !/^(?:please )?(?:select(?: (?:an? |your )?[\w ]{1,35})?|choose(?: (?:an? |your )?[\w ]{1,35})?|make (?:a )?selection)$/i.test(
          option.label
            .replace(/[—–….-]/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
        ),
    );
    const normalized = (value: string) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const stages = [
      (option: HTMLOptionElement) =>
        values.some(
          (value) => (!/^(yes|no)$/i.test(value.trim()) || normalized(option.label).split(" ")[0] === normalized(value)) &&
            (option.label === value || option.value === value),
        ),
      (option: HTMLOptionElement) =>
        values.some(
          (value) =>
            (!/^(yes|no)$/i.test(value.trim()) || normalized(option.label).split(" ")[0] === normalized(value)) &&
            (normalized(option.label) === normalized(value) ||
            normalized(option.value) === normalized(value) ||
            // A month written "08" is Ashby's option "8" (August). Missed,
            // Ashby set the month it left empty to the current one when the
            // year was picked (report 9027045f, 2026-10-28).
            (/^\d+$/.test(option.value) && /^\d+$/.test(value.trim()) && Number(option.value) === Number(value))),
        ),
      (option: HTMLOptionElement) =>
        values.some((value) => /^(yes|no)$/i.test(value.trim()) &&
          new RegExp(`^${value.trim()}\\b`, "i").test(option.label.trim())),
    ];
    for (const stage of stages) {
      const found = options.filter(stage);
      if (found.length === 1) return found[0];
      if (found.length > 1) return;
    }
  };
  let focusedQuietly = false;
  let acquiredFocus = false;
  try {
    if (request.event) {
      if (/^key/.test(request.event))
        element.dispatchEvent(
          new KeyboardEvent(request.event, {
            bubbles: true,
            composed: true,
            ...request.eventOptions,
          }),
        );
      else dispatch(request.event, request.eventOptions);
    }
    if (request.method === "event") return { ok: true, value: valueOf() };
    if (request.method === "keyType") {
      // Workday's date sections and search prompts keep their own state and
      // ignore a plain value assignment; they update from key events.
      const text = request.values[0] ?? "";
      (element as HTMLElement).focus?.();
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        nativeValue("");
        dispatch("input");
      }
      for (const character of text) {
        const init: KeyboardEventInit = {
          bubbles: true,
          composed: true,
          key: character,
          code: /[0-9]/.test(character)
            ? `Digit${character}`
            : `Key${character.toUpperCase()}`,
          keyCode: character.charCodeAt(0),
          which: character.charCodeAt(0),
        };
        element.dispatchEvent(new KeyboardEvent("keydown", init));
        element.dispatchEvent(new KeyboardEvent("keypress", init));
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          nativeValue(element.value + character);
          dispatch("input");
        }
        element.dispatchEvent(new KeyboardEvent("keyup", init));
      }
      dispatch("change");
      return { ok: true, value: valueOf() };
    }
    if (request.method === "click" || request.method === "reactClick") {
      element.click();
      // A SuccessFactors picklist loads its list only once focused as well:
      // clicked alone it reads as open and stays empty (L3Harris, report
      // 5beb4b34, 2026-10-15).
      if (element.matches('input.rcmpaginatedselectinput[role="combobox"]')) element.focus({ preventScroll: true });
      return { ok: true, value: valueOf() };
    }
    if (request.method === "blur") {
      element.blur();
      return { ok: true, value: valueOf() };
    }
    if (
      request.method === "uploadResume" ||
      request.method === "uploadCoverLetter" ||
      request.method === "uploadFile"
    ) {
      if (!(element instanceof HTMLInputElement) || element.type !== "file")
        return fail("Configured upload target is not a file input.");
      if (
        !request.file ||
        typeof request.file.data !== "string" ||
        request.file.data.length > 14_000_000
      )
        return fail("A bounded application artifact is required.");
      const bytes = Uint8Array.from(atob(request.file.data), (character) =>
        character.charCodeAt(0),
      );
      const file = new File([bytes], request.file.name, {
        type: request.file.mime,
      });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      // Some sites (Greenhouse's job boards) keep the file themselves, empty
      // or replace the input, and show the file's name beside it instead.
      const group = element.closest(
        '[role="group"], .file-upload, .field-wrapper, .application-question, fieldset, .field',
      );
      const name = request.file.name;
      element.files = transfer.files;
      dispatch("input");
      dispatch("change");
      // Or a component around the input (across shadow roots) that names it
      // in its own files list: SmartRecruiters' dropzone clears the input at
      // once and lists the file when its server answers (LLNL, 2026-11-02).
      const hosts: Element[] = [];
      for (let node: Element | null = element; node; node = node.parentElement || ((node.getRootNode() as ShadowRoot).host ?? null))
        hosts.push(node);
      const retained = () =>
        element.files?.[0]?.name === name ||
        Boolean(group?.isConnected && group.textContent?.includes(name)) ||
        hosts.some((host) => host.isConnected && (host.getAttribute("files") || "").includes(name));
      if (retained()) return { ok: true, value: valueOf() || name };
      // Looked at again for a few seconds: an upload is answered by the
      // site's server, not at once.
      return new Promise<MainWorldResult>((resolve) => {
        const started = Date.now();
        const look = () => {
          if (retained()) return resolve({ ok: true, value: valueOf() || name });
          if (Date.now() - started >= 5000) return resolve(fail("The site did not retain the selected artifact."));
          setTimeout(look, 250);
        };
        setTimeout(look, 250);
      });
    }
    // SAP UI5 web components (SuccessFactors' date pickers) keep their value
    // on the component, not its inner input: set it there and announce it
    // the way the component does when someone picks a date.
    if (request.method === "ui5") {
      let host: (HTMLElement & { value?: string }) | undefined;
      for (
        let node: Element | null = element;
        node;
        node = node.parentElement || ((node.getRootNode() as ShadowRoot).host ?? null)
      )
        if (/^ui5-(date-picker|datetime-picker|input)/i.test(node.tagName)) {
          host = node as HTMLElement & { value?: string };
          if (/^ui5-date/i.test(node.tagName)) break;
        }
      const value = request.values[0];
      if (!host || value === undefined) return fail("No UI5 component holds this field.");
      host.value = value;
      for (const type of ["input", "change"])
        host.dispatchEvent(
          new CustomEvent(type, { bubbles: true, composed: true, detail: { value, valid: true } }),
        );
      return host.value === value
        ? { ok: true, value }
        : fail("The UI5 component did not keep the value.");
    }
    if (request.method === "scrollToBottom") {
      element.scrollTop = element.scrollHeight;
      return { ok: true, value: valueOf() };
    }
    const values = request.method === "clearValue" ? [""] : request.values;
    const value = values[0];
    if (value === undefined) return fail("No confirmed value was provided.");
    if (
      request.method === "checkOption" &&
      !(
        element instanceof HTMLInputElement &&
        ["checkbox", "radio"].includes(element.type)
      )
    )
      return fail("Configured option target is not a checkbox or radio.");
    if (element instanceof HTMLSelectElement) {
      const option = uniqueOption(values);
      if (!option) return fail("No unique option matched the confirmed value.");
      Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )?.set?.call(element, option.value);
    } else if (
      element instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(element.type)
    ) {
      const wanted = element.type === "radio" ||
        request.method === "checkOption" ||
        !["", "false", "no", "0"].includes(value.toLowerCase());
      // A click is what a React box listens for: set alone, Workday's "I am
      // fluent in this language" showed checked without its check mark
      // (Jabil, report b5a71768, 2026-10-15). The setter is the fallback.
      if (element.checked !== wanted) element.click();
      if (element.checked === wanted) return { ok: true, value: valueOf() };
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "checked",
      )?.set?.call(element, wanted);
    } else if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      // Entered the way a person types: focus first, so the blur below is a
      // real focusout. Workday saves a text field only when focus leaves it;
      // a field it never focused itself (the first row it adds) otherwise
      // shows the value and reports "required".
      if (!["defaultWithoutBlur", "setValue", "setValueOnly"].includes(request.method)) {
        if (document.activeElement !== element) {
          element.focus();
          acquiredFocus = document.activeElement === element;
        }
        // A page without the window's focus (the applicant is in the side
        // panel) gets no real focus events from focus() or blur(), so the
        // site would never see the field entered or left. Say so ourselves,
        // as with input and change. That holds for a field the site focused
        // itself, too: Cisco's Workday focuses the first row it adds.
        if (!document.hasFocus()) {
          focusedQuietly = true;
          element.dispatchEvent(new FocusEvent("focus"));
          element.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
        }
      }
      if (!nativeValue(value)) return fail("No native value setter was found.");
    } else return fail("Configured target is not a supported form control.");

    const reactKey = Object.keys(element).find(
      (key) =>
        key.startsWith("__reactProps$") ||
        key.startsWith("__reactEventHandlers$"),
    );
    const reactProps = reactKey
      ? (element as unknown as Record<string, any>)[reactKey]
      : undefined;
    if (
      request.method === "react" &&
      typeof reactProps?.onChange === "function"
    ) {
      const event = new Event("change", { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        target: { value: element },
        currentTarget: { value: element },
      });
      reactProps.onChange(event);
    }
    if (request.method !== "setValueOnly") {
      dispatch("input");
      dispatch("change");
    }
    if (request.method === "jQuery") {
      const jquery = (window as any).jQuery;
      if (typeof jquery !== "function") return fail("No jQuery was found.");
      jquery(element).trigger("input").trigger("change");
    }
    if (
      !["defaultWithoutBlur", "setValue", "setValueOnly"].includes(
        request.method,
      )
    ) {
      element.blur();
      if (focusedQuietly) {
        element.dispatchEvent(new FocusEvent("blur"));
        element.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
      }
    }
    return { ok: true, value: valueOf() };
  } catch (error) {
    // Release only focus acquired by this write. A handler may have moved
    // focus elsewhere, or the applicant may already have been in the field.
    if (acquiredFocus && document.activeElement === element) {
      element.blur();
      if (focusedQuietly) {
        element.dispatchEvent(new FocusEvent("blur"));
        element.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
      }
    }
    return fail((error as Error).message || "MAIN-world write failed.");
  }
}
