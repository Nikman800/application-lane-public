// Profile editor parts for answers that differ by country and by applicant:
// work authorization country by country, citizenships, expected pay, and
// how dates and letters are written.
import React from "react";
import globals from "../engine/config/globals.json" with { type: "json" };
import type { Profile, WorkAuthorization } from "../shared/model";
import type { Salary } from "../shared/salary";

const countries = Object.entries(globals.countries as Record<string, string | string[]>)
  .map(([code, names]) => ({ code, name: Array.isArray(names) ? names[0] : names }))
  .sort((a, b) => a.name.localeCompare(b.name));
const countryName = (code: string) => countries.find((country) => country.code === code)?.name || code;

const statusLabels: Record<NonNullable<WorkAuthorization["status"]>, string> = {
  citizen: "Citizen",
  "permanent-resident": "Permanent resident",
  visa: "Visa or work permit",
  authorized: "Authorized (basis not said)",
  none: "Not authorized",
};

type Edit = <K extends keyof Profile>(key: K, value: Profile[K]) => void;

function CountrySelect({ value, onChange, label }: { value: string; onChange: (code: string) => void; label: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose a country</option>
      {countries.map((country) => (
        <option key={country.code} value={country.code}>{country.name}</option>
      ))}
    </select>
  );
}

export function WorkAuthorizationEditor({ profile, edit }: { profile: Profile; edit: Edit }) {
  const entries = profile.workAuthorization || [];
  const citizenships = profile.citizenships || [];
  const change = (index: number, patch: Partial<WorkAuthorization>) =>
    edit("workAuthorization", entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  return (
    <section className="card">
      <div className="section-title">
        <h2>Where you can work</h2>
        <button
          className="text-button"
          type="button"
          onClick={() => edit("workAuthorization", [...entries, { country: "" }])}
        >
          + Add country
        </button>
      </div>
      <p className="help">
        Add each country you could work in. A question about work authorization or sponsorship is answered only
        for the country it asks about, or the job's country; any other is left for you.
      </p>
      {entries.map((entry, index) => (
        <div className="history-row" key={index}>
          <div className="form-grid">
            <label>
              Country
              <CountrySelect label={`Work authorization ${index + 1} country`} value={entry.country} onChange={(country) => change(index, { country })} />
            </label>
            <label>
              Status
              <select
                value={entry.status || ""}
                onChange={(e) => change(index, { status: (e.target.value || undefined) as WorkAuthorization["status"] })}
              >
                <option value="">Leave for me to answer</option>
                {(Object.keys(statusLabels) as (keyof typeof statusLabels)[])
                  .filter((status) => status !== "authorized" || entry.status === "authorized")
                  .map((status) => (
                    <option key={status} value={status}>{statusLabels[status]}</option>
                  ))}
              </select>
            </label>
            {entry.status === "visa" && (
              <label>
                Visa or permit (optional)
                <input
                  value={entry.visaType || ""}
                  placeholder="e.g. H-1B, Skilled Worker, PGWP"
                  maxLength={100}
                  onChange={(e) => change(index, { visaType: e.target.value || undefined })}
                />
              </label>
            )}
            <label>
              Needs sponsorship there
              <select
                value={entry.needsSponsorship === undefined ? "" : entry.needsSponsorship ? "yes" : "no"}
                onChange={(e) => change(index, { needsSponsorship: e.target.value === "" ? undefined : e.target.value === "yes" })}
              >
                <option value="">Leave for me to answer</option>
                <option value="no">No, now or in the future</option>
                <option value="yes">Yes, now or in the future</option>
              </select>
            </label>
          </div>
          <button
            className="text-button muted"
            type="button"
            onClick={() => edit("workAuthorization", entries.filter((_, i) => i !== index))}
          >
            Remove country
          </button>
        </div>
      ))}
      <label>
        Citizenships
        <CountrySelect
          label="Add a citizenship"
          value=""
          onChange={(code) => code && !citizenships.includes(code) && edit("citizenships", [...citizenships, code])}
        />
      </label>
      {citizenships.length > 0 && (
        <p className="help" aria-label="Your citizenships">
          {citizenships.map((code) => (
            <span key={code} className="tag">
              {countryName(code)}{" "}
              <button
                type="button"
                className="text-button muted"
                aria-label={`Remove ${countryName(code)}`}
                onClick={() => edit("citizenships", citizenships.filter((one) => one !== code))}
              >
                ×
              </button>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

export function SalaryEditor({ profile, edit }: { profile: Profile; edit: Edit }) {
  const salary: Salary = profile.salary || { currency: "", period: "year" };
  const set = (patch: Partial<Salary>) => {
    const next = { ...salary, ...patch };
    edit("salary", next.min === undefined && next.max === undefined ? undefined : next);
  };
  const amount = (value: string) => (value.trim() === "" || !Number.isFinite(Number(value)) ? undefined : Number(value));
  return (
    <>
      <label>
        Expected pay, from
        <input type="number" min={0} step="any" inputMode="decimal" placeholder="e.g. 95000" value={salary.min ?? ""} onChange={(e) => set({ min: amount(e.target.value) })} />
      </label>
      <label>
        Expected pay, to (optional)
        <input type="number" min={0} step="any" inputMode="decimal" value={salary.max ?? ""} onChange={(e) => set({ max: amount(e.target.value) })} />
      </label>
      <label>
        Pay currency (optional)
        <input placeholder="e.g. USD, EUR, £" maxLength={10} value={salary.currency} onChange={(e) => set({ currency: e.target.value.trim() })} />
      </label>
      <label>
        Pay period
        <select value={salary.period} onChange={(e) => set({ period: e.target.value as Salary["period"] })}>
          <option value="year">Per year</option>
          <option value="month">Per month</option>
          <option value="hour">Per hour</option>
        </select>
      </label>
    </>
  );
}

export function CareerEditor({ profile, edit }: { profile: Profile; edit: Edit }) {
  return (
    <>
      <label>
        Career stage
        <select value={profile.careerStage || ""} onChange={(e) => edit("careerStage", (e.target.value || undefined) as Profile["careerStage"])}>
          <option value="">Not said</option>
          <option value="student">Student</option>
          <option value="new-grad">New graduate</option>
          <option value="experienced">Experienced</option>
          <option value="career-change">Changing careers</option>
        </select>
      </label>
      <label>
        Years of experience (optional)
        <input
          type="number"
          min={0}
          max={70}
          step={1}
          value={profile.yearsExperience ?? ""}
          onChange={(e) => edit("yearsExperience", e.target.value === "" ? undefined : Math.max(0, Math.min(70, Number(e.target.value))))}
        />
      </label>
    </>
  );
}

export function LocaleEditor({ profile, edit }: { profile: Profile; edit: Edit }) {
  const locale = profile.locale || {};
  return (
    <>
      <label>
        Date format where a form does not show one
        <select
          value={locale.dateFormat || ""}
          onChange={(e) => edit("locale", { ...locale, dateFormat: (e.target.value || undefined) as NonNullable<Profile["locale"]>["dateFormat"] })}
        >
          <option value="">By my country (MM/DD/YYYY in the U.S., else DD/MM/YYYY)</option>
          <option value="MM/DD/YYYY">MM/DD/YYYY</option>
          <option value="DD/MM/YYYY">DD/MM/YYYY</option>
          <option value="YYYY-MM-DD">YYYY-MM-DD</option>
        </select>
      </label>
      <label>
        Letter paper size
        <select
          value={locale.paperSize || ""}
          onChange={(e) => edit("locale", { ...locale, paperSize: (e.target.value || undefined) as NonNullable<Profile["locale"]>["paperSize"] })}
        >
          <option value="">By my country (Letter in the U.S. and Canada, else A4)</option>
          <option value="letter">Letter</option>
          <option value="a4">A4</option>
        </select>
      </label>
    </>
  );
}
