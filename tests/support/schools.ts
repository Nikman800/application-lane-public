// A school list as application forms show one: real universities in
// alphabetical order, with near misses for the fixtures' schools (Michigan
// State's law college and its neighbours, Penn State's other campuses,
// Virginia schools that share words with Virginia Tech). Fixtures add their
// own "Other" choices and leave out the school a test needs missing.
export const realSchools = [
  "Boston University",
  "Bucknell University",
  "Carnegie Mellon University",
  "Central Michigan University",
  "Clemson University",
  "Cornell University",
  "Duke University",
  "Eastern Michigan University",
  "Georgia Institute of Technology",
  "Indiana University Bloomington",
  "Michigan State University",
  "Michigan State University College of Law",
  "Michigan Technological University",
  "Northwestern University",
  "Ohio University",
  "Pennsylvania State University-Penn State Harrisburg",
  "Purdue University",
  "Rutgers University-New Brunswick",
  "Stanford University",
  "Temple University",
  "The Ohio State University",
  "University of Florida",
  "University of Michigan",
  "University of Pittsburgh",
  "University of Virginia",
  "Virginia Commonwealth University",
  "Virginia Polytechnic Institute and State University",
  "Virginia State University",
  "Virginia Tech Carilion School of Medicine",
  "Western Michigan University",
];

// The list without the named schools.
export const schoolsWithout = (...missing: string[]) => realSchools.filter((school) => !missing.includes(school));
