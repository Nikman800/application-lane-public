import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileSchema, type GenerationRequest } from "../src/shared/model";
import { GenerationQueue, provider } from "../src/server/generation";
import { configSchema, Store } from "../src/server/store";
import { extractResume } from "../src/server/documents";

// These run the real engine in tailor/ against a synthetic resume. Without
// pdflatex or Python only the fallback test runs.
const python = process.platform === "win32" ? "python" : "python3";
const available = await (async () => {
  try {
    await promisify(execFile)("pdflatex", ["--version"]);
    await promisify(execFile)(python, ["--version"]);
    return true;
  } catch {
    return false;
  }
})();
const engine = { skip: available ? false : "no pdflatex or no Python" };

// The applicant's tailoring folder: every .tex file under resumes/ is a
// variant, named by its file name.
const resume = String.raw`\documentclass[11pt]{article}
\usepackage[margin=0.7in]{geometry}
\pagenumbering{gobble}
\begin{document}
\begin{center}
{\Large Alex Fixture}\\
Phoenix, AZ \,|\, test@example.test
\end{center}
\section*{Summary}
Software engineer who built a Redis Streams fan-out backend serving 900 users and shipped TypeScript APIs.
\section*{Technical Skills}
\textbf{Languages:} Python, TypeScript, Go\\
\textbf{Datastores:} PostgreSQL, Redis (Cluster, Streams)
\section*{Experience}
\textbf{Platform Engineer} \hfill \textit{2024 -- Present}\\
Built TypeScript interfaces and automated tests.

\textbf{Hackathon App} \hfill \textit{2023}\\
Organized weekly team meetings.
\end{document}
`;
const configured = await mkdtemp(join(tmpdir(), "lane-job-apply-home-"));
const sources = join(configured, "resumes");
await mkdir(sources);
await writeFile(
  join(sources, "Alex_Rivera_Software_Engineer_Resume.tex"),
  resume,
);
// The notes and guides answers are written from: present, and beside the point here.
await writeFile(join(configured, "profile.md"), "## Experience\n- Built a Redis Streams fan-out backend.\n");
await writeFile(join(configured, "preferences.md"), "## Logistics (confirmed)\n- **Earliest start date:** Immediately.\n");
await mkdir(join(configured, "references"));
await writeFile(join(configured, "references", "common-questions.md"), "Why here: tie a posting signal to real work.");
await writeFile(join(configured, "references", "anti-fabrication.md"), "Never invent employers or metrics.");

const profile = profileSchema.parse({
  firstName: "Alex",
  lastName: "Fixture",
  email: "test@example.test",
  confirmed: true,
  revision: 1,
  facts: [
    { id: "a", text: "Built TypeScript interfaces and automated tests at matched accuracy (R 2 0.86)." },
    {
      id: "b",
      text: "Built a Redis Streams fan-out backend serving 900 users, ∼ 3x the load I planned for.",
    },
  ],
});
const posting =
  "Initech is hiring a backend engineer to build TypeScript services on Redis and PostgreSQL. " +
  "You will design APIs, own fan-out delivery for real-time feeds, write automated tests, " +
  "and work with product engineers to ship features that reach thousands of users every day. " +
  "Experience with streaming systems and caching is a plus. " +
  // Long enough to read as a posting rather than a form (postingReadable).
  "About the role: the platform team runs the services behind every customer dashboard, from ingest " +
  "to the APIs the web and mobile clients call. Responsibilities include designing and reviewing service " +
  "interfaces, keeping latency low under bursty load, writing the tests and runbooks that let the team " +
  "deploy several times a day, and pairing with product engineers on new features. Qualifications: a " +
  "degree in computer science or equivalent experience, comfort with TypeScript or Python, and some " +
  "exposure to message queues, caches or relational databases. Preferred: experience with Redis Streams, " +
  "PostgreSQL tuning, or real-time delivery. Benefits include health coverage, a learning budget and " +
  "flexible hours for the whole engineering organization, with mentorship from senior engineers.";
const request = (description = posting): GenerationRequest => ({
  applicationId: randomUUID(),
  operation: 1,
  profileRevision: 1,
  title: "Backend Engineer",
  company: "Initech",
  description,
  url: "https://example.test/job",
  // A form that takes a cover letter gets one (wantsLetter).
  fields: [
    {
      id: "cover",
      label: "Cover Letter",
      kind: "file",
      required: false,
      value: "",
      options: [],
      revision: 1,
      protected: false,
      documentKind: "cover",
    },
  ],
});
const narrative = {
  resume: ["f2", "f1"],
  coverLetter: [
    {
      text: "I built a Redis Streams fan-out backend serving 900 users — (∼ 3x the load I planned for), which is the delivery work this Backend Engineer role describes.",
      factIds: ["f2"],
    },
    {
      // R² as a PDF's text layer gives it, which the letter writes as R² and
      // pdflatex must still typeset.
      text: "I also built TypeScript interfaces and automated tests, at matched accuracy (R 2 0.86).",
      factIds: ["f1"],
    },
  ],
  answers: [],
};

async function lane(t: TestContext, brief: object, tailorDir = configured) {
  let briefs = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const tailoring = body.includes("Angle one of this applicant");
    if (tailoring) briefs++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify(tailoring ? brief : narrative),
            },
          },
        ],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const config = configSchema.parse({
    postingLookup: false,
    token: "synthetic-token-".repeat(4),
    model: "fixture",
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    tailorDir,
  });
  const directory = await mkdtemp(join(tmpdir(), "lane-job-apply-"));
  const store = new Store(directory);
  await store.init();
  store.data.profile = structuredClone(profile);
  const queue = new GenerationQueue(
    store,
    config,
    provider(config, { diagnostic: () => {} }),
  );
  return {
    briefs: () => briefs,
    async run(req = request()) {
      const job = await queue.enqueue(req);
      const deadline = Date.now() + 60000;
      while (["queued", "running"].includes(job.status)) {
        assert.ok(Date.now() < deadline, "job must settle");
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(job.status, "complete", job.error);
      const text = async (kind: "resume" | "cover") => {
        const artifact = job.artifacts.find(
          (a) => a.kind === kind && a.format === "pdf",
        )!;
        return {
          name: artifact.name,
          text: (
            await extractResume(
              await readFile(
                join(directory, "artifacts", `${artifact.id}.pdf`),
              ),
              "pdf",
            )
          ).replace(/\s+/gu, " "),
        };
      };
      return { job, resume: await text("resume"), cover: await text("cover") };
    },
  };
}

test(
  "the engine reorders the resume, and letters it under the resume's letterhead",
  engine,
  async (t) => {
    const { run } = await lane(t, {
      variant: "Alex_Rivera_Software_Engineer_Resume",
      summary_line:
        "Backend engineer who shipped TypeScript APIs and built a Redis Streams fan-out backend serving 900 users.",
      skills_order: [
        { category: "Languages", items: ["TypeScript", "Python", "Go"] },
        // MongoDB is not on this resume, so this line is skipped.
        {
          category: "Datastores",
          items: ["Redis (Cluster, Streams)", "PostgreSQL", "MongoDB"],
        },
      ],
      lead_sections: ["Summary", "Experience", "Technical Skills"],
      drop_entries: ["Hackathon App"],
      cautions: ["The posting asks for streaming systems at scale."],
    });
    const { job, resume, cover } = await run();
    assert.equal(resume.name, "Alex_Rivera_Software_Engineer_Resume.pdf");
    assert.match(resume.text, /Backend engineer who shipped TypeScript APIs/);
    assert.match(resume.text, /TypeScript, Python, Go/);
    assert.match(resume.text, /PostgreSQL, Redis \(Cluster, Streams\)/);
    assert.doesNotMatch(resume.text, /MongoDB/);
    // The page fits, so the entry the brief offered to drop stays.
    assert.match(resume.text, /Hackathon App/);
    assert.ok(
      resume.text.indexOf("Platform Engineer") <
        resume.text.indexOf("Technical Skills"),
    );
    const tailoring = job.narrative!.tailoring!;
    assert.equal(tailoring.summaryReplaced, true);
    assert.deepEqual(tailoring.cautions, [
      "The posting asks for streaming systems at scale.",
    ]);
    assert.ok(tailoring.changes.includes("reordered Languages skills"));
    assert.ok(!tailoring.changes.includes("dropped Hackathon App"));
    assert.match(job.narrative!.warnings!.join(" "), /MongoDB/);
    // The letter's letterhead is the resume's, above our greeting and close.
    assert.equal(cover.name, "Alex_Fixture_Cover_Letter.pdf");
    assert.match(cover.text, /Alex Fixture Phoenix, AZ/);
    assert.match(
      cover.text,
      /Dear Initech Hiring Team, I built a Redis Streams fan-out backend serving 900 users, \(~ 3x .* describes\. I also built TypeScript interfaces and automated tests, at matched accuracy \(R(²| ?2) 0\.86\)\. Sincerely, Alex Fixture$/,
    );
  },
);

test(
  "a tailored summary naming what the resume does not keeps the resume's own",
  engine,
  async (t) => {
    const { run } = await lane(t, {
      variant: "Alex_Rivera_Software_Engineer_Resume",
      summary_line:
        "Backend engineer who ran Kubernetes at Initech and shipped TypeScript APIs serving 900 users.",
    });
    const { job, resume } = await run();
    assert.match(resume.text, /Software engineer who built a Redis Streams/);
    assert.equal(job.narrative!.tailoring!.summaryReplaced, false);
    assert.match(
      job.narrative!.warnings!.join(" "),
      /Kept your resume's own summary: .*Kubernetes, Initech/,
    );
  },
);

test(
  "the summary stays first, and may open on an adjective",
  engine,
  async (t) => {
    const { run } = await lane(t, {
      variant: "Alex_Rivera_Software_Engineer_Resume",
      summary_line:
        "Experienced backend engineer who built a Redis Streams fan-out backend serving 900 users and shipped TypeScript APIs.",
      // Named last, which would put it at the bottom of the page.
      lead_sections: ["Experience", "Technical Skills", "Summary"],
    });
    const { job, resume } = await run();
    assert.equal(job.narrative!.tailoring!.summaryReplaced, true);
    assert.equal(job.narrative!.warnings, undefined);
    const at = (text: string) => resume.text.indexOf(text);
    assert.ok(at("Experienced backend engineer") > 0);
    assert.ok(at("Summary") < at("Platform Engineer"));
    assert.ok(at("Platform Engineer") < at("Technical Skills"));
  },
);

test(
  "the entry the brief offers is dropped only when the page overflows without it",
  engine,
  async (t) => {
    const source = join(sources, "Alex_Rivera_Software_Engineer_Resume.tex");
    // The hackathon entry pushes the resume onto a second page.
    await writeFile(source, resume.replace("Organized weekly team meetings.", "Organized weekly team meetings.\\vspace{19cm}"));
    t.after(() => writeFile(source, resume));
    const { run } = await lane(t, {
      variant: "Alex_Rivera_Software_Engineer_Resume",
      lead_sections: ["Summary", "Experience", "Technical Skills"],
      drop_entries: ["Hackathon App"],
    });
    const { job, resume: built } = await run();
    assert.doesNotMatch(built.text, /Hackathon App/);
    assert.ok(job.narrative!.tailoring!.changes.includes("dropped Hackathon App"));
  },
);

test(
  "a posting too short to tailor against gets the stock resume, without a brief",
  engine,
  async (t) => {
    const { run, briefs } = await lane(t, { summary_line: "unused" });
    const { job, resume } = await run(request("Backend services."));
    assert.equal(briefs(), 0);
    assert.match(resume.text, /Software engineer who built a Redis Streams/);
    assert.deepEqual(job.narrative!.tailoring!.changes, []);
    assert.equal(job.narrative!.warnings, undefined);
  },
);

test("a tailoring folder with no resumes falls back to the laid-out documents", async (t) => {
  const { run } = await lane(t, {}, "../not-a-tailoring-folder");
  const { job, resume } = await run();
  assert.equal(job.artifacts.length, 4);
  assert.equal(job.narrative!.tailoring, undefined);
  assert.match(resume.text, /Alex Fixture/);
  assert.match(resume.text, /[∼~]\s*3x the load I planned for/);
  assert.match(
    job.narrative!.warnings!.join(" "),
    /could not be built.*has no resumes folder\. Put your \.tex resumes there, or run npm run tailoring:import/,
  );
});

test("the bridge shows this application's graduation on the degree in progress only", async () => {
  const run = (tex: string, month: string) =>
    promisify(execFile)(python, [
      "-c",
      `import importlib.util, json, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("bridge", "tailor/bridge.py")
bridge = importlib.util.module_from_spec(spec); spec.loader.exec_module(bridge)
tex, note = bridge.set_graduation(sys.argv[1], sys.argv[2])
print(json.dumps({"tex": tex, "note": note}))`,
      tex,
      month,
    ]).then(({ stdout }) => JSON.parse(stdout) as { tex: string; note: string | null });
  const source = String.raw`\section*{Summary}
Ships systems through Dec 2027 plans.
\section*{Education}
\textbf{State University} \hfill \textit{Aug 2025 -- Dec 2027}\\
\textbf{Poly} \hfill \textit{Sep 2020 -- Jun 2024}
\section*{Experience}
\textbf{Engineer} \hfill \textit{2024 -- Dec 2027}`;
  const may = await run(source, "2027-05");
  assert.equal(may.note, "graduation shown as May 2027 for this role");
  // Only the in-progress degree's end moves; the summary, the completed
  // degree and other sections keep the source's dates.
  assert.deepEqual(
    may.tex.split("\n").filter((line, i) => line !== source.split("\n")[i]),
    [String.raw`\textbf{State University} \hfill \textit{Aug 2025 -- May 2027}\\`],
  );
  assert.deepEqual(await run(source, "2027-12"), { tex: source, note: null });
  // A latest end already past is a completed degree: never rewritten.
  const finished = source.replace("Aug 2025 -- Dec 2027", "Aug 2021 -- Dec 2023");
  assert.deepEqual(await run(finished, "2027-05"), { tex: finished, note: null });
  const none = String.raw`\section*{Summary}
No education section.`;
  assert.deepEqual(await run(none, "2027-05"), { tex: none, note: null });
});

test("the bridge writes the brief's special characters the way LaTeX needs them", async () => {
  const { stdout } = await promisify(execFile)(python, [
    "-c",
    `import importlib.util, json, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("bridge", "tailor/bridge.py")
bridge = importlib.util.module_from_spec(spec); spec.loader.exec_module(bridge)
print(json.dumps(bridge._latex_safe(json.loads(sys.argv[1]))))`,
    JSON.stringify({
      summary_line: "Builds C# and R&D tools, 100% tested",
      skills_order: [{ name: "Languages", items: ["C#", String.raw`F\#`, "snake_case"] }],
      keep: "C#",
    }),
  ]);
  assert.deepEqual(JSON.parse(stdout), {
    summary_line: String.raw`Builds C\# and R\&D tools, 100\% tested`,
    // Already escaped stays as it is; fields the brief doesn't insert are untouched.
    skills_order: [{ name: "Languages", items: [String.raw`C\#`, String.raw`F\#`, String.raw`snake\_case`] }],
    keep: "C#",
  });
});

test(
  "a requirement the applicant misses leads the card; one the brief calls met is a caution",
  engine,
  async (t) => {
    const { run } = await lane(t, {
      variant: "Alex_Rivera_Software_Engineer_Resume",
      eligibility: [
        "Requires graduation between Spring 2028 and Winter 2029; you finish in December 2027.",
        "Requires a graduation in Spring 2027; yours is May 2027, so this is likely met, but confirm.",
        "Requires a Bachelor's graduating Spring 2027; your M.S. finishes May 2027, which falls inside the window.",
      ],
    });
    const { job } = await run();
    assert.equal(job.narrative!.warnings![0], "Eligibility: Requires graduation between Spring 2028 and Winter 2029; you finish in December 2027.");
    assert.ok(!job.narrative!.warnings!.some((w) => /likely met|inside the window/.test(w)));
    assert.ok(job.narrative!.tailoring!.cautions.some((c) => /likely met/.test(c)));
  },
);
