// First run: connecting to the backend on this computer with the six-digit
// code it shows (pairing.ts on the backend), and a short checklist of what
// to do next. Both disappear once they are done.
import { useEffect, useState } from "react";
import { useStoredValue } from "./prefs";

type Hello = { running: boolean; paired?: boolean; pairedHere?: boolean; pairing?: string; hasToken?: boolean };

const send = async <T,>(message: unknown): Promise<T> => {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "Extension background worker is unavailable.");
  return response.data;
};

// How to start the backend, said the same way everywhere.
export function StartBackendHelp() {
  return (
    <ol className="help onboarding-steps">
      <li>
        Open a terminal in the Application Lane folder and run <code>npm start</code> (or <code>application-lane</code> if
        you installed the backend package).
      </li>
      <li>Keep that window open while you apply. It shows a six-digit pairing code the first time.</li>
    </ol>
  );
}

export function ConnectCard({ onConnected, onUseToken }: { onConnected: () => Promise<void> | void; onUseToken?: () => void }) {
  const [hello, setHello] = useState<Hello>();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const probe = () =>
      send<Hello>({ type: "HELLO" }).then(
        (value) => live && setHello(value),
        () => live && setHello({ running: false }),
      );
    void probe();
    // Notices the backend starting, or a new code opening, without a reload.
    const timer = window.setInterval(probe, 3000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);
  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      await send({ type: "PAIR_CODE", code });
      setCode("");
      await onConnected();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const open = hello?.pairing === "open";
  return (
    <section className="setup-card connect-card" aria-label="Connect to Application Lane">
      <strong>Connect to Application Lane on this computer</strong>
      {!hello ? (
        <p>Looking for the backend…</p>
      ) : !hello.running ? (
        <>
          <p>The backend isn’t running yet. It keeps your profile and writes your documents, and never leaves this computer.</p>
          <StartBackendHelp />
        </>
      ) : hello.pairing === "locked" ? (
        <p>Too many wrong codes. Wait a minute, then type the new code shown in the backend’s window.</p>
      ) : open ? (
        <>
          <p>Type the six-digit pairing code shown in the window where Application Lane is running.</p>
          <form
            className="row pair-code"
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            <input
              aria-label="Pairing code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              placeholder="123 456"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/[^\d ]/g, ""))}
            />
            <button className="primary" type="submit" disabled={busy || code.replace(/\s/g, "").length !== 6}>
              Connect
            </button>
          </form>
        </>
      ) : hello.paired && !hello.pairedHere ? (
        <p>
          The backend is paired with another browser or extension. To pair this one, restart it with{" "}
          <code>npm start -- --pair</code> (or run <code>lane pair</code>) and type the new code here.
        </p>
      ) : hello.hasToken ? (
        <p>The backend is running, but this extension’s saved token was not accepted. Restart the backend with <code>npm start -- --pair</code> and type the new code here.</p>
      ) : (
        <p>
          The backend is running but not showing a code. Restart it with <code>npm start -- --pair</code> to show one.
        </p>
      )}
      {error && <p className="onboarding-error" role="alert">{error}</p>}
      {onUseToken && (
        <button className="text-button" onClick={onUseToken}>
          Use a pairing token instead
        </button>
      )}
    </section>
  );
}

type Step = { label: string; done: boolean; detail: string; action?: { label: string; run: () => void } };

export function OnboardingChecklist({ steps }: { steps: Step[] }) {
  const [dismissed, setDismissed] = useStoredValue<boolean>("onboardingDismissed", false, (value): value is boolean => typeof value === "boolean");
  const left = steps.filter((step) => !step.done).length;
  if (dismissed || !left) return null;
  const next = steps.find((step) => !step.done);
  return (
    <section className="card onboarding" aria-label="Getting started">
      <div className="section-title">
        <h2>Getting started</h2>
        <span className="status paused">
          {steps.length - left} of {steps.length} done
        </span>
      </div>
      <ol className="checklist">
        {steps.map((step) => (
          <li key={step.label} className={step.done ? "done" : step === next ? "next" : ""}>
            <span className="check" aria-hidden="true">{step.done ? "✓" : ""}</span>
            <div>
              <strong>{step.label}</strong>
              {!step.done && <p className="help">{step.detail}</p>}
              {!step.done && step === next && step.action && (
                <button className="secondary" onClick={step.action.run}>
                  {step.action.label}
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
      <button className="text-button" onClick={() => setDismissed(true)}>
        Hide this checklist
      </button>
    </section>
  );
}
