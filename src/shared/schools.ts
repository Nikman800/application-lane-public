// Other names of the same school, for lists that name it differently from
// the profile. Each is the whole name of that one school: a list's other
// schools that only share words with it ("Virginia Tech Carilion School of
// Medicine", "Michigan State University College of Law", another campus)
// are never among them.

// A school's common name and its official ones, which nothing in the names
// themselves relates: "Virginia Tech" is Virginia Polytechnic Institute and
// State University. An initialism is listed only where it names one school
// (not "MSU" or "USC", which name several).
const known: string[][] = [
  ["Virginia Tech", "Virginia Polytechnic Institute and State University"],
  ["Penn State", "Penn State University", "Pennsylvania State University"],
  ["Georgia Tech", "Georgia Institute of Technology"],
  ["MIT", "Massachusetts Institute of Technology"],
  ["Caltech", "California Institute of Technology"],
  ["Ohio State", "Ohio State University"],
  ["Michigan State", "Michigan State University"],
  ["UC Berkeley", "University of California, Berkeley"],
  ["UCLA", "University of California, Los Angeles"],
  ["UC San Diego", "UCSD", "University of California, San Diego"],
  ["UC Davis", "University of California, Davis"],
  ["UC Irvine", "University of California, Irvine"],
  ["UT Austin", "University of Texas at Austin"],
  ["Texas A&M", "Texas A&M University", "Texas A&M University-College Station"],
  ["UNC Chapel Hill", "University of North Carolina at Chapel Hill"],
  ["UIUC", "University of Illinois Urbana-Champaign", "University of Illinois at Urbana-Champaign"],
  ["UMass Amherst", "University of Massachusetts Amherst"],
  ["UW-Madison", "University of Wisconsin-Madison"],
  ["NYU", "New York University"],
  ["Carnegie Mellon", "Carnegie Mellon University"],
  ["Johns Hopkins", "Johns Hopkins University"],
  ["Purdue", "Purdue University"],
  ["Ole Miss", "University of Mississippi"],
  ["UVA", "University of Virginia"],
];

const plain = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
// The name without what lists add or leave out around it: a leading "The"
// ("The Ohio State University") and a trailing "Main Campus" ("Purdue
// University-Main Campus", as the federal college lists name a flagship).
const core = (text: string) => plain(text).replace(/^the /, "").replace(/ main campus$/, "");

// Most useful first: its other names, then the same with "The" and "Main
// Campus" added or left off. A search tries only the first few.
export function schoolNames(name: string): string[] {
  const own = core(name);
  if (!own) return [];
  const bare = name.trim().replace(/^the\s+/i, "").replace(/[\s,\u2013\u2014-]*main campus$/i, "").trim();
  const wordings = [...new Set([bare, ...(known.find((group) => group.some((other) => core(other) === own)) || [])])];
  const formal = wordings.filter((wording) => /\b(university|college|institute)\b/i.test(wording));
  return [
    ...new Set([...wordings, ...formal.map((wording) => `The ${wording}`), ...formal.map((wording) => `${wording} Main Campus`)]),
  ].filter((wording) => plain(wording) !== plain(name));
}
