import { emptyProfile, type Narrative, type Profile } from "../../src/shared/model";

export const resumeProfile = (): Profile => ({
  ...emptyProfile,
  firstName: "Alex",
  lastName: "Rivera",
  email: "alex.rivera@example.com",
  phone: "(555) 010-2030",
  city: "Phoenix",
  state: "AZ",
  linkedin: "https://www.linkedin.com/in/alex-rivera",
  website: "https://alexrivera.dev",
  github: "https://github.com/alexrivera",
  skills: ["TypeScript", "React", "Node.js", "PostgreSQL", "AWS", "Docker", "GraphQL", "Python", "CI/CD", "Accessibility (WCAG 2.1)"],
  languages: ["English: Native", "Spanish: Professional"],
  work: [
    {
      organization: "Northwind Health",
      title: "Senior Software Engineer",
      startDate: "2022-03",
      endDate: "",
      location: "Phoenix, AZ",
      details:
        "- Led a team of four building the patient scheduling platform used by 40 clinics\n- Cut median API response times by 30% by reworking query plans and adding caching\n- Introduced end-to-end testing that caught regressions before release",
    },
    {
      organization: "Contoso Labs",
      title: "Software Engineer",
      startDate: "2019-06-01",
      endDate: "2022-02",
      location: "Lansing, MI",
      details:
        "• Built TypeScript interfaces for internal analytics dashboards\n• Migrated a legacy jQuery front end to React with no downtime\n• Mentored two interns through their first production releases",
    },
  ],
  education: [
    {
      organization: "Michigan State University",
      title: "B.S.",
      fieldOfStudy: "Computer Science",
      startDate: "2015-08",
      endDate: "2019-05",
      location: "Lansing, MI",
      details: "Dean's List; capstone on accessible web forms",
    },
  ],
});

export const resumeNarrative = (texts = [
  "Improved application response times by 30% for a scheduling platform serving 40 clinics.",
  "Built TypeScript interfaces and React dashboards used daily by 200+ analysts.",
  "Raised test coverage from 45% to ≥80% across three services.",
]): Narrative => ({
  resume: texts.map((text, i) => ({ factId: `f${i}`, text })),
  coverLetter: [],
  answers: [],
});
