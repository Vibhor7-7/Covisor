// OWNER: context agent (B1). Most recent Granola meeting via Granola's public API.
//
// Why the API and not the desktop app's files: on this Mac, Granola's local stores
// (~/Library/Application Support/Granola/cache-v6.json.enc and granola.db) are
// encrypted at rest, so they can't be read directly. The public API needs a personal
// API key (Business/Enterprise plan; Granola app > Settings > Connectors > API keys),
// set as GRANOLA_API_KEY.
// Docs: https://docs.granola.ai/api-reference/list-notes and /get-note
//
// Never throws. Returns null when the key is missing, the call fails, or there are no notes.
// The returned summary is raw markdown/text; context.ts normalizes it.
import type { Meeting } from "./types";

const API = "https://public-api.granola.ai/v1";
const TIMEOUT_MS = 5_000;

type NoteListItem = { id: string; title: string | null; created_at: string };
type NoteList = { notes?: NoteListItem[] };
type Note = NoteListItem & {
  summary_text?: string | null;
  summary_markdown?: string | null;
  calendar_event?: { event_title?: string | null; scheduled_start_time?: string | null } | null;
};

async function get<T>(path: string, key: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${res.status} on ${path.split("?")[0]}${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json()) as T;
}

export async function fetchLatestGranolaMeeting(): Promise<Meeting | null> {
  const key = (process.env.GRANOLA_API_KEY ?? "").trim();
  if (!key) {
    console.log(
      "[context] Granola skipped: GRANOLA_API_KEY is not set (the desktop app's local cache is encrypted, so the API is the only source)",
    );
    return null;
  }
  try {
    // Newest first by creation time; only notes with a generated summary are listed.
    const list = await get<NoteList>("/notes?page_size=1", key);
    const latest = list.notes?.[0];
    if (!latest) {
      console.log("[context] Granola: no summarized notes found");
      return null;
    }
    const note = await get<Note>(`/notes/${encodeURIComponent(latest.id)}`, key);
    const summary = (note.summary_markdown || note.summary_text || "").trim();
    if (!summary) {
      console.log("[context] Granola: latest note has no summary");
      return null;
    }
    const title = note.title?.trim() || note.calendar_event?.event_title?.trim() || "Untitled meeting";
    const date = note.calendar_event?.scheduled_start_time || note.created_at || latest.created_at;
    console.log("[context] Granola: loaded the most recent meeting");
    return { title, date, summary };
  } catch (err) {
    console.warn(`[context] Granola unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
