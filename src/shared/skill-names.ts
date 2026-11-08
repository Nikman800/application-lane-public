// Workday's skill library names some skills its own way: a search for "C#"
// answers "C Sharp (Programming Language)", "SQL" answers "Structured Query
// Language (SQL)", "C++" answers "C++ Programming Language". A skill is searched by the applicant's own name and picked
// under any of these.
const aliases: Record<string, string[]> = {
  "c#": ["C Sharp (Programming Language)", "C Sharp"],
  "c++": ["C++ Programming Language", "C++ (Programming Language)"],
  sql: ["Structured Query Language (SQL)"],
  javascript: ["JavaScript (Programming Language)"],
  typescript: ["TypeScript (Programming Language)"],
  go: ["Go (Programming Language)", "Golang"],
  golang: ["Go (Programming Language)"],
  r: ["R (Programming Language)"],
  nlp: ["Natural Language Processing (NLP)"],
  ml: ["Machine Learning (ML)", "Machine Learning"],
  ai: ["Artificial Intelligence (AI)", "Artificial Intelligence"],
  "node.js": ["Node.js", "Node.Js"],
  aws: ["Amazon Web Services (AWS)"],
  gcp: ["Google Cloud Platform (GCP)", "Google Cloud Platform"],
};

export function skillNames(skill: string): string[] {
  const own = skill.trim();
  const named = aliases[own.toLowerCase()] || [];
  return [...new Set([`${own} Programming Language`, ...named])].filter((name) => name.toLowerCase() !== own.toLowerCase());
}
