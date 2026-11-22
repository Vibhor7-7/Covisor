// OWNER: status agent (B3).
// Read-only Codevisor access for the status service:
//   - listSessions(): GET /v1/sessions (short timeout, 1s cache, concurrent callers share one request)
//   - an optional background SSE subscriber on GET /v1/events?since=CURSOR (cursor from
//     GET /v1/events/cursor) that keeps a per-session cache of the latest session payload and the
//     last activity time. It starts lazily, reconnects quietly with backoff, and never throws.
// Never creates, modifies or deletes sessions. Never logs the token.
//
// Shapes seen on Codevisor v0.1.117:
//   - GET /v1/sessions -> CvSession[]; status lives in `sidebarState`
//     ("idle" | "inProgress" | "waitingForUser" | "unread" | "errored").
//   - SSE frames are `id: N` / `event: <kind>` / `data: {id, kind, subjectId, createdAt, payload}`.
//     For session.created / session.updated / session.attention.updated the payload is the full
//     session object (same shape as a /v1/sessions item) and subjectId is the session id.
//     A `keepalive` kind arrives with an empty payload.
import { config } from "./config";

export type SidebarState = "idle" | "inProgress" | "waitingForUser" | "unread" | "errored";

/** The fields of a Codevisor session (GET /v1/sessions item, also the session.* event payload) we use. */
export type CvSession = {
  id: string;
  projectId?: string;
  title?: string;
  worktreeName?: string | null;
  cwd?: string | null;
  isArchived?: boolean | null;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string | null;
  sidebarState?: SidebarState | null;
  sidebarStateChangedAt?: string | null;
  actionRequired?: boolean | null;
  actionRequiredKind?: "question" | "approval" | "planApproval" | null;
  pendingPlanApproval?: boolean | null;
  lastTurnFailure?: "error" | "usageLimit" | null;
  hasUnreadError?: boolean | null;
  latestBotMessage?: unknown;
};

/** What the events stream told us about one session. */
export type SessionActivity = {
  /** ISO time of the last session.* event that reflects agent activity (not just the user reading it). */
  lastEventAt: string | null;
  lastKind: string | null;
  deleted: boolean;
  errorMessage: string | null;
  /** Latest session payload seen on the stream. */
  session: CvSession | null;
};

export type SessionList = {
  sessions: Map<string, CvSession>;
  /** Why the list could not be fetched (sessions then come from the events cache only). */
  error: string | null;
  fetchedAt: number;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const LIST_CACHE_MS = 1000;
const STREAM_IDLE_MS = 90_000; // reconnect if the stream is silent this long (keepalives included)
const MAX_TRACKED = 1000;

function baseUrl(): string {
  return config.codevisorUrl.replace(/\/+$/, "");
}

function authHeaders(): Record<string, string> {
  return config.codevisorToken ? { Authorization: `Bearer ${config.codevisorToken}` } : {};
}

function httpTimeoutMs(): number {
  const n = Number(process.env.STATUS_HTTP_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 800;
}

/** Turns fetch errors into a short message. Never includes headers (so never the token). */
export function describeError(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  const name = e instanceof Error ? e.name : "";
  const msg = e instanceof Error ? e.message : String(e);
  if (name === "TimeoutError" || /timed out/i.test(msg)) return "Codevisor did not answer in time";
  if (name === "AbortError") return "request aborted";
  if (/ECONNREFUSED|Unable to connect|ConnectionRefused|fetch failed/i.test(msg)) return "Codevisor is not reachable";
  return msg.slice(0, 160);
}

async function getJson<T>(path: string, timeoutMs = httpTimeoutMs()): Promise<T> {
  const res = await fetch(baseUrl() + path, { headers: authHeaders(), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new HttpError(res.status, `Codevisor ${path.split("?")[0]} returned HTTP ${res.status}`);
  return (await res.json()) as T;
}

function isSession(v: unknown): v is CvSession {
  return !!v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string";
}

function sessionStamp(s: CvSession | null | undefined): number {
  if (!s) return -1;
  const a = Date.parse(s.updatedAt ?? "");
  const b = Date.parse(s.sidebarStateChangedAt ?? "");
  return Math.max(Number.isFinite(a) ? a : -1, Number.isFinite(b) ? b : -1);
}

// ---------------------------------------------------------------------------------------------
// Session list
// ---------------------------------------------------------------------------------------------

let listCache: SessionList | null = null;
let listInflight: Promise<SessionList> | null = null;
let listWarned = false;

/**
 * All Codevisor sessions by id. Never throws. When the HTTP call fails, `error` says why and the
 * map holds whatever the events stream has seen. When both have a session, the fresher one wins.
 */
export function listSessions(): Promise<SessionList> {
  if (listCache && Date.now() - listCache.fetchedAt < LIST_CACHE_MS) return Promise.resolve(listCache);
  if (listInflight) return listInflight;
  listInflight = (async (): Promise<SessionList> => {
    const sessions = new Map<string, CvSession>();
    let error: string | null = null;
    if (!config.codevisorToken) {
      error = "CODEVISOR_TOKEN is not set";
    } else {
      try {
        const arr = await getJson<unknown>("/v1/sessions");
        if (!Array.isArray(arr)) throw new Error("unexpected /v1/sessions response");
        for (const s of arr) if (isSession(s)) sessions.set(s.id, s);
        listWarned = false;
      } catch (e) {
        error = describeError(e);
        if (!listWarned) console.warn(`[status] Codevisor session list unavailable: ${error}`);
        listWarned = true;
      }
    }
    // Merge in fresher payloads from the events stream (or all of them if the list failed).
    for (const [id, a] of activity) {
      if (!a.session || a.deleted) continue;
      const fromList = sessions.get(id);
      // Missing from the list (list failed, or it leaves some out, e.g. archived): the stream saw it
      // and no session.deleted followed, so keep it.
      if (!fromList || sessionStamp(a.session) > sessionStamp(fromList)) sessions.set(id, a.session);
    }
    const out: SessionList = { sessions, error, fetchedAt: Date.now() };
    listCache = out;
    return out;
  })()
    .catch((e): SessionList => ({ sessions: new Map(), error: describeError(e), fetchedAt: Date.now() }))
    .finally(() => {
      listInflight = null;
    });
  return listInflight;
}

// ---------------------------------------------------------------------------------------------
// Pending question (GET /v1/agents/{id}), only asked for sessions waiting on a question
// ---------------------------------------------------------------------------------------------

const questionCache = new Map<string, { text: string | null; at: number }>();

/**
 * The question a session is waiting on (pendingQuestion.questions[0].question, else .message).
 * Never throws: unknown ids (404, or 500 "Session not found") and timeouts give null. Cached 3s.
 */
export async function getPendingQuestion(sessionId: string): Promise<string | null> {
  const hit = questionCache.get(sessionId);
  if (hit && Date.now() - hit.at < 3000) return hit.text;
  let text: string | null = null;
  if (config.codevisorToken) {
    try {
      const a = await getJson<{ pendingQuestion?: { message?: unknown; questions?: Array<{ question?: unknown }> } | null }>(
        `/v1/agents/${encodeURIComponent(sessionId)}`,
      );
      const q = a?.pendingQuestion;
      const first = Array.isArray(q?.questions) ? q.questions[0]?.question : null;
      text = typeof first === "string" && first ? first : typeof q?.message === "string" && q.message ? q.message : null;
    } catch {
      text = null;
    }
  }
  questionCache.set(sessionId, { text, at: Date.now() });
  if (questionCache.size > 200) questionCache.delete(questionCache.keys().next().value!);
  return text;
}

// ---------------------------------------------------------------------------------------------
// Events subscriber (secondary source)
// ---------------------------------------------------------------------------------------------

const activity = new Map<string, SessionActivity>();
const kindCounts = new Map<string, number>();
let running = false;
let connected = false;
let abortCtl: AbortController | null = null;
let lastEventId: number | null = null;
let lastStreamError: string | null = null;
let connectCount = 0;

export function getSessionActivity(sessionId: string): SessionActivity | null {
  return activity.get(sessionId) ?? null;
}

export function eventsStatus() {
  return {
    running,
    connected,
    connects: connectCount,
    lastEventId,
    lastError: lastStreamError,
    kinds: Object.fromEntries(kindCounts),
    trackedSessions: activity.size,
  };
}

/**
 * Starts the background /v1/events subscription once. No-op when already running, when
 * STATUS_EVENTS=0, or when there is no token. `since` replays from an older cursor (tests only).
 */
export function ensureEventsSubscriber(opts: { since?: number } = {}): void {
  if (running || process.env.STATUS_EVENTS === "0" || !config.codevisorToken) return;
  running = true;
  if (typeof opts.since === "number") lastEventId = opts.since;
  void eventsLoop().catch(() => {
    running = false;
    connected = false;
  });
}

export function stopEventsSubscriber(): void {
  running = false;
  abortCtl?.abort();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function eventsLoop(): Promise<void> {
  let backoff = 1000;
  let warned = false;
  while (running) {
    try {
      if (lastEventId === null) {
        const c = await getJson<{ cursor?: unknown }>("/v1/events/cursor", 2000);
        const n = Number(c?.cursor);
        lastEventId = Number.isFinite(n) && n >= 0 ? n : 0;
      }
      await streamOnce(() => {
        backoff = 1000;
        if (warned) console.warn("[status] Codevisor events stream reconnected");
        warned = false;
        lastStreamError = null;
      });
    } catch (e) {
      if (!running) break;
      lastStreamError = describeError(e);
      if (!warned) console.warn(`[status] Codevisor events stream unavailable (${lastStreamError}); retrying quietly`);
      warned = true;
      // A rejected cursor: start again from the current one.
      if (e instanceof HttpError && [400, 404, 409, 410, 422].includes(e.status)) lastEventId = null;
    }
    connected = false;
    if (!running) break;
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }
  connected = false;
}

async function streamOnce(onOpen: () => void): Promise<void> {
  const ctl = new AbortController();
  abortCtl = ctl;
  let watchdog = setTimeout(() => ctl.abort(), STREAM_IDLE_MS);
  const bump = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => ctl.abort(), STREAM_IDLE_MS);
  };
  try {
    const res = await fetch(`${baseUrl()}/v1/events?since=${lastEventId ?? 0}`, {
      headers: { ...authHeaders(), Accept: "text/event-stream" },
      signal: ctl.signal,
    });
    if (!res.ok || !res.body) throw new HttpError(res.status, `Codevisor /v1/events returned HTTP ${res.status}`);
    connected = true;
    connectCount++;
    onOpen();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bump();
      buf += dec.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleFrame(frame);
      }
      if (buf.length > 4_000_000) buf = ""; // a runaway frame: drop it rather than grow forever
    }
  } finally {
    clearTimeout(watchdog);
    connected = false;
  }
}

function handleFrame(frame: string): void {
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
  }
  if (!data) return;
  try {
    handleEvent(JSON.parse(data));
  } catch {
    /* malformed frame: ignore */
  }
}

/** Applies one Codevisor event to the cache. Exported for tests. */
export function handleEvent(ev: unknown): void {
  if (!ev || typeof ev !== "object") return;
  const e = ev as { id?: unknown; kind?: unknown; subjectId?: unknown; createdAt?: unknown; payload?: unknown };
  const kind = typeof e.kind === "string" ? e.kind : "unknown";
  kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  if (kind === "keepalive") return;
  const id = Number(e.id);
  if (Number.isFinite(id) && (lastEventId === null || id > lastEventId)) lastEventId = id;
  if (!kind.startsWith("session.")) return;
  const sid = typeof e.subjectId === "string" ? e.subjectId : "";
  if (!sid) return;

  const entry: SessionActivity = activity.get(sid) ?? {
    lastEventAt: null,
    lastKind: null,
    deleted: false,
    errorMessage: null,
    session: null,
  };
  const at = typeof e.createdAt === "string" && Number.isFinite(Date.parse(e.createdAt)) ? e.createdAt : new Date().toISOString();
  const prevState = entry.session?.sidebarState ?? null;
  if (isSession(e.payload) && e.payload.id === sid) entry.session = e.payload;
  // attention.updated also fires when the user reads a session; only count it when the state moved.
  // unread -> idle is the user opening the session, not the agent doing anything.
  const newState = entry.session?.sidebarState ?? null;
  const userRead = prevState === "unread" && newState === "idle";
  const isActivity = !userRead && (kind !== "session.attention.updated" || newState !== prevState);
  if (isActivity && (!entry.lastEventAt || Date.parse(at) > Date.parse(entry.lastEventAt))) entry.lastEventAt = at;
  entry.lastKind = kind;
  if (kind === "session.deleted") entry.deleted = true;
  if (kind === "session.created" || kind === "session.unarchived") entry.deleted = false;
  if (entry.session && (kind === "session.archived" || kind === "session.unarchived")) {
    entry.session = { ...entry.session, isArchived: kind === "session.archived" };
  }
  if (kind === "session.error") entry.errorMessage = errorText(e.payload);

  activity.delete(sid); // re-insert so the map stays in recency order
  activity.set(sid, entry);
  if (activity.size > MAX_TRACKED) {
    const oldest = activity.keys().next().value;
    if (oldest !== undefined) activity.delete(oldest);
  }
  listCache = null; // next poll sees the change
}

function errorText(payload: unknown): string | null {
  if (typeof payload === "string") return payload.slice(0, 160);
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    for (const k of ["message", "error", "reason", "detail"]) {
      const v = p[k];
      if (typeof v === "string" && v) return v.slice(0, 160);
      if (v && typeof v === "object" && typeof (v as { message?: unknown }).message === "string") {
        return String((v as { message: string }).message).slice(0, 160);
      }
    }
  }
  return null;
}
