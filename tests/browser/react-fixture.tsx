import React, { useState } from "react";
import { createRoot } from "react-dom/client";
function Form() {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [firstName, setFirstName] = useState("");
  const [resume, setResume] = useState("");
  return (
    <main>
      <h1>Reactive Frontend Engineer</h1>
      <p>Build accessible TypeScript apps.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          (window as any).submissions++;
        }}
      >
        <label>
          Email
          <input
            name="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Phone
          <input
            name="phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
        {email && (
          <label>
            First name
            <input
              name="firstName"
              required
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
          </label>
        )}
        <label>
          Resume
          <input
            type="file"
            name="resume"
            required
            accept=".pdf"
            onChange={(e) => {
              setResume(e.target.files?.[0]?.name || "");
              setTimeout(() => setPhone("SITE-PARSER-CHANGED"), 80);
            }}
          />
        </label>
        <output>{resume}</output>
        <button type="submit">Submit application</button>
      </form>
      <output id="react-state">
        {JSON.stringify({ email, phone, firstName })}
      </output>
    </main>
  );
}
(window as any).submissions = 0;
createRoot(document.getElementById("root")!).render(<Form />);
