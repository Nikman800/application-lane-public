import React from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

type Option = { value: string; label: string };
class Select extends React.Component<{
  value: Option | null;
  options: Option[];
  onChange: (option: Option) => void;
}> {
  selectOption(option: Option) { this.props.onChange(option); }
  render() {
    return React.createElement("div", { className: "select__container" },
      React.createElement("label", { id: "country-label", htmlFor: "country" }, "Country"),
      this.props.value && React.createElement("div", { className: "select__single-value" }, this.props.value.label),
      React.createElement("div", { className: "select__control" },
        React.createElement("input", { id: "country", role: "combobox", "aria-autocomplete": "list",
          "aria-labelledby": "country-label", value: "", onChange: () => {} })));
  }
}
let ready = typeof window === "undefined";
const loading = ready ? undefined : new Promise<void>(resolve => setTimeout(() => {
  ready = true;
  resolve();
}, 6000));
function Waiting() {
  if (!ready) throw loading;
  return React.createElement("div", null, "Read-only loaded content");
}
function Committed() {
  React.useLayoutEffect(() => { (window as any).formCommitted = true; }, []);
  return null;
}
function App() {
  const [value, setValue] = React.useState<Option | null>(null);
  return React.createElement(React.Suspense, { fallback: React.createElement("div", null, "Loading") },
    React.createElement("form", { onSubmit: (event: React.FormEvent<HTMLFormElement>) => event.preventDefault() },
    React.createElement("label", null, "Email", React.createElement("input", { name: "email", type: "email", required: true, onChange: () => {} })),
    React.createElement("label", null, "Phone", React.createElement("input", { name: "phone", type: "tel", required: true, onChange: () => {} })),
    React.createElement(Select, { value, options: [
      { value: "us", label: "United States" }, { value: "ca", label: "Canada" },
    ], onChange: (option: Option) => {
      if (!(window as any).formCommitted) (window as any).earlySelections++;
      (window as any).selectedCountry = option.value;
      setValue(option);
    } }),
    React.createElement(Waiting), React.createElement(Committed),
    React.createElement("button", { type: "submit" }, "Submit")));
}
// Playwright rewrites JSX for its component API; SSR needs real React nodes.
export const ssrSelectMarkup = () => renderToString(React.createElement(App));
if (typeof window !== "undefined") {
  (window as any).formCommitted = false;
  (window as any).earlySelections = 0;
  (window as any).fixtureSubmits = 0;
  document.querySelector("form")!.addEventListener("submit", () => (window as any).fixtureSubmits++);
  hydrateRoot(document.getElementById("root")!, React.createElement(App));
}
