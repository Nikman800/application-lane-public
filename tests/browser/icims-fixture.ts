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
