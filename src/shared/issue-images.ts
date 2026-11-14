import type { IssueImage } from "./model";

// The screenshots of a report that hold something: an image pasted from a
// clipboard that gave no bytes came through empty, and the backend refused the
// whole report for it, so two reports were downloaded as files and never
// reached the fixer.
export function usableImages<T extends Pick<IssueImage, "data">>(images: T[]): T[] {
  return images.filter((image) => typeof image.data === "string" && image.data.length > 0 && /^[A-Za-z0-9+/=\s]+$/.test(image.data));
}
