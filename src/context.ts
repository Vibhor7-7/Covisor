// OWNER: context agent (B1). GET /api/context: open Linear issues + last meeting + a speakable brief.
//
// Env (read here, all optional):
//   MEETING_SOURCE   auto (default) | granola | file. auto tries Granola, then context/meeting.md.
//   GRANOLA_API_KEY  enables the Granola source (see src/granola.ts).
//   LINEAR_API_KEY / LINEAR_TEAM_KEY via config (see src/linear.ts).
//
// getContext() never throws: each source fails on its own and yields an empty state.
import { join } from "node:path";
import { ROOT } from "./config";
import { fetchLatestGranolaMeeting } from "./granola";
import { fetchOpenIssues, LINEAR_LIMIT, type LinearResult } from "./linear";
import type { ContextResponse, Issue, Meeting } from "./types";

const MEETING_FILE = join(ROOT, "context", "meeting.md");
const TTL_MS = 60_000;
const DEGRADED_TTL_MS = 10_000; // retry sooner when a source failed
const BRIEF_ISSUES = 5;
const MEETING_SUMMARY_MAX = 500;
const BRIEF_MEETING_MAX = 300;

type MeetingSource = "auto" | "granola" | "file";

// ---------- text helpers ----------

/** Markdown or plain notes -> one paragraph of sentences. Drops headings, bullets, comments. */
function toParagraph(md: string): string {
  const sentences: string[] = [];
  for (const raw of md.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^([-*_])\1{2,}$/.test(line)) continue;
    line = line
      .replace(/^([-*+•]|\d+[.)])\s+/, "") // bullets and numbering
      .replace(/^\[[ xX]\]\s+/, "") // task checkboxes
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> text
      .replace(/\*\*|__|`/g, "") // bold, code
      .trim();
    if (!line) continue;
    if (!/[.!?:;]$/.test(line)) line += ".";
    sentences.push(line);
  }
  return sentences.join(" ").replace(/\s+/g, " ").trim();
}

/** Shorten to max chars, preferring a sentence boundary. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max + 1);
  const end = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (end >= max * 0.4) return text.slice(0, end + 1);
  const space = window.lastIndexOf(" ", max);
  return `${text.slice(0, space > 0 ? space : max).replace(/[\s,;:]+$/, "")}…`;
}

/** "2026-11-19" is a local calendar day (new Date() would read it as UTC midnight). */
function parseDate(s: string): Date | null {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "today", "yesterday", "on Thursday" (within a week), else "on November 3". */
function whenLabel(date: string): string {
  if (!date) return "";
  const d = parseDate(date);
  if (!d) return `on ${date}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date()) - day(d)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days > 1 && days < 7) return `on ${d.toLocaleDateString("en-US", { weekday: "long" })}`;
  return `on ${d.toLocaleDateString("en-US", { month: "long", day: "numeric" })}`;
}

// ---------- meeting sources ----------

/** context/meeting.md: "# Title", a "Date: YYYY-MM-DD" line, the rest is the summary. */
function parseMeetingFile(md: string): Meeting | null {
  let title = "";
  let date = "";
  const rest: string[] = [];
  for (const line of md.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    const t = line.trim();
    if (!title && /^#\s+/.test(t)) {
      title = t.replace(/^#\s+/, "").trim();
      continue;
    }
    const d = t.match(/^\*{0,2}date\*{0,2}\s*:\s*\*{0,2}\s*(.+)$/i);
    if (!date && d?.[1]) {
      date = d[1].replace(/\*+$/, "").trim();
      continue;
    }
    rest.push(line);
  }
  const summary = rest.join("\n").trim();
  if (!title && !summary) return null;
  return { title: title || "Last meeting", date, summary };
}

async function readMeetingFile(): Promise<Meeting | null> {
  try {
    const file = Bun.file(MEETING_FILE);
    if (!(await file.exists())) {
      console.log("[context] Meeting file skipped: context/meeting.md not found");
      return null;
    }
    const meeting = parseMeetingFile(await file.text());
    if (!meeting) console.log("[context] Meeting file skipped: context/meeting.md is empty");
    return meeting;
  } catch (err) {
    console.warn(`[context] Meeting file unreadable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function meetingSource(): MeetingSource {
  const raw = (process.env.MEETING_SOURCE ?? "auto").trim().toLowerCase();
  if (raw === "" || raw === "auto") return "auto";
  if (raw === "granola" || raw === "file") return raw;
  console.warn(`[context] Unknown MEETING_SOURCE "${raw}", using auto`);
  return "auto";
}

async function safeGranola(): Promise<Meeting | null> {
  try {
    return await fetchLatestGranolaMeeting();
  } catch {
    return null;
  }
}

async function loadMeeting(): Promise<{ meeting: Meeting | null; from: string }> {
  const source = meetingSource();
  let raw: Meeting | null = null;
  let from = "none";
  if (source !== "file") {
    raw = await safeGranola();
    if (raw) from = "granola";
  }
  if (!raw && source !== "granola") {
    raw = await readMeetingFile();
    if (raw) from = "file";
  }
  if (!raw) return { meeting: null, from };
  const d = parseDate(raw.date);
  return {
    meeting: {
      title: raw.title.trim() || "Last meeting",
      date: d ? isoDay(d) : raw.date.trim(),
      summary: clip(toParagraph(raw.summary), MEETING_SUMMARY_MAX),
    },
    from,
  };
}

async function loadLinear(): Promise<LinearResult> {
  try {
    return await fetchOpenIssues();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: "error", issues: [], reason };
  }
}

// ---------- brief ----------

function issuePart(linear: LinearResult): string {
  if (linear.status !== "ok") return "Linear is not connected.";
  const issues: Issue[] = linear.issues;
  const n = issues.length;
  if (n === 0) return "Linear has no open issues.";
  const count = n >= LINEAR_LIMIT ? `at least ${n} open issues` : `${n} open issue${n === 1 ? "" : "s"}`;
  const shown = issues.slice(0, BRIEF_ISSUES).map((i) => `${i.key} ${i.title.trim().replace(/[.\s]+$/, "")}`);
  const lead = n > BRIEF_ISSUES ? `, top ${BRIEF_ISSUES}` : "";
  return `Linear has ${count}${lead}: ${shown.join("; ")}.`;
}

function meetingPart(meeting: Meeting | null): string {
  if (!meeting) return "No meeting notes are connected.";
  const when = whenLabel(meeting.date);
  const head = `Last meeting was "${meeting.title}"${when ? ` ${when}` : ""}.`;
  return meeting.summary ? `${head} ${clip(meeting.summary, BRIEF_MEETING_MAX)}` : head;
}

function buildBrief(linear: LinearResult, meeting: Meeting | null): string {
  if (linear.status !== "ok" && !meeting) {
    return "No project context yet: Linear and meeting notes are not connected.";
  }
  return `${issuePart(linear)} ${meetingPart(meeting)}`;
}

// ---------- cache ----------

let cached: { value: ContextResponse; expires: number } | null = null;
let inflight: Promise<ContextResponse> | null = null;

async function build(): Promise<{ value: ContextResponse; degraded: boolean }> {
  const [linear, { meeting, from }] = await Promise.all([loadLinear(), loadMeeting()]);
  const value: ContextResponse = { brief: buildBrief(linear, meeting), linear: linear.issues, meeting };
  console.log(
    `[context] refreshed: linear=${linear.status}(${linear.issues.length}) meeting=${from} brief=${value.brief.length} chars`,
  );
  return { value, degraded: linear.status === "error" || !meeting };
}

export async function getContext(): Promise<ContextResponse> {
  if (cached && cached.expires > Date.now()) return cached.value;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { value, degraded } = await build();
      cached = { value, expires: Date.now() + (degraded ? DEGRADED_TTL_MS : TTL_MS) };
      return value;
    } catch (err) {
      // Should be unreachable (every source catches), but never let the route fail.
      console.error(`[context] build failed: ${err instanceof Error ? err.message : String(err)}`);
      return cached?.value ?? { brief: buildBrief({ status: "error", issues: [], reason: "" }, null), linear: [], meeting: null };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
