// A value this browser keeps in chrome.storage.local (the theme, the daily
// goal), read on mount and followed as it changes on another page.
import { useEffect, useState } from "react";

export function useStoredValue<T>(key: string, fallback: T, accept: (value: unknown) => value is T) {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    let live = true;
    void chrome.storage.local.get(key).then(
      (stored) => live && accept(stored[key]) && setValue(stored[key] as T),
      () => {},
    );
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local" || !(key in changes)) return;
      const next = changes[key].newValue;
      setValue(accept(next) ? next : fallback);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [key]);
  const save = (next: T) => {
    setValue(next);
    void chrome.storage?.local?.set({ [key]: next });
  };
  return [value, save] as const;
}

export const isGoal = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 50;
