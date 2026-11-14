import { realSchools } from "../support/schools";

// An iCIMS-like candidate profile, modelled on a captured application:
// collection rows with search dropdowns (a hidden native select behind each
// anchor, an unfiltered first page on opening, server-like search results a
// moment after typing), address country/state dropdowns where picking a
// country clears the state, a resume uploader that "parses" the resume and
// reloads with its own guesses, and per-row Delete controls.
const allSchools = [
  "*School Not Found (enter into Other School)",
  "Aarhus School of Architecture",
  "Abilene Christian University",
  ...realSchools.filter((school) => !school.startsWith("Pennsylvania State University")).flatMap((school) =>
    // A resume parser's own spelling sits beside the list's.
    school === "Michigan State University" ? [school, "Michigan state university"] : [school],
  ),
  "Pennsylvania State University-Penn State Harrisburg",
  "Pennsylvania State University-University Park",
];
const degrees = ["Associates Degree", "Bachelors Degree", "High School or Equivalent", "Masters Degree"];
const majors = ["Accounting", "Computer Networks", "Computer Science", "Data Science", "Engineering"];

const dropdown = (row: string, group: string, field: string, label: string) => `
  <div class="iCIMS_TableRow">
    <label>${label}</label>
    <!-- iCIMS keeps a hidden native select that holds the real choice,
         including a resume parser's pick. -->
    <select id="${row}_${group}.${field}" name="${row}_${group}.${field}" class="dropdown-hide" style="display: none">
      <option value="-1" selected>— Make a Selection —</option>
    </select>
    <a id="${row}_${group}.${field}_icimsDropdown" class="dropdown-select" role="combobox" aria-label="${label}" data-list="${field}" href="javascript:void(0)"><span class="dropdown-text">— Make a Selection —</span></a>
    <div class="dropdown-panel" hidden>
      <input type="text" class="dropdown-search" placeholder="— Type to Search —" aria-label="— Type to Search —" role="combobox" aria-controls="${row}_${group}.${field}_dropdown-results">
      <ul class="dropdown-results" id="${row}_${group}.${field}_dropdown-results"></ul>
    </div>
  </div>`;

const educationRow = (row: string, position: number) => `
  <div class="iCIMS_CollectionContainer">
    <fieldset>
      <legend><span class="iCIMS_LabelText">Education (${position})</span></legend>
      ${position > 1 ? `<a role="button" aria-label="Delete Education (${position})" href="javascript:void(0)" onclick="hideGroup('CandProfileFields.Education', '${row}')">×</a>` : ""}
      ${dropdown(row, "CandProfileFields", "School", "School Dropdown")}
      <div class="iCIMS_TableRow"><label>Other School</label><input type="text" name="${row}_CandProfileFields.OtherSchool"></div>
      ${dropdown(row, "CandProfileFields", "Degree", "Degree")}
      ${dropdown(row, "CandProfileFields", "Major", "Major")}
      <div class="iCIMS_TableRow"><label>Did You Graduate?
        <select id="${row}_CandProfileFields.IsGraduated" name="${row}_CandProfileFields.IsGraduated" data-label="Did You Graduate?" class=" iCIMS_Forms_Global customFieldContainer iCIMS_Forms_ListEditorField iCIMS_Forms_Qnull form-control" aria-label="Did You Graduate?" type="3081" icimsdropdown-enabled="0" icimsdropdown-ajax="1" icimsdropdown-search="0">
          <option value="" legacy="true"></option><option title="In Progress" value="28595">In Progress</option><option title="Not Received" value="28596">Not Received</option><option title="Received" value="28598">Received</option>
        </select></label></div>
      <div class="iCIMS_TableRow"><label>Start Date</label>
        <select aria-label="Start Date Month" name="${row}_CandProfileFields.EducationStartDate_Month">
          <option value="0"></option>${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((m, i) => `<option value="${String(i + 1).padStart(2, "0")}">${m}</option>`).join("")}
        </select>
        <div class="iCIMS_DateField-Day"><select aria-label="Start Date Day" name="${row}_CandProfileFields.EducationStartDate_Date">
          <option value="0"></option>${Array.from({ length: 31 }, (_, i) => `<option>${i + 1}</option>`).join("")}
        </select></div>
        <div class="iCIMS_DateField-Year"><input type="text" aria-label="Start Date Year" name="${row}_CandProfileFields.EducationStartDate_Year"></div>
      </div>
    </fieldset>
  </div>`;

export function icimsCandidatePage(options: { schoolListed?: boolean; swapped?: boolean } = {}) {
  const schools = allSchools.filter(
    (school) => options.schoolListed !== false || school !== "Pennsylvania State University-University Park",
  );
  const lists = {
    School: schools,
    Degree: degrees,
    Major: majors,
    AddressCountry: ["Canada", "United States"],
    AddressState: ["Arizona", "California", "Texas"],
  };
  // Swapped: both schools shown exactly as listed, the other way round from
  // the profile, as one employer's iCIMS redrew them.
  const rows = options.swapped
    ? educationRow("-1", 1) + educationRow("-2", 2)
    : educationRow("-3", 1) + educationRow("-1", 2) + educationRow("-2", 3);
  return `<!doctype html><meta charset="utf-8"><title>Candidate Profile</title><form>
    <div><h3>Resume</h3>
      <p>Provide your resume below to pre-fill your profile. Existing data in the form will be replaced.</p>
      <label>Please upload your resume<input type="file" name="PortalProfileFields.Resume_File" accept=".pdf,.docx"></label>
      <div id="PortalProfileFields.Resume_FileNameLabel" class="iCIMS_NoDisplay"><span></span></div>
    </div>
    <fieldset><legend><span class="iCIMS_LabelText">Addresses (1)</span></legend>
      ${dropdown("-1", "PersonProfileFields", "AddressCountry", "Country")}
      ${dropdown("-1", "PersonProfileFields", "AddressState", "State/Province")}
    </fieldset>
    <div id="education">${educationRow("-3", 1)}</div>
  </form>
  <script>
    const lists = ${JSON.stringify(lists)};
    window.uploads = Number(sessionStorage.getItem("uploads") || 0);
    window.stateResets = 0;
    window.hideGroup = (group, row) => {
      document.querySelector('[name^="' + row + '_CandProfileFields"]').closest(".iCIMS_CollectionContainer").remove();
    };
    const listOf = (element) => lists[element.closest(".iCIMS_TableRow").querySelector("a.dropdown-select").dataset.list];
    const show = (ul, options) => {
      ul.innerHTML = options.map((option) => '<li class="dropdown-result result-selectable" role="option">' + option + "</li>").join("");
    };
    const setText = (anchor, text) => {
      anchor.querySelector(".dropdown-text").textContent = text;
      anchor.parentElement.querySelector("select").innerHTML = "<option selected>" + text + "</option>";
    };
    const choose = (anchor, text) => {
      setText(anchor, text);
      anchor.parentElement.querySelector(".dropdown-panel").hidden = true;
      // Picking a country clears the state, as iCIMS does.
      if (anchor.dataset.list === "AddressCountry") {
        window.stateResets++;
        setText(document.getElementById("-1_PersonProfileFields.AddressState_icimsDropdown"), "— Make a Selection —");
      }
    };
    // Like iCIMS: a dropdown opens on mousedown (a click alone does
    // nothing), and a result is chosen on mouseup/click.
    document.addEventListener("mousedown", (event) => {
      const anchor = event.target.closest("a.dropdown-select");
      if (!anchor || event.button !== 0) return;
      const panel = anchor.parentElement.querySelector(".dropdown-panel");
      panel.hidden = !panel.hidden;
      anchor.setAttribute("aria-expanded", String(!panel.hidden));
      const ul = panel.querySelector("ul");
      ul.innerHTML = "";
      // The first page of options arrives unfiltered.
      if (!panel.hidden) setTimeout(() => show(ul, listOf(anchor).slice(0, 25)), 200);
    });
    document.addEventListener("click", (event) => {
      const item = event.target.closest("li.result-selectable");
      if (item) {
        const anchor = item.closest(".iCIMS_TableRow").querySelector("a.dropdown-select");
        anchor.setAttribute("aria-expanded", "false");
        choose(anchor, item.textContent);
      }
    });
    // Searching happens on key release, not on a value change.
    document.addEventListener("keyup", (event) => {
      if (!event.target.matches(".dropdown-search")) return;
      const ul = event.target.parentElement.querySelector("ul");
      const term = event.target.value.toLowerCase();
      const list = listOf(event.target);
      // Search results come from the server a moment later.
      setTimeout(() => show(ul, list.filter((option) => option.toLowerCase().includes(term))), 800);
    });
    if (sessionStorage.getItem("parsed")) {
      const label = document.getElementById("PortalProfileFields.Resume_FileNameLabel");
      label.className = "iCIMS_CurrentFile";
      label.querySelector("span").textContent = sessionStorage.getItem("parsed");
      // The parser's guesses: three rows for two schools, one school twice
      // (a real but oddly spelled list entry), a wrong "Received", and an address.
      document.getElementById("education").innerHTML = ${JSON.stringify(rows)};
      const shownSchools = ${JSON.stringify(options.swapped
        ? { "-1": "Pennsylvania State University-University Park", "-2": "Michigan State University" }
        : { "-1": "Michigan state university", "-2": "Michigan state university" })};
      for (const row of ["-1", "-2"]) {
        document.getElementById(row + "_CandProfileFields.School_icimsDropdown").querySelector(".dropdown-text").textContent = shownSchools[row];
        document.getElementById(row + "_CandProfileFields.School").innerHTML = '<option value="42767" selected>' + shownSchools[row] + '</option>';
      }
      document.getElementById("-1_CandProfileFields.IsGraduated").value = "28598";
      // and a right one, for the school that ends up second.
      document.getElementById("-2_CandProfileFields.IsGraduated").value = "28598";
      setText(document.getElementById("-1_PersonProfileFields.AddressCountry_icimsDropdown"), "United States");
      setText(document.getElementById("-1_PersonProfileFields.AddressState_icimsDropdown"), "Arizona");
    }
    document.querySelector('[name="PortalProfileFields.Resume_File"]').addEventListener("change", (event) => {
      sessionStorage.setItem("uploads", String(window.uploads + 1));
      sessionStorage.setItem("parsed", event.target.files[0].name);
      setTimeout(() => location.reload(), 1500);
    });
  </script>`;
}

// ICE's iCIMS candidate profile, drawn as
// captured: each list an <a role="combobox"> with its "_ctnr" box beside it
// (search box and results), a hidden select behind it, Add More (Education)
// adding a row in place, a "most recent degree" question after the
// education rows, job rows, a Language row whose levels are Proficient,
// Medium and Basic, and a native How did you hear list. Its resume parser
// opens the page again at another address (…&uploadResume=1), with one
// school, a city for a major and the second job's employer left empty.
const capturedDropdown = (id: string, label: string, options: string[], labelled = true) => `
    <select id="${id}" name="${id}" data-label="${label}" class="iCIMS_Forms_Global customFieldContainer iCIMS_Forms_DropDown form-control dropdown-hide" style="display:none"><option value="" legacy="true" selected=""></option></select><a id="${id}_icimsDropdown" class="dropdown-select" aria-expanded="false" tabindex="0" ${labelled ? `aria-labelledby="label_${id}"` : ""} role="combobox" aria-label="${label}"><span id="${id}_fakeSelected_icimsDropdown" class="dropdown-text"><span class="dropdown-placeholder">— Make a Selection —</span></span></a><div id="${id}_icimsDropdown_ctnr" class="dropdown-container dropdown-invisible" data-options="${encodeURIComponent(JSON.stringify(options))}"><input type="text" class="dropdown-search dropdown-invisible" autocomplete="off" placeholder="— Type to Search —" aria-label="— Type to Search —" role="combobox" aria-hidden="true"><div aria-live="polite"><ul id="${id}_dropdown-results" class="dropdown-results" role="listbox"></ul></div></div>`;
const capturedRow = (collection: string, index: number, id: string, label: string, control: string) => `
    <div data-collection="${collection}" data-index="${index}" class="${collection}-${index} iCIMS_TableRow iCIMS_FieldRow_Inline"><div class="iCIMS_InfoField iCIMS_InfoField_Candidate iCIMS_CollectionField iCIMS_TableCell"><label id="label_${id}" for="${id}"><span class="iCIMS_LabelText" name="labelText">${label}</span></label></div><div class="iCIMS_InfoData iCIMS_InfoData_Candidate iCIMS_CollectionField iCIMS_TableCell">${control}</div></div>`;
const text = (id: string, extra = "") => `<input type="text" id="${id}" name="${id}" class="iCIMS_Forms_Global customFieldContainer iCIMS_Forms_TextField form-control" ${extra}>`;
const capturedEducation = (row: number) => `
  <div tabindex="-1" class="iCIMS_CollectionContainer CandProfileFields.Education-${row}-Container"><fieldset class="iCIMS_CollectionGroup"><legend><span class="iCIMS_LabelText" id="CandProfileFields.Education_-${row}_label">Education (${row})</span></legend>
    ${capturedRow("CandProfileFields.Education", row, `-${row}_CandProfileFields.Degree`, "Degree", capturedDropdown(`-${row}_CandProfileFields.Degree`, "Degree", ["Associate's Degree/College Diploma", "Bachelor's Degree", "Doctorate Degree", "High School Diploma/GED", "Master's Degree"]))}
    ${capturedRow("CandProfileFields.Education", row, `-${row}_CandProfileFields.EducationCity`, "Major", text(`-${row}_CandProfileFields.EducationCity`, 'maxlength="64"'))}
    ${capturedRow("CandProfileFields.Education", row, `-${row}_CandProfileFields.School`, "School", capturedDropdown(`-${row}_CandProfileFields.School`, "School", ["*School Not Found (enter into Other School)", "Penn State", "Virginia Tech"]))}
    ${capturedRow("CandProfileFields.Education", row, `-${row}_CandProfileFields.OtherSchool`, "Other School, if not listed", text(`-${row}_CandProfileFields.OtherSchool`, 'maxlength="256"'))}
  </fieldset></div>`;
const capturedJob = (row: number, employer: string, title: string) => `
  <div tabindex="-1" class="iCIMS_CollectionContainer rcf3211-${row}-Container"><fieldset class="iCIMS_CollectionGroup"><legend><span class="iCIMS_LabelText" id="rcf3211_-${row}_label">Professional Experience (${row})</span></legend>
    ${capturedRow("rcf3211", row, `-${row}_PersonProfileFields.rcf3212`, "Employer Name", text(`-${row}_PersonProfileFields.rcf3212`, `maxlength="128" aria-required="true" value="${employer}"`))}
    ${capturedRow("rcf3211", row, `-${row}_PersonProfileFields.rcf3213`, "Job Title", text(`-${row}_PersonProfileFields.rcf3213`, `maxlength="64" aria-required="true" value="${title}"`))}
  </fieldset></div>`;
const languages = ["Afrikaans", "Albanian", "Arabic", "Armenian", "Basque", "Bengali", "Bulgarian", "Catalan", "Chinese", "Croatian", "Czech", "Danish", "Dutch", "English", "Estonian", "French", "German", "Hindi", "Spanish"];

export function icimsProfileAfterUpload() {
  const field = (id: string, label: string, control: string) => `
    <div class="iCIMS_TableRow iCIMS_FieldRow"><div class="iCIMS_InfoField iCIMS_InfoField_Candidate iCIMS_TableCell"><label tabindex="-1" id="label_${id}" for="${id}">${label}</label></div><div class="iCIMS_InfoData iCIMS_InfoData_Candidate iCIMS_TableCell">${control}</div></div>`;
  const address = (id: string, label: string, control: string) => capturedRow("PersonProfileFields.Addresses", 1, id, label, control);
  return `<!doctype html><meta charset="utf-8"><title>Candidate Profile - 2026-100</title>
  <style>.dropdown-invisible{display:none}</style>
  <form name="profileForm">
    <div role="group"><h2 class="iCIMS_SubHeader">Resume</h2>
      <label id="label_PortalProfileFields.Resume_File" for="PortalProfileFields.Resume_File">Resume</label>
      <p>Provide your resume below to pre-fill your profile. Existing data in the form will be replaced.</p>
      <input type="file" id="PortalProfileFields.Resume_File" name="PortalProfileFields.Resume_File">
      <div id="PortalProfileFields.Resume_FileNameLabel" class="iCIMS_NoDisplay"><span></span></div>
    </div>
    <div role="group"><h2 class="iCIMS_SubHeader">Enter your information</h2>
      ${field("PersonProfileFields.FirstName", "First Name", text("PersonProfileFields.FirstName", 'autocomplete="given-name"'))}
      ${field("PersonProfileFields.LastName", "Last Name", text("PersonProfileFields.LastName", 'autocomplete="family-name"'))}
    </div>
    <div role="group"><h2 class="iCIMS_SubHeader">Addresses</h2>
      <div tabindex="-1" class="iCIMS_CollectionContainer PersonProfileFields.Addresses-1-Container"><fieldset class="iCIMS_CollectionGroup"><legend><span class="iCIMS_LabelText">Addresses (1)</span></legend>
        ${address("-1_PersonProfileFields.AddressCountry", "Country", capturedDropdown("-1_PersonProfileFields.AddressCountry", "Country", ["United States", "Canada"]))}
        ${address("-1_PersonProfileFields.AddressState", "State/Province", capturedDropdown("-1_PersonProfileFields.AddressState", "State/Province", ["Arizona", "Virginia"]))}
        ${address("-1_PersonProfileFields.AddressCity", "City", text("-1_PersonProfileFields.AddressCity", 'maxlength="64" autocomplete="address-level2" aria-required="true"'))}
        ${address("-1_PersonProfileFields.AddressZip", "Zip/Postal Code", text("-1_PersonProfileFields.AddressZip", 'maxlength="16" autocomplete="postal-code" aria-required="true"'))}
        ${address("-1_PersonProfileFields.AddressStreet1", "Address", text("-1_PersonProfileFields.AddressStreet1", 'maxlength="128" autocomplete="street-address" aria-required="true"'))}
      </fieldset></div>
    </div>
    <div role="group"><h2 class="iCIMS_SubHeader">Education</h2>
      <div id="education">${capturedEducation(1)}</div>
      <div class="iCIMS_CollectionButtonsRow"><a role="button" class="iCIMS_Anchor" href="javascript:void(0)" id="CandProfileFields.EducationButton_-1">Add More (Education)</a></div>
      <div class="iCIMS_TableRow iCIMS_FieldRow iCIMS_FieldRow_rcf2216"><div class="iCIMS_InfoField iCIMS_InfoField_Candidate iCIMS_TableCell"><label tabindex="-1" id="label_rcf2216" for="rcf2216">Did you complete the most recent degree listed, and receive notice of your graduation?</label><span class="Field_Required"><span class="Field_RequiredStar">* </span></span></div><div class="iCIMS_InfoData iCIMS_InfoData_Candidate iCIMS_TableCell">${capturedDropdown("rcf2216", "Did you complete the most recent degree listed, and receive notice of your graduation?", ["Yes", "No"])}</div></div>
    </div>
    <div role="group"><h2 class="iCIMS_SubHeader">Work Experience</h2><div id="work"></div></div>
    <div role="group"><h2 class="iCIMS_SubHeader">Language</h2>
      <div tabindex="-1" class="iCIMS_CollectionContainer rcf2026-1-Container"><fieldset class="iCIMS_CollectionGroup"><legend><span class="iCIMS_LabelText">Language (1)</span></legend>
        ${capturedRow("rcf2026", 1, "-1_PersonProfileFields.rcf2027", "Language", capturedDropdown("-1_PersonProfileFields.rcf2027", "Language", languages))}
        ${["Reading", "Writing", "Speaking"].map((skill, at) => capturedRow("rcf2026", 1, `-1_PersonProfileFields.rcf20${28 + at}`, skill, capturedDropdown(`-1_PersonProfileFields.rcf20${28 + at}`, skill, ["Proficient", "Medium", "Basic"]))).join("")}
      </fieldset></div>
    </div>
    <div role="group"><h2 class="iCIMS_SubHeader">Additional Data</h2>
      ${field("rcf3048", "How did you hear about us?", `<select id="rcf3048" name="rcf3048" data-label="How did you hear about us?" class="iCIMS_Forms_Global customFieldContainer iCIMS_Forms_DropDown form-control" aria-labelledby="label_rcf3048" aria-required="true"><option legacy="true" value="" selected="">— Make a Selection —</option>${["Agency", "Company Website", "Employee Referral", "Glassdoor", "Indeed", "LinkedIn", "Naukri", "Other (Please Specify)", "Recruiting Event", "University or School Event"].map((option) => `<option title="${option}" value="${option}">${option}</option>`).join("")}</select>`)}
    </div>
  </form>
  <script>
    window.uploads = Number(sessionStorage.getItem("uploads") || 0);
    // A list's first page is 12 entries; the rest are found by searching.
    const optionsOf = (anchor) => JSON.parse(decodeURIComponent(document.getElementById(anchor.id + "_ctnr").dataset.options));
    const show = (anchor, options) => {
      const ul = document.getElementById(anchor.id.replace(/_icimsDropdown$/, "") + "_dropdown-results");
      ul.innerHTML = ["— Make a Selection —", ...options].map((option) => '<li class="dropdown-result result-selectable" role="option">' + option + "</li>").join("");
    };
    const pick = (anchor, value) => {
      anchor.querySelector(".dropdown-text").textContent = value;
      const select = document.getElementById(anchor.id.replace(/_icimsDropdown$/, ""));
      select.innerHTML = '<option selected value="' + value + '">' + value + "</option>";
    };
    // It opens on a mousedown; a click alone does nothing, as on iCIMS.
    document.addEventListener("mousedown", (event) => {
      const anchor = event.target.closest("a.dropdown-select");
      if (!anchor || event.button !== 0) return;
      const box = document.getElementById(anchor.id + "_ctnr");
      const opening = box.classList.contains("dropdown-invisible");
      box.classList.toggle("dropdown-invisible", !opening);
      box.querySelector(".dropdown-search").classList.toggle("dropdown-invisible", !opening);
      anchor.setAttribute("aria-expanded", String(opening));
      if (opening) setTimeout(() => show(anchor, optionsOf(anchor).slice(0, 12)), 150);
    });
    document.addEventListener("click", (event) => {
      const item = event.target.closest("li.result-selectable");
      if (item) {
        const box = item.closest(".dropdown-container");
        const anchor = document.getElementById(box.id.replace(/_ctnr$/, ""));
        pick(anchor, item.textContent);
        box.classList.add("dropdown-invisible");
        anchor.setAttribute("aria-expanded", "false");
        return;
      }
      // Add More (Education) draws the next row in place.
      if (event.target.closest('a[id^="CandProfileFields.EducationButton"]')) {
        const rows = document.querySelectorAll("#education .iCIMS_CollectionContainer").length;
        document.getElementById("education").insertAdjacentHTML("beforeend", ${JSON.stringify(capturedEducation(2))}.replaceAll("-2_", "-" + (rows + 1) + "_").replaceAll("Education-2", "Education-" + (rows + 1)).replaceAll("Education (2)", "Education (" + (rows + 1) + ")"));
      }
    });
    // Searching happens on key release; results come a moment later.
    document.addEventListener("keyup", (event) => {
      if (!event.target.matches(".dropdown-search")) return;
      const box = event.target.closest(".dropdown-container");
      const anchor = document.getElementById(box.id.replace(/_ctnr$/, ""));
      const term = event.target.value.toLowerCase();
      setTimeout(() => show(anchor, optionsOf(anchor).filter((option) => option.toLowerCase().includes(term))), 400);
    });
    if (sessionStorage.getItem("parsed")) {
      // What the parser made of the resume: one school with a city for its
      // major and no degree, and the second job's employer left empty.
      // The file it read is named beside the uploader, as captured.
      document.getElementById("PortalProfileFields.Resume_FileNameLabel").className = "iCIMS_CurrentFile";
      document.getElementById("PortalProfileFields.Resume_FileNameLabel").querySelector("span").textContent = sessionStorage.getItem("parsed");
      document.getElementById("PersonProfileFields.FirstName").value = "Alex";
      document.getElementById("PersonProfileFields.LastName").value = "Rivera";
      pick(document.getElementById("-1_PersonProfileFields.AddressCountry_icimsDropdown"), "United States");
      pick(document.getElementById("-1_PersonProfileFields.AddressState_icimsDropdown"), "Virginia");
      document.getElementById("-1_PersonProfileFields.AddressCity").value = "Blacksburg";
      pick(document.getElementById("-1_CandProfileFields.School_icimsDropdown"), "Virginia Tech");
      document.getElementById("-1_CandProfileFields.EducationCity").value = "Blacksburg";
      document.getElementById("work").innerHTML = ${JSON.stringify(capturedJob(1, "Northwind Labs", "Associate") + capturedJob(2, "", "Founder") + capturedJob(3, "Acme", "Software Engineer Intern"))};
    } else {
      document.getElementById("work").innerHTML = ${JSON.stringify(capturedJob(1, "", ""))};
    }
    document.getElementById("PortalProfileFields.Resume_File").addEventListener("change", (event) => {
      sessionStorage.setItem("uploads", String(window.uploads + 1));
      sessionStorage.setItem("parsed", event.target.files[0].name);
      // The parsed profile opens at another address, not a reload.
      setTimeout(() => { location.href = location.pathname + "?from=login&csrf=fixture&hashed=fixture&uploadResume=1"; }, 1500);
    });
  </script>`;
}
