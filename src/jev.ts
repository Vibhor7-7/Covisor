// Jev (TypeSafe System One) judgments for the board and standup (PRD B6, repurposed).
//
// Jev does not generate text. It answers typed questions with calibrated probabilities. We use it where
// the status rules in status.ts need to *understand* an agent's words: when a coding agent's turn has
// ended (or it wrote BLOCKED.md), does it need something from a person, how did the turn end, and which
// of its own sentences says so. Code owns the policy (thresholds in applyJudgment) and copies the chosen
// sentence verbatim into the card detail, so Max never speaks a status nobody wrote.
//
// One request per agent turn, four questions answered in parallel:
//   needs_human       noul    does the agent need a key / access / decision from a person?
//   outcome           choice  finished | no_change_needed | blocked_on_person | failed | partial
//   blocker_sentence  choice  which sentence best says what is holding the task up (or none)
//   summary_sentence  choice  which sentence best says what it finished (or none)
// The two sentence questions are speculative fan-out: code reads only the one the outcome needs.
//
// Env (all optional except the key):
//   TYPESAFE_API_KEY     enables Jev; without it status.ts uses its code rules only
//   JEV=0                turn Jev off even with a key
//   JEV_MODEL            default jev-latest (pin e.g. jev-1.14.0 once thresholds are tuned)
//   TYPESAFE_URL         default https://api.typesafe.ai
//   JEV_TIMEOUT_MS       per request, default 8000
import { createHash } from "node:crypto";
import type { AgentStatus } from "./types";

export type Outcome = "finished" | "no_change_needed" | "blocked_on_person" | "failed" | "partial";
const OUTCOMES: Outcome[] = ["finished", "no_change_needed", "blocked_on_person", "failed", "partial"];

export type JevEvidence = {
  taskId: string;
  taskTitle: string;
  acceptance: string[];
  lastMessage: string; // the agent's last reply in Codevisor
  blockedNote: string; // BLOCKED.md contents, if any
  commitsAhead: number;
  diffStat: string | null;
  uncommittedFiles: number;
};

export type JevJudgment = {
  model: string;
  needsHuman: number;
  outcome: Outcome;
  outcomeConfidence: number;
  outcomeProbabilities: Partial<Record<Outcome, number>>;
  blockerSentence: string | null;
  blockerConfidence: number;
  summarySentence: string | null;
  summaryConfidence: number;
  inputTokens: number;
  latencyMs: number;
  at: string;
};

export type Decision = { status: AgentStatus; detail: string };
/** What the code rule based its decision on, which bounds what Jev may change. */
export type Basis = "blocked_file" | "turn_ended";

// Thresholds (docs: start at 0.7 yes / 0.3 no; tune on real runs).
const YES = 0.7;
const NO = 0.3;
const OUTCOME_MIN_CONF = 0.6;
const SENTENCE_MIN_CONF = 0.4;

const env = process.env;

export function jevEnabled(): boolean {
  return !!env.TYPESAFE_API_KEY && env.JEV !== "0" && Date.now() >= authBlockedUntil;
}

export function jevModel(): string {
  return env.JEV_MODEL || "jev-latest";
}

// ---------------------------------------------------------------------------------------------
// Candidates: the agent's own sentences, so the detail line is copied, not generated.
// ---------------------------------------------------------------------------------------------

const MAX_CANDIDATES = 40;

export function candidateSentences(...texts: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    const prose = text.replace(/```[\s\S]*?```/g, " ");
    for (const rawLine of prose.split("\n")) {
      const line = rawLine
        .replace(/^\s*(?:#+|[-*>]|\d+[.)])\s*/, "")
        .replace(/\*\*|__|`/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .trim();
      if (!line) continue;
      for (let s of line.split(/(?<=[.!?])\s+(?=["'(A-Z0-9])/)) {
        s = s.trim();
        if (s.length < 12 || !/[a-z]/i.test(s)) continue;
        if (s.length > 300) s = s.slice(0, 300).replace(/\s+\S*$/, "") + "...";
        const k = s.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(s);
        if (out.length >= MAX_CANDIDATES) return out;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------------

type Question =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

export function buildRequest(ev: JevEvidence, candidates: string[]) {
  const state = {
    task: { title: ev.taskTitle, acceptance_criteria: ev.acceptance },
    agent: {
      last_message: ev.lastMessage || "(no message)",
      blocked_note: ev.blockedNote || "(no BLOCKED.md file)",
    },
    git: {
      commits_on_branch: ev.commitsAhead,
      diff_vs_main: ev.diffStat ?? "none",
      uncommitted_files: ev.uncommittedFiles,
    },
  };

  const questions: Record<string, Question> = {
    needs_human: {
      type: "noul",
      instructions:
        "A coding agent has stopped working on `task`. Read `agent.last_message` and `agent.blocked_note`. " +
        "Does the agent say it cannot finish the task without something only a person can provide?",
      criteria: {
        true:
          "The agent says it is blocked on, or waiting for, something from a person: an API key or other secret, " +
          "a login or access, an approval, or a product decision.",
        false:
          "The agent finished, or stopped for a reason it could deal with itself (a failing test, a bug, a tool " +
          "error), and does not ask a person for anything.",
      },
    },
    outcome: {
      type: "choice",
      instructions:
        "How did the coding agent's latest turn on `task` end? Use `agent.last_message`, `agent.blocked_note` " +
        "and `git` (commits and changed files on the agent's branch).",
      criteria: {
        finished: "It says the task is complete and its changes are ready for someone to review.",
        no_change_needed: "It concluded that the task needed no code changes.",
        blocked_on_person:
          "It stopped because it needs something from a person, such as a key, access, an approval or a decision.",
        failed:
          "It stopped on an error it could not resolve, such as failing tests or a broken tool, without asking " +
          "a person for anything.",
        partial: "It made some progress but stopped before finishing, without saying it is blocked.",
      },
    },
  };

  if (candidates.length) {
    const opts = Object.fromEntries(candidates.map((s, i) => [`s${i + 1}`, s]));
    questions.blocker_sentence = {
      type: "choice",
      instructions:
        "Each option is a sentence the coding agent wrote. Which sentence best tells the founder what is " +
        "holding `task` up, ideally naming exactly what the agent needs from a person? Pick `none` if no " +
        "sentence says what is holding the task up.",
      criteria: { ...opts, none: "No sentence says what is holding the task up." },
    };
    questions.summary_sentence = {
      type: "choice",
      instructions:
        "Each option is a sentence the coding agent wrote. Which sentence best tells the founder what the " +
        "agent finished or concluded on `task`? Pick `none` if no sentence says that.",
      criteria: { ...opts, none: "No sentence says what the agent finished or concluded." },
    };
  }

  return { model: jevModel(), state, questions };
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

let authBlockedUntil = 0;
let lastError: string | null = null;

type NoulAnswer = { type: "noul"; noul: number };
type ChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
type SystemOneResponse = {
  model: string;
  answers: Record<string, NoulAnswer | ChoiceAnswer>;
  usage?: { input_tokens?: number };
};

async function post(body: unknown): Promise<SystemOneResponse> {
  const url = `${env.TYPESAFE_URL || "https://api.typesafe.ai"}/v1/systemone`;
  const timeout = Number(env.JEV_TIMEOUT_MS) || 8000;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (res.ok) return (await res.json()) as SystemOneResponse;
    const text = (await res.text().catch(() => "")).slice(0, 200);
    if ((res.status === 429 || res.status === 529) && attempt < 2) {
      const after = Number(res.headers.get("retry-after"));
      await Bun.sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 4000) : 400 * 2 ** attempt);
      continue;
    }
    if (res.status === 401) authBlockedUntil = Date.now() + 5 * 60_000; // stop hammering a bad key
    throw new Error(`TypeSafe HTTP ${res.status}: ${text}`);
  }
}

function noul(r: SystemOneResponse, id: string): number {
  const a = r.answers[id];
  if (!a || a.type !== "noul" || typeof a.noul !== "number") throw new Error(`TypeSafe answer ${id} missing`);
  return a.noul;
}

function choice(r: SystemOneResponse, id: string): ChoiceAnswer | null {
  const a = r.answers[id];
  return a && a.type === "choice" && typeof a.choice === "string" ? a : null;
}

function pickSentence(a: ChoiceAnswer | null, candidates: string[]): { text: string | null; confidence: number } {
  if (!a) return { text: null, confidence: 0 };
  const m = /^s(\d+)$/.exec(a.choice);
  const text = m ? (candidates[Number(m[1]) - 1] ?? null) : null;
  return { text, confidence: a.confidence ?? 0 };
}

export function parseResponse(r: SystemOneResponse, candidates: string[], latencyMs: number): JevJudgment {
  const out = choice(r, "outcome");
  if (!out || !OUTCOMES.includes(out.choice as Outcome)) throw new Error("TypeSafe answer outcome missing");
  const blocker = pickSentence(choice(r, "blocker_sentence"), candidates);
  const summary = pickSentence(choice(r, "summary_sentence"), candidates);
  return {
    model: r.model,
    needsHuman: noul(r, "needs_human"),
    outcome: out.choice as Outcome,
    outcomeConfidence: out.confidence,
    outcomeProbabilities: out.probabilities as Partial<Record<Outcome, number>>,
    blockerSentence: blocker.text,
    blockerConfidence: blocker.confidence,
    summarySentence: summary.text,
    summaryConfidence: summary.confidence,
    inputTokens: r.usage?.input_tokens ?? 0,
    latencyMs,
    at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Cache: the board polls every few seconds; an agent's ended turn only needs judging once.
// ---------------------------------------------------------------------------------------------

type Entry = { judgment: JevJudgment | null; error: string | null; at: number; pending: Promise<void> | null };
const cache = new Map<string, Entry>();
const ERROR_RETRY_MS = 30_000;

function keyOf(ev: JevEvidence): string {
  return createHash("sha1").update(JSON.stringify([jevModel(), ev])).digest("hex");
}

/**
 * Jev's judgment of one agent turn. Returns the cached answer, or waits up to waitMs for a new one
 * (the request keeps going in the background and fills the cache for the next poll). Never throws.
 */
export async function judge(ev: JevEvidence, waitMs: number): Promise<JevJudgment | null> {
  if (!jevEnabled()) return null;
  if (!ev.lastMessage.trim() && !ev.blockedNote.trim()) return null; // nothing to read
  const key = keyOf(ev);
  let e = cache.get(key);
  if (e?.judgment) return e.judgment;
  if (e && !e.pending && e.error && Date.now() - e.at < ERROR_RETRY_MS) return null;
  if (!e?.pending) {
    const entry: Entry = e ?? { judgment: null, error: null, at: Date.now(), pending: null };
    const candidates = candidateSentences(ev.blockedNote, ev.lastMessage);
    const body = buildRequest(ev, candidates);
    const t0 = Date.now();
    entry.pending = post(body)
      .then((r) => {
        entry.judgment = parseResponse(r, candidates, Date.now() - t0);
        entry.error = null;
        lastError = null;
      })
      .catch((err) => {
        entry.error = err instanceof Error ? err.message : String(err);
        lastError = entry.error;
        console.warn(`[jev] ${ev.taskId}: ${entry.error}`);
      })
      .finally(() => {
        entry.at = Date.now();
        entry.pending = null;
      });
    cache.set(key, entry);
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
    e = entry;
  }
  if (waitMs > 0 && e.pending) {
    await Promise.race([e.pending, Bun.sleep(waitMs)]);
  }
  return e.judgment;
}

// ---------------------------------------------------------------------------------------------
// Policy: code decides what a judgment means for the board.
// ---------------------------------------------------------------------------------------------

/** Card detail from an agent's own sentence. First person is rewritten so the standup reads well. */
export function toDetail(sentence: string): string {
  let s = sentence.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  const rules: Array<[RegExp, string]> = [
    [/^I (?:still |also )?need(?:s)? /i, "Needs "],
    [/^I(?:'m| am) (?:still )?missing /i, "Missing "],
    [/^I (?:couldn't|could not|was unable to|wasn't able to) /i, "Couldn't "],
    [/^I (?:can't|cannot|am unable to|can not) /i, "Can't "],
    [/^I(?:'m| am) (?:blocked|stuck) (on|by|without|until) /i, "Blocked $1 "],
    [/^I(?:'m| am) waiting (?:for|on) /i, "Waiting for "],
  ];
  for (const [re, rep] of rules) {
    if (re.test(s)) {
      s = s.replace(re, rep);
      break;
    }
  }
  if (/^(?:I|I'm|I've|I'd|I'll|My|We)\b/.test(s)) s = `Says: ${s}`;
  if (s.length > 160) s = s.slice(0, 157).replace(/\s+\S*$/, "") + "...";
  return s;
}

export type Applied = Decision & { changedBy: "jev" | null; why: string };

/**
 * Combine the code rule's decision with Jev's judgment.
 *   blocked_file: BLOCKED.md always means stuck (PRD rule). Jev only picks the clearest sentence.
 *   turn_ended:   Jev may move needs_review/stuck when it is confident; unsure answers keep the code rule.
 */
export function applyJudgment(d: Decision, j: JevJudgment, x: { basis: Basis; hasChanges: boolean }): Applied {
  const blocker =
    j.blockerSentence && j.blockerConfidence >= SENTENCE_MIN_CONF ? toDetail(j.blockerSentence) : null;
  const summary =
    j.summarySentence && j.summaryConfidence >= SENTENCE_MIN_CONF ? toDetail(j.summarySentence) : null;
  const keep = (why: string): Applied => ({ ...d, changedBy: null, why });
  const bare = (s: string) => s.trim().replace(/[.!]+$/, "");
  const set = (status: AgentStatus, detail: string, why: string): Applied => {
    if (bare(detail) === bare(d.detail)) detail = d.detail; // same sentence, keep the rule's punctuation
    return { status, detail, changedBy: status !== d.status || detail !== d.detail ? "jev" : null, why };
  };
  const p = j.needsHuman.toFixed(2);

  if (x.basis === "blocked_file") {
    return blocker ? set("stuck", blocker, `BLOCKED.md; Jev picked the clearest sentence`) : keep("BLOCKED.md");
  }
  if (j.needsHuman >= YES) {
    return set("stuck", blocker ?? (d.status === "stuck" ? d.detail : "Needs something from you"), `needs_human ${p}`);
  }
  if (j.needsHuman > NO) return keep(`needs_human ${p} is unsure; kept the code rule`);
  if (j.outcomeConfidence < OUTCOME_MIN_CONF) return keep(`outcome ${j.outcome} unsure (${j.outcomeConfidence.toFixed(2)})`);

  switch (j.outcome) {
    case "failed":
      return set("stuck", blocker ?? "Stopped on an error it couldn't fix", `outcome failed`);
    case "finished":
    case "no_change_needed":
      if (x.hasChanges) return keep(`outcome ${j.outcome}; diff stat says more than a sentence`);
      return set(
        "needs_review",
        !summary
          ? "Says no code changes were needed"
          : /\bno (?:code )?changes?\b|\bnothing to change\b/i.test(summary)
            ? summary
            : `No code changes: ${summary}`,
        `outcome ${j.outcome}`,
      );
    case "blocked_on_person":
      // needs_human said no but outcome says blocked: conflicting, keep the code rule.
      return keep(`outcome blocked_on_person but needs_human ${p}; kept the code rule`);
    case "partial":
      return x.hasChanges ? keep("outcome partial") : set("stuck", blocker ?? "Stopped before finishing", "outcome partial, no changes");
  }
}

// ---------------------------------------------------------------------------------------------
// Introspection for GET /api/agents/judgments (debugging, demo, and tuning thresholds)
// ---------------------------------------------------------------------------------------------

export type JudgmentRecord = {
  taskId: string;
  basis: Basis;
  rule: Decision;
  final: Decision;
  changedBy: "jev" | null;
  why: string;
  judgment: JevJudgment;
};

const latestByTask = new Map<string, JudgmentRecord>();

export function recordJudgment(r: JudgmentRecord): void {
  const prev = latestByTask.get(r.taskId);
  latestByTask.set(r.taskId, r);
  if (!prev || prev.judgment.at !== r.judgment.at || prev.final.status !== r.final.status) {
    const j = r.judgment;
    console.log(
      `[jev] ${r.taskId}: needs_human=${j.needsHuman.toFixed(2)} outcome=${j.outcome}(${j.outcomeConfidence.toFixed(2)}) ` +
        `${r.rule.status} -> ${r.final.status}${r.changedBy ? ` "${r.final.detail}"` : ""} (${j.model}, ${j.latencyMs}ms)`,
    );
  }
}

/** Tests only: drop cached judgments, records, the auth back-off and the last error. */
export function resetJev(): void {
  latestByTask.clear();
  cache.clear();
  authBlockedUntil = 0;
  lastError = null;
}

export function jevSnapshot() {
  return {
    enabled: jevEnabled(),
    configured: !!env.TYPESAFE_API_KEY,
    model: jevModel(),
    lastError,
    judgments: [...latestByTask.values()],
  };
}
