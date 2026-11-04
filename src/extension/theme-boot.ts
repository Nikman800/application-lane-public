// Loaded in <head> of the side panel and the dashboard, before anything is
// drawn: puts the chosen theme on <html> at once (from this extension's
// localStorage, which both pages share and which reads synchronously), then
// checks it against chrome.storage.local, where Settings → Appearance keeps
// it, and follows a change made on the other page.
import { isThemeChoice, type ThemeChoice } from "../shared/theme";

const root = document.documentElement;
const apply = (choice: unknown) => {
  const theme: ThemeChoice = isThemeChoice(choice) ? choice : "system";
  root.dataset.theme = theme;
  try {
    localStorage.setItem("theme", theme);
  } catch {
    // Storage may be unavailable; the theme still applies for this page.
  }
};
try {
  apply(localStorage.getItem("theme"));
} catch {
  apply("system");
}
// Colour changes animate once the page has drawn, not on load.
requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("theme-ready")));
if (typeof chrome !== "undefined" && chrome.storage?.local) {
  void chrome.storage.local.get("theme").then((stored) => apply(stored.theme), () => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.theme) apply(changes.theme.newValue);
  });
}
