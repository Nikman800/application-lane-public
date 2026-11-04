import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

// Epic Games' careers form, as reported on 2026-10-14: Greenhouse questions
// drawn by the site itself. Each label's "for" names no element, labels end
// in "⁠*⁠:", the dropdowns are an older react-select (the input has
// no combobox role and an id "react-select-N-input"; the class exposes
// selectOption and props.options; the menu ignores synthetic events), the
// phone box opens only once its country is chosen, and each school is an
// .education-form-fields block repeating the same labels.
type Option = { label: string; value: string };
let count = 0;

class Select extends React.Component<{
  inputId?: string;
  ariaLabel?: string;
  options: Option[];
  value: Option | null;
  onChange: (option: Option | null) => void;
}> {
  state = { open: false, input: "" };
  id = this.props.inputId || `react-select-${++count}-input`;
  selectOption(option: Option) {
    this.props.onChange(option);
    this.setState({ open: false, input: "" });
  }
  render() {
    const { options, value } = this.props;
    return (
      <div className="dropdown-autocomplete css-2b097c-container">
        <div
          className="css-l772dy-control"
          onMouseDown={(event) => {
            if (event.nativeEvent.isTrusted) this.setState({ open: true });
          }}
        >
          {value ? <div className="css-1uccc91-singleValue">{value.label}</div> : <div className="css-placeholder">Select</div>}
          <input
            id={this.id}
            type="text"
            aria-autocomplete="list"
            aria-label={this.props.ariaLabel}
            value={this.state.input}
            onChange={(event) => this.setState({ input: event.target.value })}
            onBlur={() => this.setState({ open: false, input: "" })}
          />
        </div>
        {this.state.open && (
          <div className="css-menu">
            {options.map((option) => (
              <div
                key={option.value}
                className="css-option"
                onClick={(event) => {
                  if (event.nativeEvent.isTrusted) this.selectOption(option);
                }}
              >
                {option.label}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
}

const label = (text: string, required = true) => (
  <div className="InputLabel">
    <label htmlFor={text}>
      <span>{text}{"⁠"}{required ? "*" : ""}{"⁠"}:</span>
    </label>
  </div>
);
const yesNo: Option[] = [
  { label: "Yes", value: "1" },
  { label: "No", value: "0" },
];

function Form() {
  const [values, setValues] = useState<Record<string, Option | null>>({});
  const set = (key: string) => (option: Option | null) => setValues((current) => ({ ...current, [key]: option }));
  useEffect(() => {
    (window as any).selected = Object.fromEntries(Object.entries(values).map(([key, option]) => [key, option?.label || ""]));
  }, [values]);
  const question = (key: string, text: string) => (
    <div className="field-group dropdown" key={key}>
      <div className="custom-select">
        <div>
          {label(text)}
          <div>
            <Select options={yesNo} value={values[key] || null} onChange={set(key)} />
          </div>
        </div>
      </div>
    </div>
  );
  const row = (index: number) => (
    <div className="education-form-fields" key={index}>
      {["start_date.year", "end_date.year"].map((name) => (
        <div className="field-group" key={name}>
          {label(name.startsWith("start") ? "Start Date (Year)" : "End Date (Year)")}
          <div>
            <input name={`educations[${index}].${name}`} type="number" placeholder="YYYY" min="1900" max="2199" />
          </div>
        </div>
      ))}
    </div>
  );
  return (
    <main>
      <h1>Research Intern</h1>
      <p>Research topics of interest include: Game agents, Speech systems and conversational agents, Multi-modal diffusion models.</p>
      <form onSubmit={(event) => event.preventDefault()}>
        <div className="field-group">
          {label("Email")}
          <div><div className="job-form-text-field-container"><input name="questions.email" type="text" placeholder="Enter" /></div></div>
        </div>
        <div className="field-group">
          <div className="job-form-phone-field">
            <div className="phone-country">
              <div className="InputLabel"><label htmlFor="phoneCountry"><span>Country{"⁠"}*{"⁠"}:</span></label></div>
              <div className="custom-select">
                <Select
                  inputId="phoneCountry"
                  ariaLabel="Country"
                  options={[
                    { label: "Canada +1", value: "ca" },
                    { label: "United States +1", value: "us" },
                  ]}
                  value={values.country || null}
                  onChange={set("country")}
                />
              </div>
            </div>
            <div className="phone-number">
              <div className="InputLabel"><label htmlFor="questions.phone"><span>Phone{"⁠"}*{"⁠"}:</span></label></div>
              <input type="tel" id="questions.phone" name="questions.phone" placeholder="Enter" disabled={!values.country} />
            </div>
          </div>
        </div>
        {question("previously", "Have you previously worked for Acme Games or any of its subsidiaries in any capacity?")}
        {question("sponsorship", "Do you now, or will you in the future, require sponsorship for employment authorization in order to legally work in the location associated with this job posting?")}
        {question("authorized", "Do you have legal authorization to work in the geographic region specified for the internship?")}
        <div className="education-section">
          <h3>Education</h3>
          {row(0)}
          {row(1)}
        </div>
        <button type="submit">Submit Application</button>
      </form>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Form />);
