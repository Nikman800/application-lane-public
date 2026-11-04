// The extension's manifest for each build target (scripts/build.mjs):
//   "extension"  the full build, loaded unpacked
//   "baseline"   the engine without site rules, for the eval's comparisons
//   "store"      the Chrome Web Store build: no fixed key (the store assigns
//                the ID), no debugger permission (real keystrokes and the
//                network capture are then unavailable; see trusted-input.ts)

// An unpacked extension's ID is otherwise a hash of its folder path, so the
// same build loaded from a second profile or a second clone arrives as a
// different extension and the backend refuses to talk to it. This public key
// fixes the ID at gelmdeclnhdehpmnfimaaiohjpcgajam everywhere. Only the
// public half is here; nothing signs anything with it.
export const EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6FnQAgoKbif0nAr2qIy6rLtzTjt0519sKfhloQzy3fk33e1HQWu7KeUG+W6WTtic9OSNJN6T/vH7R4/9J/RbvWbrCsMBtdr0kLJ7ND7X+oNwdnxoymeeVlEORi1c3OZxmsbPcoWyvnyJ4fbr09+zaPWvJwQxQZ/+pWY12/Z7zy3uBQWdDJTxjV7pJ8bGGUE2wJGfpRcNh6hAbdB90XTxqzVBU+jObgd5/g9r+1XY2kAwphENBYyPXoEAZd6nffsv9+hif+swP8sWvmWhaIpXXAsducla6WQSrjkgwkRzUYcfnxKRAvegc20wNm4IJTl3WZpVNzULenhGUAyvryokrwIDAQAB";

/**
 * @param {{ target: "extension" | "baseline" | "store", version: string, icons: Record<string, string> }} options
 */
export function extensionManifest({ target, version, icons }) {
  return {
    manifest_version: 3,
    ...(target === "extension" ? { key: EXTENSION_KEY } : {}),
    name: "Application Lane",
    version,
    description: "Prepare job applications in parallel. Your edits always take priority.",
    minimum_chrome_version: "120",
    permissions: [
      "storage",
      "tabs",
      "scripting",
      "sidePanel",
      "alarms",
      "webNavigation",
      // Real keystrokes for widgets that keep their own state and ignore
      // synthetic events (Workday's date sections). Chrome does not allow
      // "debugger" as an optional permission, so it is declared here. A
      // lane attaches it while typing into such a field, and the network
      // capture for issue reports (network-capture.ts, when turned on in
      // Settings) attaches it to tracked application tabs. The store build
      // leaves it out: such fields are then left for the applicant.
      ...(target === "extension" ? ["debugger"] : []),
    ],
    host_permissions: ["http://127.0.0.1/*"],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    background: { service_worker: "background.js" },
    side_panel: { default_path: "panel.html" },
    icons,
    action: { default_title: "Open Application Lane", default_icon: icons },
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'none'; connect-src http://127.0.0.1:4318 ws://127.0.0.1:4318",
    },
  };
}
