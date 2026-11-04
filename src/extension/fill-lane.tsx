// The band of arrows that streams across an application while it is being
// filled, in the theme's progress colours (panel.css .fill-lane). Decorative:
// the status pill beside it says what is happening.
import React from "react";

export function FillLane() {
  return (
    <div className="fill-lane" aria-hidden="true">
      <span className="fill-lane-arrows" />
    </div>
  );
}
