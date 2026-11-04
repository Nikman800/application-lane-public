import { randomInt, timingSafeEqual } from "node:crypto";

// One-click pairing: the backend shows a six-digit code in its terminal and
// the applicant types it on the extension's dashboard, which then receives
// the backend's token. Typing the code is what proves the request came from
// the extension the person at this computer is using, not from another
// extension installed alongside it.
//
// A code is open while the backend is unpaired (it does not expire then),
// or for a few minutes after `npm start -- --pair` or `lane pair` asked for
// one to move to another browser. Too many wrong codes retire the code and
// lock pairing for a minute; a fresh code is shown in the terminal.

export const PAIRING_WINDOW_MS = 10 * 60_000;
export const PAIRING_ATTEMPTS = 5;
export const PAIRING_LOCKOUT_MS = 60_000;

export type PairingAnnouncement = { code: string; expiresAt?: number; reason: "unpaired" | "requested" | "rotated" };
export type PairingAttempt =
  | { ok: true }
  | { ok: false; status: 403 | 409 | 429; error: string };

export class Pairing {
  private code?: string;
  private expiresAt?: number;
  private failures = 0;
  private lockedUntil = 0;
  constructor(
    private readonly announce: (announcement: PairingAnnouncement) => void,
    private readonly now: () => number = Date.now,
  ) {}

  // A new code: without expiry while unpaired, or for the pairing window.
  open(reason: PairingAnnouncement["reason"], expires = reason !== "unpaired"): PairingAnnouncement {
    this.code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.expiresAt = expires ? this.now() + PAIRING_WINDOW_MS : undefined;
    this.failures = 0;
    const announcement = { code: this.code, ...(this.expiresAt ? { expiresAt: this.expiresAt } : {}), reason };
    this.announce(announcement);
    return announcement;
  }

  close() {
    this.code = undefined;
    this.expiresAt = undefined;
    this.failures = 0;
  }

  get state(): "open" | "closed" | "locked" {
    if (this.now() < this.lockedUntil) return "locked";
    return this.live() ? "open" : "closed";
  }

  private live() {
    if (this.code && this.expiresAt && this.now() > this.expiresAt) this.close();
    return Boolean(this.code);
  }

  attempt(code: string, paired: boolean): PairingAttempt {
    if (this.now() < this.lockedUntil)
      return { ok: false, status: 429, error: "Too many wrong codes. Wait a minute, then type the new code shown where Application Lane is running." };
    if (!this.live())
      return paired
        ? {
            ok: false,
            status: 409,
            error: "This backend is already paired with another browser or extension. To pair this one, restart it with npm start -- --pair (or run lane pair), then type the new code.",
          }
        : { ok: false, status: 409, error: "Pairing is not open. Restart Application Lane to show a new code." };
    const typed = Buffer.from(code.replace(/\s+/g, ""));
    const expected = Buffer.from(this.code!);
    if (typed.length === expected.length && timingSafeEqual(typed, expected)) {
      this.close();
      return { ok: true };
    }
    if (++this.failures >= PAIRING_ATTEMPTS) {
      this.lockedUntil = this.now() + PAIRING_LOCKOUT_MS;
      // The guessed-at code is retired; the person at the terminal gets a new one.
      this.open("rotated", this.expiresAt !== undefined);
      return { ok: false, status: 429, error: "Too many wrong codes. Wait a minute, then type the new code shown where Application Lane is running." };
    }
    return { ok: false, status: 403, error: "That code does not match. Check the six digits shown where Application Lane is running." };
  }
}

// The code as the terminal shows it.
export function pairingBanner({ code, expiresAt, reason }: PairingAnnouncement): string {
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  const lead =
    reason === "rotated"
      ? "Too many wrong pairing codes. The old code no longer works."
      : reason === "requested"
        ? "Pairing is open for another browser or extension."
        : "Open the Application Lane extension and type this code to connect it.";
  const until = expiresAt ? ` (valid for ${Math.round((expiresAt - Date.now()) / 60_000)} minutes)` : "";
  return `\n  ${lead}\n  Pairing code: ${spaced}${until}\n`;
}
