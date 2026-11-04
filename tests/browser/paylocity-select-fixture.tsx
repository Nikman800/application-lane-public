import React, { useState } from "react";
import { createRoot } from "react-dom/client";

type Option = { label: string; value: string };
class Select extends React.Component<{
  id: string;
  label: string;
  options: Option[];
  value: Option | null;
  onChange: (option: Option) => void;
}> {
  selectOption(option: Option) {
    this.props.onChange(option);
  }
  render() {
    const { id, label, value } = this.props;
    return (
      <label>
        {label}
        <div>
          <div className="input-select-input-single-value">
            {value?.label || "Select a state"}
          </div>
          <div className="pcty-input-select__input">
            <input
              id={id}
              aria-autocomplete="list"
              required
              onClick={() => {
                (window as any).pickerClicks++;
                window.location.reload();
              }}
            />
          </div>
        </div>
      </label>
    );
  }
}
function Form() {
  const [country, setCountry] = useState<Option>({
    label: "United States",
    value: "US",
  });
  const [state, setState] = useState<Option | null>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        (window as any).submissions++;
      }}
    >
      <div className="form-group form-required">
        <label>
          First Name<span> (required)</span>
        </label>
        <input id="info.firstName" />
      </div>
      <div className="form-group form-required">
        <label>
          Last Name<span> (required)</span>
        </label>
        <input id="info.lastName" />
      </div>
      <div className="form-group form-required">
        <label>
          Email Address<span> (required)</span>
        </label>
        <input id="info.email" />
      </div>
      <Select
        id="public-site-address-country"
        label="Country"
        options={[
          { label: "United States", value: "US" },
          { label: "Canada", value: "CA" },
        ]}
        value={country}
        onChange={setCountry}
      />
      <Select
        id="public-site-address-us-state"
        label="State"
        options={[
          { label: "Arizona", value: "AZ" },
          { label: "California", value: "CA" },
        ]}
        value={state}
        onChange={setState}
      />
      <label>
        Fill out application with my resume
        <input
          id="useAttachedResumeToFillOutApplication"
          type="checkbox"
          defaultChecked
        />
      </label>
      <label>
        Resume
        <input
          id="btn-resume"
          type="file"
          onChange={() => {
            if (
              (
                document.getElementById(
                  "useAttachedResumeToFillOutApplication",
                ) as HTMLInputElement
              ).checked
            )
              window.location.reload();
          }}
        />
      </label>
      <label>
        Cover Letter
        <input id="btn-coverLetter" type="file" />
      </label>
      <button type="submit">Submit application</button>
    </form>
  );
}
(window as any).pickerClicks = 0;
(window as any).submissions = 0;
createRoot(document.getElementById("root")!).render(<Form />);
