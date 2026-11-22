import type { Spec } from "./types";

export const TEXT_FIELDS = ["title", "goal", "user", "repoPath"] as const;
export const LIST_FIELDS = [
  "scopeIn",
  "scopeOut",
  "decisions",
  "constraints",
  "acceptance",
  "openQuestions",
] as const;

export type TextField = (typeof TEXT_FIELDS)[number];
export type ListField = (typeof LIST_FIELDS)[number];

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Merges an `update_spec` patch. Max sends only what is new, so text fields
 * replace and list fields append, skipping items already present.
 */
export function mergeSpec(spec: Partial<Spec>, patch: Record<string, unknown>): Partial<Spec> {
  const next = { ...spec };
  for (const key of TEXT_FIELDS) {
    const [text] = strings(patch[key]);
    if (text) next[key] = text;
  }
  for (const key of LIST_FIELDS) {
    const have = next[key] ?? [];
    const seen = new Set(have.map((item) => item.toLowerCase()));
    const fresh = strings(patch[key]).filter((item) => !seen.has(item.toLowerCase()));
    if (fresh.length) next[key] = [...have, ...fresh];
  }
  return next;
}

/**
 * Builds the full Spec for `start_build`. Max's final version wins over the
 * draft, except in fields the founder edited by hand: those stay as edited.
 */
export function finalSpec(
  draft: Partial<Spec>,
  final: Record<string, unknown>,
  edited: readonly string[],
): Spec {
  const text = (key: TextField) =>
    (edited.includes(key) ? undefined : strings(final[key])[0]) ?? draft[key] ?? "";
  const list = (key: ListField) =>
    key in final && !edited.includes(key) ? strings(final[key]) : (draft[key] ?? []);
  return {
    title: text("title"),
    goal: text("goal"),
    user: text("user"),
    scopeIn: list("scopeIn"),
    scopeOut: list("scopeOut"),
    decisions: list("decisions"),
    constraints: list("constraints"),
    acceptance: list("acceptance"),
    openQuestions: list("openQuestions"),
    repoPath: text("repoPath"),
  };
}
