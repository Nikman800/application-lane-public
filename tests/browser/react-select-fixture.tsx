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
  value: Option | null;
  onChange: (option: Option | null) => void;
}> {
  state = { open: false, input: "" };
  selectOption(option: Option) {
    this.props.onChange(option);
    this.setState({ open: false, input: "" });
  }
  render() {
    const { id, label, options, value } = this.props;
    return (
      <div className="select__container">
        <label id={`${id}-label`}>{label}</label>
        <div
          className="select__control"
          onMouseDown={(event) => {
            if (event.nativeEvent.isTrusted) this.setState({ open: true });
          }}
        >
          {value && <div className="select__single-value">{value.label}</div>}
          <input
            className="select__input"
            id={id}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={this.state.open}
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
createRoot(document.getElementById("root")!).render(<Form />);
