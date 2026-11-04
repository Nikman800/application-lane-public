declare const __CONFIG_ENGINE__: boolean;

export const configEngineEnabled =
  typeof __CONFIG_ENGINE__ !== "undefined" && __CONFIG_ENGINE__;
