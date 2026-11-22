import { useSyncExternalStore } from "react";

export type Settings = {
  /** ElevenLabs agent ID. Empty plays the scripted call. */
  agentId: string;
  apiUrl: string;
  appearance: "system" | "light" | "dark";
  /** Read the spoken lines of the run log aloud. */
  narration: boolean;
};

const KEY = "max.settings";

const defaults: Settings = {
  agentId: import.meta.env.VITE_ELEVENLABS_AGENT_ID ?? "",
  apiUrl: import.meta.env.VITE_API_URL ?? "http://localhost:3001",
  appearance: "system",
  narration: true,
};

// Only what the user changed is saved, so .env values still apply to the rest.
function readSaved(): Partial<Settings> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

let saved = readSaved();
let current: Settings = { ...defaults, ...saved };
const listeners = new Set<() => void>();

function applyAppearance() {
  // Every colour token is a light-dark() pair, so this one property themes the app.
  document.documentElement.style.colorScheme =
    current.appearance === "system" ? "light dark" : current.appearance;
}
applyAppearance();

export const getSettings = (): Settings => current;

export function updateSettings(patch: Partial<Settings>) {
  saved = { ...saved, ...patch };
  current = { ...defaults, ...saved };
  localStorage.setItem(KEY, JSON.stringify(saved));
  applyAppearance();
  listeners.forEach((listener) => listener());
}

export function useSettings(): Settings {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, getSettings);
}

/** "localhost:5174" -> "http://localhost:5174", without a trailing slash. */
export function asUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return !trimmed || /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}
