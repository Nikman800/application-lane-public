// The brand mark: two chevrons down a lane, as in the extension's icon
// (icons/logo.svg). It pulses while any fill is running.
import React from "react";

export function BrandMark({ running }: { running?: boolean }) {
  return (
    <div className={`brand-mark${running ? " running" : ""}`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5.5 6 11 12l-5.5 6" />
        <path d="M12.5 6 18 12l-5.5 6" />
      </svg>
    </div>
  );
}
