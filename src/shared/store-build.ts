// The Chrome Web Store build (npm run build -- --store): no debugger
// permission, so real keystrokes and the network capture for issue reports
// are unavailable and their settings are not offered. scripts/build.mjs
// sets __STORE_BUILD__.
declare const __STORE_BUILD__: boolean;
export const storeBuild = typeof __STORE_BUILD__ !== "undefined" && __STORE_BUILD__;
