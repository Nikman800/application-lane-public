import React, { useEffect, useState } from "react";

async function command<T = any>(message: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok)
    throw new Error(
      response?.error || "Extension background worker is unavailable.",
    );
  return response.data;
}

type Kind = "claude-cli" | "codex-cli" | "http";
type CliStatus = { command: string; found: boolean; version?: string };
type Step = {
  id: string;
  name?: string;
  provider: Kind;
  model: string;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  timeoutMs?: number;
  home?: string;
  command?: string;
  cli?: CliStatus;
};
// What the backend sends for its Settings page (src/server/settings.ts).
type ConfigView = {
  providers: Step[];
  checkProviders?: Step[];
  installed: Record<"claude-cli" | "codex-cli", CliStatus>;
  defaultModels: Record<"claude-cli" | "codex-cli", string>;
  endpoint: string;
  model: string;
  verifyModel: string;
  hasApiKey: boolean;
  documentsDir: string;
  transcriptsDir: string;
  transcript?: { name: string; modifiedAt: number } | null;
  tailoring?: { python: CliStatus; pdflatex: CliStatus; configured: boolean; folder: string };
};

const kindNames: Record<Kind, string> = {
  "claude-cli": "Claude Code",
  "codex-cli": "Codex",
  http: "API endpoint",
};
const installedText = (status: CliStatus) =>
  status.found
    ? `Installed${status.version ? ` (${status.version})` : ""}`
    : `Not found at “${status.command}”. Install it, or give its full path.`;

const toolText = (status: CliStatus) =>
  status.found ? `Found${status.version ? ` (${status.version})` : ""}` : `Not found (“${status.command}”)`;

// Who drafts documents and answers, in what order, and where files are kept.
// Everything here is saved in the local backend's config.json.
export function DraftingSettings({ connected }: { connected: boolean }) {
  const [view, setView] = useState<ConfigView>();
  const [steps, setSteps] = useState<Step[]>([]);
  const [checks, setChecks] = useState<Step[]>([]);
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [verifyModel, setVerifyModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [documentsDir, setDocumentsDir] = useState("");
  const [transcriptsDir, setTranscriptsDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [uploading, setUploading] = useState(false);
  const [transcriptNote, setTranscriptNote] = useState("");

  const show = (next: ConfigView) => {
    setView(next);
    setSteps(next.providers);
    setChecks(next.checkProviders || []);
    setEndpoint(next.endpoint);
    setModel(next.model);
    setVerifyModel(next.verifyModel || "");
    setApiKey("");
    setDocumentsDir(next.documentsDir);
    setTranscriptsDir(next.transcriptsDir);
  };
  useEffect(() => {
    if (!connected) return;
    // An older backend without the route shows nothing to edit.
    void command<ConfigView>({ type: "API", path: "/v1/config" }).then(show, (e) => setError(e.message));
  }, [connected]);

  if (!connected || !view)
    return error ? (
      <section className="card">
        <h2>Drafting</h2>
        <p className="help">Couldn’t read the backend’s settings: {error}</p>
      </section>
    ) : null;

  const toSave = ({ cli: _cli, ...step }: Step) => ({
    ...step,
    model: step.model.trim() || view.defaultModels[step.provider as "claude-cli" | "codex-cli"],
    effort: step.provider === "codex-cli" ? step.effort || "low" : undefined,
    command: step.provider !== "http" && step.command?.trim() ? step.command.trim() : undefined,
    home: step.provider !== "http" && step.home?.trim() ? step.home.trim() : undefined,
  });
  const lists = { view, model, changed: () => setSaved("") };
  async function save() {
    if ([...steps, ...checks].some((step) => step.provider === "http" && !step.model.trim()))
      return setError("Give the API endpoint provider a model name.");
    setBusy(true);
    setError("");
    setSaved("");
    try {
      show(
        await command<ConfigView>({
          type: "API",
          path: "/v1/config",
          method: "PUT",
          body: {
            providers: steps.map(toSave),
            checkProviders: checks.map(toSave),
            endpoint: endpoint.trim(),
            model,
            verifyModel: verifyModel.trim(),
            ...(apiKey ? { apiKey } : {}),
            ...(documentsDir.trim() ? { documentsDir: documentsDir.trim() } : {}),
            transcriptsDir: transcriptsDir.trim(),
          },
        }),
      );
      setSaved("Settings saved. The next draft uses them.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // The chosen file goes to the backend's transcripts folder as it is, and
  // being the newest there, is the one forms are given.
  async function uploadTranscript(file: File | undefined) {
    if (!file) return;
    setTranscriptNote("");
    setError("");
    if (!/\.(pdf|docx)$/i.test(file.name)) return setError("A transcript must be a PDF or a Word (.docx) file.");
    if (file.size > 8 * 1024 * 1024) return setError("The transcript is larger than 8 MB.");
    setUploading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      const next = await command<ConfigView>({ type: "API", path: "/v1/transcript", method: "PUT", body: { name: file.name, data: btoa(binary) } });
      // Only the transcript changed: unsaved edits elsewhere on the page stay.
      setView((old) => (old ? { ...old, transcript: next.transcript } : next));
      setTranscriptNote("Transcript saved. Forms that ask for one are given this file.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <section className="card" aria-label="Drafting">
        <h2>Drafting</h2>
        <p className="help">
          Documents and answers are drafted by the first of these that works, in
          this order. Claude Code and Codex run on this computer under the
          account you are logged into there. An API endpoint uses the address
          and key below.
        </p>
        <div className="connection-details">
          <span>Claude Code</span>
          <strong>{installedText(view.installed["claude-cli"])}</strong>
          <span>Codex</span>
          <strong>{installedText(view.installed["codex-cli"])}</strong>
        </div>
        <ProviderList {...lists} steps={steps} setSteps={setSteps} empty="Nothing drafts yet. Add a provider." />
        {view.tailoring && (
          <div className="resume-layout" aria-label="Résumé layout">
            <h3>Résumé layout</h3>
            <div className="connection-details">
              <span>Layout</span>
              <strong>
                {view.tailoring.configured ? `LaTeX tailoring from ${view.tailoring.folder}` : "Built-in layout (no setup needed)"}
              </strong>
              {view.tailoring.configured && (
                <>
                  <span>Python</span>
                  <strong>{toolText(view.tailoring.python)}</strong>
                  <span>pdflatex</span>
                  <strong>{toolText(view.tailoring.pdflatex)}</strong>
                </>
              )}
            </div>
            <p className="help">Advanced: see docs/advanced.md to use your own LaTeX résumé.</p>
          </div>
        )}
      </section>
      <section className="card" aria-label="Checking">
        <h2>Checking</h2>
        <p className="help">
          Before a draft is used, another model checks each claim in it against
          your profile, all of one application's drafts in one request. The
          first of these that works checks, passing over the model that wrote
          the draft. A smaller model checks as well as a large one. Empty: the
          Drafting order checks, then the checking model below.
        </p>
        <ProviderList {...lists} steps={checks} setSteps={setChecks} empty="The Drafting order checks." label="Checker" />
      </section>
      <section className="card" aria-label="API endpoint">
        <h2>API endpoint</h2>
        <p className="help">
          Any OpenAI-compatible service, such as a university or company model
          gateway. Its model also checks drafted claims and answers short form
          questions, so set it even when Claude Code or Codex drafts. The key
          is stored by the backend and never shown again.
        </p>
        <label>
          Endpoint address
          <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://api.openai.com/v1" spellCheck={false} />
        </label>
        <div className="form-grid">
          <label>
            Model
            <input
              value={model}
              onChange={(e) => {
                // A provider row still on the endpoint's model follows it.
                setSteps((old) => old.map((step) => (step.provider === "http" && step.model === model ? { ...step, model: e.target.value } : step)));
                setModel(e.target.value);
              }}
              spellCheck={false}
            />
          </label>
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={view.hasApiKey ? "A key is saved. Type to replace it" : "No key saved"}
            />
          </label>
        </div>
        <label>
          Checking model (optional)
          <input
            value={verifyModel}
            onChange={(e) => setVerifyModel(e.target.value)}
            placeholder={model ? `Uses ${model}` : "Uses the model above"}
            spellCheck={false}
          />
        </label>
        <p className="help">
          Another model at this endpoint, to check drafted answers and letters
          against your profile in place of the one above. A stronger model
          questions fewer sound answers. It is never a model that also drafts.
        </p>
      </section>
      <section className="card" aria-label="Folders">
        <h2>Folders</h2>
        <p className="help">Full paths on the computer the backend runs on.</p>
        <label>
          Drafted documents are saved to
          <input value={documentsDir} onChange={(e) => setDocumentsDir(e.target.value)} spellCheck={false} />
        </label>
        <label>
          Transcripts are read from (optional)
          <input
            value={transcriptsDir}
            onChange={(e) => setTranscriptsDir(e.target.value)}
            placeholder="The transcripts folder beside the backend’s data"
            spellCheck={false}
          />
        </label>
      </section>
      <section className="card" aria-label="Transcript">
        <h2>Transcript</h2>
        <p className="help">
          Your most recent transcript, as a PDF or Word file. It is kept on this computer and uploaded, unchanged, to a form
          that asks for one. Upload a newer one whenever you have it: the newest is the one used.
        </p>
        <p role="status">
          {view.transcript
            ? `Current transcript: ${view.transcript.name} (added ${new Date(view.transcript.modifiedAt).toLocaleDateString()})`
            : "No transcript yet."}
        </p>
        <label>
          {view.transcript ? "Replace with a newer transcript" : "Upload your transcript"}
          <input
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              void uploadTranscript(file);
            }}
          />
        </label>
        {uploading && <p className="help">Uploading…</p>}
        {transcriptNote && <p className="notice">{transcriptNote}</p>}
      </section>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {saved && (
        <div className="notice success" role="status">
          {saved}
        </div>
      )}
      <button className="primary save-drafting" disabled={busy || !endpoint.trim()} onClick={() => void save()}>
        Save drafting settings
      </button>
    </>
  );
}

// One ordered list of providers: who drafts, or who checks.
function ProviderList({
  view,
  model,
  steps,
  setSteps,
  changed,
  empty,
  label = "Provider",
}: {
  view: ConfigView;
  model: string;
  steps: Step[];
  setSteps: React.Dispatch<React.SetStateAction<Step[]>>;
  changed: () => void;
  empty: string;
  label?: string;
}) {
  const edit = (index: number, change: Partial<Step>) => {
    changed();
    setSteps((old) => old.map((step, i) => (i === index ? { ...step, ...change, cli: change.command === undefined ? step.cli : undefined } : step)));
  };
  const move = (index: number, by: number) => {
    changed();
    setSteps((old) => {
      const next = [...old];
      const [step] = next.splice(index, 1);
      next.splice(index + by, 0, step);
      return next;
    });
  };
  const add = (provider: Kind) => {
    changed();
    setSteps((old) => {
      let id = provider.replace("-cli", "");
      for (let n = 2; old.some((step) => step.id === id); n++) id = `${provider.replace("-cli", "")}-${n}`;
      return [
        ...old,
        provider === "http"
          ? { id, provider, model }
          : { id, provider, model: view.defaultModels[provider], ...(provider === "codex-cli" ? { effort: "low" as const } : {}) },
      ];
    });
  };
  return (
    <>
    {!steps.length && <p className="help">{empty}</p>}
    {steps.map((step, index) => (
      <fieldset className="provider" key={step.id} aria-label={`${label} ${index + 1}: ${kindNames[step.provider]}`}>
        <div className="section-title">
          <strong>
            {index + 1}. {kindNames[step.provider]}
          </strong>
          <span className="row">
            <button className="text-button" disabled={index === 0} onClick={() => move(index, -1)}>
              Move up
            </button>
            <button className="text-button" disabled={index === steps.length - 1} onClick={() => move(index, 1)}>
              Move down
            </button>
            <button
              className="text-button danger-text"
              onClick={() => {
                changed();
                setSteps((old) => old.filter((_, i) => i !== index));
              }}
            >
              Remove
            </button>
          </span>
        </div>
        <div className="form-grid">
          <label>
            Model
            <input
              value={step.model}
              onChange={(e) => edit(index, { model: e.target.value })}
              placeholder={step.provider === "http" ? "Model name at the endpoint" : view.defaultModels[step.provider]}
            />
          </label>
          {step.provider === "codex-cli" && (
            <label>
              Reasoning effort
              <select value={step.effort || "low"} onChange={(e) => edit(index, { effort: e.target.value as Step["effort"] })}>
                {["minimal", "low", "medium", "high"].map((effort) => (
                  <option key={effort}>{effort}</option>
                ))}
              </select>
            </label>
          )}
          {step.provider !== "http" && (
            <>
              <label>
                Program path (optional)
                <input
                  value={step.command || ""}
                  onChange={(e) => edit(index, { command: e.target.value })}
                  placeholder={`Found automatically: ${view.installed[step.provider].command}`}
                  spellCheck={false}
                />
              </label>
              <label>
                {step.provider === "codex-cli" ? "Codex home folder (optional)" : "Home folder (optional)"}
                <input
                  value={step.home || ""}
                  onChange={(e) => edit(index, { home: e.target.value })}
                  placeholder="For a second account’s login"
                  spellCheck={false}
                />
              </label>
            </>
          )}
        </div>
        {step.cli && !step.cli.found && (
          <p className="fill-blocker" role="status">
            {installedText(step.cli)}
          </p>
        )}
      </fieldset>
    ))}
    <div className="row">
      <span className="row">
        {(["claude-cli", "codex-cli", "http"] as const).map((kind) => (
          <button key={kind} className="secondary" disabled={steps.length >= 8} onClick={() => add(kind)}>
            Add {kindNames[kind]}
          </button>
        ))}
      </span>
    </div>
    </>
  );
}
