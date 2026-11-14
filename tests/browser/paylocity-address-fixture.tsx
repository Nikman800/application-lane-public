import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// Paylocity's Citrus address block, as captured: Address Line 1 is
// a text box (role="combobox") that asks an address service for suggestions a
// moment after typing, lists them only while it has focus, keeps free text on
// blur, and fills City, State and ZIP from a picked suggestion (County left
// empty, as the service's suggestions carry none). A résumé parse can leave
// the city in the line. "Have you worked with us before?" is a react-widgets
// dropdown whose list is drawn inside the box once opened.
type Address = { address1: string; city: string; county: string; state: string; zip: string };
type Suggestion = Omit<Address, "county">;
const service: Suggestion[] = [
  { address1: "100 Main St", city: "Christiansburg", state: "VA", zip: "24073" },
  { address1: "100 Main St", city: "Blacksburg", state: "VA", zip: "24060" },
  { address1: "100 Main Street Ext", city: "Radford", state: "VA", zip: "24141" },
  { address1: "200 Oak Ave", city: "Roanoke", state: "VA", zip: "24011" },
];
const label = (s: Suggestion) => `${s.address1} ${s.city}, ${s.state} ${s.zip}`;
(window as unknown as { lookups: string[] }).lookups = [];

function AddressLine({ id, value, onText, onPick }: {
  id: string; value: string; onText: (text: string) => void; onPick: (suggestion: Suggestion) => void;
}) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setText(value), [value]);
  const listId = `${id}-autocomplete-list`;
  const open = focused && suggestions.length > 0;
  return <label>Address Line 1<input id={id} data-automation-id={id} role="combobox" aria-autocomplete="list" aria-controls={listId}
    aria-expanded={open} autoComplete="off" maxLength={50} required type="text" value={text}
    onFocus={() => setFocused(true)}
    onChange={(event) => {
      const typed = event.target.value;
      setText(typed);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        (window as unknown as { lookups: string[] }).lookups.push(typed);
        const query = typed.trim().toLowerCase();
        window.setTimeout(() => setSuggestions(query.length < 3 ? [] : service.filter((s) => label(s).toLowerCase().startsWith(query))), 200);
      }, 300);
    }}
    onBlur={(event) => { const kept = event.target.value; window.setTimeout(() => { setFocused(false); onText(kept); }, 250); }} />
    {open && <ul id={listId} role="listbox">{suggestions.slice(0, 6).map((s, index) =>
      <li key={index} id={`${id}-autocomplete-item-${index}`} role="option" tabIndex={-1}
        onClick={() => { setSuggestions([]); onPick(s); }}>{label(s)}</li>)}</ul>}
  </label>;
}
function TextBox({ id, label: name, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return <label>{name}<input id={id} data-automation-id={id} autoComplete="off" required type="text" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}
type Option = { label: string; value: string };
const states = [{ label: "AZ", value: "AZ" }, { label: "VA", value: "VA" }];
function InputSelectBase({ id, label: name, value, onChange }: {
  id: string; label: string; options: Option[]; value: Option | null; onChange: (event: { id: string; item: Option }) => void;
}) {
  return <label>{name}<div id={`${id}-select-wrapper`} className="pcty-input-select-full-container">
    <div className="pcty-input-select-input-container"><div>
      <div className="input-select-input-single-value">{value?.label || "Select a state"}</div>
      <div className="pcty-input-select__input"><input id={id} aria-autocomplete="list" value="" onChange={() => {}} /></div>
    </div></div>
  </div></label>;
}
function AddressBlock({ id, initial }: { id: string; initial: Address }) {
  const [address, setAddress] = useState(initial);
  const set = (part: Partial<Address>) => setAddress((current) => ({ ...current, ...part }));
  const state = states.find((option) => option.value === address.state) || null;
  return <div data-automation-id={id}>
    <InputSelectBase id={`${id}-country`} label="Country" options={[{ label: "United States", value: "USA" }]} value={{ label: "United States", value: "USA" }} onChange={() => {}} />
    <AddressLine id={`${id}-address-1`} value={address.address1} onText={(address1) => set({ address1 })}
      onPick={(s) => set({ ...s, county: "" })} />
    <TextBox id={`${id}-city`} label="City" value={address.city} onChange={(city) => set({ city })} />
    <TextBox id={`${id}-county`} label="County" value={address.county} onChange={(county) => set({ county })} />
    <InputSelectBase id={`${id}-us-state`} label="State" options={states} value={state} onChange={({ item }) => set({ state: item.value })} />
    <TextBox id={`${id}-zip`} label="Zip Code" value={address.zip} onChange={(zip) => set({ zip })} />
  </div>;
}
function WorkedBefore() {
  const [value, setValue] = useState("--");
  const [open, setOpen] = useState(false);
  const id = "info.haveYouWorkedWithUsBefore";
  return <div className="form-group"><label>Have you worked with us before?</label><div>
    <div id={id} role="combobox" aria-owns={`${id}__listbox`} aria-expanded={open} aria-haspopup="true" aria-autocomplete="list" tabIndex={0}
      className={`rw-dropdownlist rw-widget${open ? " rw-open" : ""}`} onClick={() => setOpen(!open)}>
      <span className="rw-dropdownlist-picker rw-select rw-btn" title="open dropdown"></span>
      <div className="rw-input">{value}</div>
      {open && <div className="rw-popup-container"><div className="rw-popup rw-widget">
        <ul id={`${id}__listbox`} className="rw-list" role="listbox">{["--", "Yes", "No"].map((option, index) =>
          <li key={option} id={`${id}__listbox__option__${index}`} role="option" aria-selected={option === value} className="rw-list-option"
            onClick={(event) => { event.stopPropagation(); setValue(option); setOpen(false); }}>{option}</li>)}</ul>
      </div></div>}
    </div></div></div>;
}
const empty: Address = { address1: "", city: "", county: "", state: "", zip: "" };
function Form() {
  return <form>
    <label>First Name<input id="info.firstName" /></label>
    <label>Last Name<input id="info.lastName" /></label>
    <label>Email Address<input id="info.email" /></label>
    <AddressBlock id="public-site-address" initial={{ ...empty, address1: "Blacksburg", city: "Blacksburg", state: "VA" }} />
    <WorkedBefore />
    {[0, 1].map((index) => <div className="work-history-group" key={index}>
      <div className="section-heading">Work History {index + 1}</div>
      <label>Company Name<input data-automation-id={`workHistoryCompanyName${index}`} /></label>
      <AddressBlock id={`public-candidate-work-history-address-${index}`} initial={empty} />
    </div>)}
  </form>;
}
createRoot(document.getElementById("root")!).render(<Form />);
