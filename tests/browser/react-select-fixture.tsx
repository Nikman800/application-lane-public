import { realSchools } from "../support/schools";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

// A stand-in for react-select as Greenhouse renders it: the component class
// exposes selectOption and props.options, its menu ignores synthetic events,
// and typed search text is discarded on blur. Async lists are wrapped by a
// component that owns loadOptions, like react-select-async-paginate.
type Option = { label: string; value: string };

class Select extends React.Component<{
  id: string;
  label: string;
  options: Option[];
  value: Option | Option[] | null;
  onChange: (option: any) => void;
  // A multi-select ("Please select all which apply") keeps a list of picks.
  isMulti?: boolean;
  required?: boolean;
}> {
  state = { open: false, input: "" };
  selectOption(option: Option) {
    const { isMulti, value } = this.props;
    this.props.onChange(isMulti ? [...((value as Option[] | null) || []), option] : option);
    this.setState({ open: false, input: "" });
  }
  render() {
    const { id, label, options, value, isMulti, required } = this.props;
    const picked = Array.isArray(value) ? value : [];
    return (
      <div className="select__container">
        <label id={`${id}-label`} htmlFor={id} className="label select__label">{label}{required && <span aria-hidden="true">*</span>}</label>
        <div
          className="select__control"
          onMouseDown={(event) => {
            if (event.nativeEvent.isTrusted) this.setState({ open: true });
          }}
        >
          {value && !Array.isArray(value) && <div className="select__single-value">{value.label}</div>}
          {isMulti && picked.map((option) => (
            <div key={option.value} className="select__multi-value"><div className="select__multi-value__label">{option.label}</div></div>
          ))}
          <input
            className="select__input"
            id={id}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={this.state.open}
            aria-required={required ? "true" : undefined}
            aria-labelledby={`${id}-label`}
            value={this.state.input}
            onChange={(event) => this.setState({ input: event.target.value })}
            onBlur={() => this.setState({ open: false, input: "" })}
          />
        </div>
        {this.state.open && (
          <div className="select__menu" role="listbox">
            {options.map((option) => (
              <div
                key={option.value}
                role="option"
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

function AsyncSelect(props: {
  id: string;
  label: string;
  value: Option | null;
  onChange: (option: Option | null) => void;
  loadOptions: (search: string, loaded: Option[], additional: unknown) => Promise<{ options: Option[] }>;
  additional: unknown;
}) {
  // Options arrive only through a real menu interaction.
  const [options] = useState<Option[]>([]);
  return (
    <Select
      id={props.id}
      label={props.label}
      options={options}
      value={props.value}
      onChange={props.onChange}
    />
  );
}

// Virginia Tech under its official name ("s27"), among schools sharing its
// words.
const schools: Option[] = realSchools.map((label, index) => ({ label, value: `s${index + 1}` }));

// Riot Games' Greenhouse form, its labels and
// option lists as captured, the company named Contoso: How did you hear
// with "None of the above / Other", a multi-select of business-fluent
// languages, and a month asked "If yes" after a question answered No.
const option = (label: string, index: number, prefix: string): Option => ({ label, value: `${prefix}${index}` });
function RiotForm() {
  const [values, setValues] = useState<Record<string, any>>({ question_1006: { label: "No", value: "t2" } });
  const set = (key: string) => (value: any) => setValues((current) => ({ ...current, [key]: value }));
  useEffect(() => {
    (window as any).selected = Object.fromEntries(Object.entries(values).map(([key, value]) =>
      [key, Array.isArray(value) ? value.map((each) => each.value) : value?.value || ""]));
  }, [values]);
  return (
    <main>
      <h1>Data Engineering Intern - Summer 2027</h1>
      <form onSubmit={(event) => event.preventDefault()}>
        <label>Email<input name="email" /></label>
        <Select id="question_1001" required label="How did you hear about this job?" value={values.question_1001 || null} onChange={set("question_1001")}
          options={["Contoso Website", "Linkedin", "Internet Job Board", "Industry Event (eg. GDC)", "College/Campus Event", "Employee Referral", "Social Media", "None of the above / Other"].map((label, i) => option(label, i, "h"))} />
        <Select id="question_1003[]" required isMulti label="In which language(s) are you business fluent?" value={values["question_1003[]"] || null} onChange={set("question_1003[]")}
          options={["Cantonese", "Czech", "English", "French", "German", "Japanese", "Spanish (Latin American)", "Spanish (Spain)", "Other"].map((label, i) => option(label, i, "l"))} />
        <Select id="question_1006" required label="As we are majority owned by Contoso, we would like to know if you have worked for Contoso or a company owned or otherwise affiliated with Contoso within the last 12 months." value={values.question_1006 || null} onChange={set("question_1006")}
          options={["Yes", "No"].map((label, i) => option(label, i + 1, "t"))} />
        <Select id="question_1007" required label="If yes, can you please indicate the last month you worked for Contoso and/or an affiliate company. " value={values.question_1007 || null} onChange={set("question_1007")}
          options={["n/a", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((label, i) => option(label, i, "m"))} />
      </form>
    </main>
  );
}

function Form() {
  const [values, setValues] = useState<Record<string, Option | null>>({});
  const countryMode = new URLSearchParams(window.location.search).get("country");
  const set = (key: string) => (option: Option | null) =>
    setValues((current) => ({ ...current, [key]: option }));
  useEffect(() => {
    (window as any).selected = Object.fromEntries(
      Object.entries(values).map(([key, option]) => [key, option?.value || ""]),
    );
  }, [values]);
  if (countryMode) return <main><h1>Country selection</h1><form onSubmit={event => event.preventDefault()}>
    <label>Email<input name="email" /></label>
    <Select id="country" label="Country" options={[
      { label: "United States +1", value: countryMode === "collision" ? "+1" : "us" },
      { label: "Canada +1", value: countryMode === "collision" ? "+1" : "ca" },
    ]} value={values.country || null} onChange={option => {
      (window as any).countryWrites = ((window as any).countryWrites || 0) + 1;
      const commit = () => set("country")(option && {
        value: countryMode === "wrong" ? "ca" : option.value,
        label: countryMode === "wrong" ? "Canada" : "United States",
      });
      // "late": the form's own state comes back after the pick, as
      // Greenhouse's Location (City) did 330 ms later.
      if (countryMode === "late") setTimeout(commit, 400);
      else commit();
    }} />
    <pre id="selected">{JSON.stringify(values)}</pre>
  </form></main>;
  return (
    <main>
      <h1>Greenhouse-style application</h1>
      <form onSubmit={(event) => event.preventDefault()}>
        <label>
          Email
          <input name="email" />
        </label>
        <Select
          id="gender"
          label="Gender Identity"
          options={[
            { label: "Man", value: "g1" },
            { label: "Woman", value: "g2" },
            { label: "I don't wish to answer", value: "g3" },
          ]}
          value={values.gender || null}
          onChange={set("gender")}
        />
        <Select
          id="gpa"
          label="What is your GPA?"
          options={["Below 2", "3.5 - 3.74", "3.75 - 4", "4+"].map((label, i) => ({
            label,
            value: `gpa${i}`,
          }))}
          value={values.gpa || null}
          onChange={set("gpa")}
        />
        <Select
          id="pronoun"
          label="Pronoun"
          options={[
            { label: "He/Him/His", value: "p1" },
            { label: "She/Her/Hers", value: "p2" },
          ]}
          value={values.pronoun || null}
          onChange={set("pronoun")}
        />
        <Select
          id="race"
          label="Race/Ethnicity"
          options={[
            { label: "Asian", value: "r1" },
            { label: "White", value: "r2" },
          ]}
          value={values.race || null}
          onChange={set("race")}
        />
        <AsyncSelect
          id="school"
          label="School"
          value={values.school || null}
          onChange={set("school")}
          additional={{ page: 1 }}
          loadOptions={async (search) => ({
            options: schools.filter((school) =>
              school.label.toLowerCase().includes(search.toLowerCase()),
            ),
          })}
        />
        <pre id="selected">{JSON.stringify(values)}</pre>
      </form>
    </main>
  );
}

(window as any).submissions = 0;
createRoot(document.getElementById("root")!).render(new URLSearchParams(window.location.search).get("riot") ? <RiotForm /> : <Form />);
