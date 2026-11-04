import React, { useState } from "react";
import { createRoot } from "react-dom/client";

type Option = { label: string; value: string; disabled?: boolean };
function InputSelectBase({ id, label, options, value, onChange }: {
  id: string;
  label: string;
  options: Option[];
  value: Option | null;
  onChange: (event: { id: string; item: Option }) => void;
}) {
  return <label>{label}<div id={`${id}-select-wrapper`} className="pcty-input-select-full-container">
    <div className="pcty-input-select-input-container"><div>
      <div className="input-select-input-single-value">{value?.label || "Select a state"}</div>
      <div className="pcty-input-select__input"><input id={id} aria-autocomplete="list" value="" onChange={() => {}} /></div>
    </div></div>
  </div></label>;
}
const countries = [{ label: "United States", value: "USA" }, { label: "India", value: "IND" }];
const states = [{ label: "AZ", value: "AZ" }, { label: "CA", value: "CA" }];
function Address({ id, country: initialCountry = countries[0] }: { id: string; country?: Option }) {
  const [country, setCountry] = useState(initialCountry);
  const [state, setState] = useState<Option | null>(null);
  return <>
    <InputSelectBase id={`${id}-country`} label="Country" options={countries} value={country} onChange={({ item }) => setCountry(item)} />
    <InputSelectBase id={`${id}-us-state`} label="State" options={states} value={state} onChange={({ item }) => setState(item)} />
  </>;
}
function Degree({ index }: { index: number }) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const id = `educationHistory.degreeId.${index}`;
  return <label>Degree Obtained<div id={id} role="combobox" tabIndex={0} aria-valuetext={value} aria-expanded={open} aria-owns={`${id}__listbox`} onClick={() => setOpen(true)}>
    <div className="rw-input">{value}</div>
    {open && <ul id={`${id}__listbox`} role="listbox">{["Master", "Bachelor"].map((option) => <li key={option} role="option" onClick={(event) => { event.stopPropagation(); setValue(option); setOpen(false); }}>{option}</li>)}</ul>}
  </div></label>;
}
function Form() {
  return <form>
    <label>First Name<input id="info.firstName" /></label>
    <label>Last Name<input id="info.lastName" /></label>
    <label>Email Address<input id="info.email" /></label>
    <Address id="public-site-address" />
    {[0, 1].map((index) => <div className="work-history-group" key={index}>
      <div className="section-heading">Work History {index + 1}</div>
      <label>Company Name<input data-automation-id={`workHistoryCompanyName${index}`} /></label>
      <Address id={`public-candidate-work-history-address-${index}`} />
    </div>)}
    {[0, 1].map((index) => <div className="education-history-group" key={index}>
      <div className="section-heading">Education History {index + 1}</div>
      <label>School Name<input data-automation-id={`educationHistoryName${index}`} defaultValue="Example University" /></label>
      <label>Area of Study<input data-automation-id={`educationHistoryAreaOfStudy${index}`} /></label>
      <Degree index={index} />
      <label>Graduation Date<input data-automation-id={`txt-educationHistory-graduationDate-${index}`} placeholder="MM/YYYY" /></label>
    </div>)}
  </form>;
}
createRoot(document.getElementById("root")!).render(<Form />);
