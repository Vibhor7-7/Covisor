import type { AgentStatus } from "./types";

/** 41000 -> "0:41" */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** ISO timestamp -> "just now", "4m ago", "2h ago" */
export function ago(iso: string, now: number): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** "2026-11-19" -> "Thu, Nov 19". Anything unparseable is shown as given. */
export function day(value: string): string {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** "opus" -> "Opus". Unknown model strings are shown as given. */
export function modelName(model: string): string {
  return /^[a-z]+$/.test(model) ? model[0].toUpperCase() + model.slice(1) : model;
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  queued: "Queued",
  working: "Working",
  needs_review: "Needs review",
  stuck: "Stuck",
  done: "Done",
  error: "Error",
};

export const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
