// OWNER: manager agent (B2). Turns Claude Code `--output-format stream-json --verbose` lines into
// readable, step-tagged `log` RunEvents for the Build view.
//
// Line shapes (captured from claude 2.1.330):
//   {"type":"system","subtype":"init","model":"claude-sonnet-5-5","tools":[...],"mcp_servers":[{"name","status"}],...}
//   {"type":"assistant","message":{"content":[{"type":"text","text":"[context] Reading package.json"}]},...}
//   {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/abs"}}]},...}
//   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"...","content":"..."}]},...}
//   {"type":"rate_limit_event",...}
//   {"type":"result","subtype":"success","is_error":false,"result":"...","total_cost_usd":0.02,"num_turns":6,...}
// An API failure shows up as an assistant text line with `is_api_error_message: true` plus a result
// line with `is_error: true` and the error text in `result`.
import { basename, relative, sep } from "node:path";
import type { RunEventInput } from "./runs";

export type LogEventInput = Extract<RunEventInput, { type: "log" }>;

export type ManagerResult = {
  isError: boolean;
  text: string;
  costUsd?: number;
  turns?: number;
  durationMs?: number;
  denied: string[]; // tool names whose use was denied
};

export type ParsedLine = {
  events: LogEventInput[];
  init?: { model: string; mcpServers: Array<{ name: string; status: string }> };
  result?: ManagerResult;
};

export type ParserOptions = {
  /** Repo roots used to shorten paths (pass both the given path and its realpath). */
  repoRoots: string[];
  /** Absolute run dir; writes to <runDir>/plan.json read as "Writing plan". */
  runDir: string;
  /** Minimum gap between spoken lines, so narration never floods the TTS queue. */
  minSpeakGapMs?: number;
  now?: () => number;
};

const KNOWN_STEPS = new Set(["context", "plan", "codevisor"]);
const TAG_RE = /^\[([a-z]+)\]\s*:?\s*(.*)$/i;
const MAX_MSG = 160;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Strip markdown and whitespace noise so a line reads (and speaks) cleanly. */
export function cleanText(s: string): string {
  let t = s
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*(?:[-*>•]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > MAX_MSG) t = t.slice(0, MAX_MSG - 1).trimEnd() + "…";
  return t;
}

/** "claude-sonnet-5-5" -> "Sonnet 5.5"; unknown shapes come back unchanged. */
export function prettyModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  if (!m) return id;
  const name = m[1]![0]!.toUpperCase() + m[1]!.slice(1);
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function humanize(s: string): string {
  return s.replace(/[_-]+/g, " ").trim();
}

export class StreamJsonParser {
  /** Current step, driven by the manager's [tag] lines and its tool calls. */
  step = "context";
  private lastSpokenAt = 0;
  private sinceSpoken = 0;
  private spokenSteps = new Set<string>();
  private lastMessage = "";
  private linearSeen = false;
  private readonly opts: Required<ParserOptions>;

  constructor(opts: ParserOptions) {
    this.opts = { minSpeakGapMs: 6000, now: () => Date.now(), ...opts };
  }

  /** Tell the parser a line was spoken elsewhere (backend narration), for throttling. */
  noteSpoken(step?: string): void {
    this.lastSpokenAt = this.opts.now();
    this.sinceSpoken = 0;
    if (step) this.spokenSteps.add(step);
  }

  parseLine(line: string): ParsedLine {
    const out: ParsedLine = { events: [] };
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return out;
    let d: Json;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isObj(parsed)) return out;
      d = parsed;
    } catch {
      return out;
    }

    switch (d.type) {
      case "system":
        if (d.subtype === "init") this.onInit(d, out);
        break;
      case "assistant":
        // Subagent output and API error banners are noise for the live log.
        if (d.parent_tool_use_id || d.is_api_error_message) break;
        this.onAssistant(d, out);
        break;
      case "result":
        out.result = {
          isError: d.is_error === true || (typeof d.subtype === "string" && d.subtype !== "success"),
          text: str(d.result),
          costUsd: typeof d.total_cost_usd === "number" ? d.total_cost_usd : undefined,
          turns: typeof d.num_turns === "number" ? d.num_turns : undefined,
          durationMs: typeof d.duration_ms === "number" ? d.duration_ms : undefined,
          denied: Array.isArray(d.permission_denials)
            ? d.permission_denials.map((p) => (isObj(p) ? str(p.tool_name) : "")).filter(Boolean)
            : [],
        };
        break;
      default:
        // user (tool results), rate_limit_event, stream_event, ...: skip.
        break;
    }
    return out;
  }

  private onInit(d: Json, out: ParsedLine): void {
    const model = str(d.model);
    const mcpServers = Array.isArray(d.mcp_servers)
      ? d.mcp_servers.filter(isObj).map((s) => ({ name: str(s.name), status: str(s.status) }))
      : [];
    out.init = { model, mcpServers };
    this.push(out, { step: "context", message: `Manager is up on ${prettyModel(model) || "Claude"}.` });
    const linear = mcpServers.find((s) => s.name === "linear");
    if (linear && linear.status === "connected") {
      this.push(out, { step: "context", message: "Linear MCP connected." });
    } else if (linear) {
      this.push(out, { step: "context", message: `Linear MCP ${linear.status || "unavailable"}; using the issues from the brief.` });
    }
  }

  private onAssistant(d: Json, out: ParsedLine): void {
    const msg = isObj(d.message) ? d.message : null;
    const content = msg && Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (!isObj(block)) continue;
      if (block.type === "text") this.onText(str(block.text), out);
      else if (block.type === "tool_use") this.onToolUse(str(block.name), isObj(block.input) ? block.input : {}, out);
      // thinking / redacted_thinking: skip.
    }
  }

  private onText(text: string, out: ParsedLine): void {
    for (const raw of text.split("\n")) {
      // Allow light markdown around the tag: "**[plan]** ...", "- [context] ...".
      const line = raw.replace(/^\s*(?:[-*>•]\s+)?(?:\*\*|__|`)?/, "").replace(/^(\[[a-z]+\])(?:\*\*|__|`)/i, "$1");
      const m = TAG_RE.exec(line.trim());
      if (!m) continue; // untagged prose (final summaries, reasoning) is noise for the log
      const tag = m[1]!.toLowerCase();
      if (!KNOWN_STEPS.has(tag)) continue; // e.g. "- [x] done" checklists
      const message = cleanText(m[2] ?? "");
      if (!message) continue;
      const stepChanged = tag !== this.step;
      this.step = tag;
      this.push(out, { step: tag, message }, this.speakTagged(tag, stepChanged));
    }
  }

  private onToolUse(name: string, input: Json, out: ParsedLine): void {
    const t = this.describeTool(name, input);
    if (!t) return;
    if (t.step !== this.step) this.step = t.step;
    this.push(out, { step: t.step, message: t.message }, t.speak === true && this.canSpeak());
  }

  private describeTool(name: string, input: Json): { step: string; message: string; speak?: boolean } | null {
    const path = str(input.file_path) || str(input.path) || str(input.notebook_path);
    const isPlan = path !== "" && basename(path) === "plan.json" && this.inRunDir(path);
    switch (name) {
      case "Read":
        if (isPlan) return { step: "plan", message: "Checking the plan" };
        return { step: "context", message: `Reading ${this.shortPath(path)}` };
      case "Glob": {
        const pattern = oneLine(str(input.pattern), 50); // keep "**": it is glob syntax here
        return { step: "context", message: pattern ? `Looking for files: ${pattern}` : "Listing files" };
      }
      case "Grep": {
        const pattern = oneLine(str(input.pattern), 50);
        return { step: "context", message: `Searching the code for "${pattern}"` };
      }
      case "LS":
        return { step: "context", message: `Listing ${this.shortPath(path)}` };
      case "Write":
        if (isPlan) return { step: "plan", message: "Writing plan", speak: !this.spokenSteps.has("plan") };
        return { step: this.step, message: `Writing ${basename(path) || "a file"}` };
      case "Edit":
      case "MultiEdit":
        if (isPlan) return { step: "plan", message: "Revising plan" };
        return { step: this.step, message: `Editing ${this.shortPath(path)}` };
      case "Bash": {
        const cmd = oneLine(str(input.command), 60);
        return { step: "context", message: cmd ? `Running ${cmd}` : "Running a command" };
      }
      case "TodoWrite":
      case "ToolSearch":
      case "Skill":
        return null;
    }
    const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
    if (mcp) {
      const server = mcp[1]!;
      const action = humanize(mcp[2]!);
      if (server.toLowerCase().includes("linear")) {
        const first = !this.linearSeen;
        this.linearSeen = true;
        return { step: "context", message: first ? `Reading Linear (${action})` : `Linear: ${action}`, speak: first };
      }
      return { step: "context", message: `${humanize(server)}: ${action}` };
    }
    return { step: this.step, message: `Using ${name}` };
  }

  private inRunDir(p: string): boolean {
    const rel = relative(this.opts.runDir, p);
    return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
  }

  private shortPath(p: string): string {
    if (!p) return "the repo";
    for (const root of this.opts.repoRoots) {
      if (!root) continue;
      if (p === root) return "the repo";
      const rel = relative(root, p);
      if (rel && !rel.startsWith("..") && !rel.startsWith(sep)) return rel;
    }
    return basename(p);
  }

  private canSpeak(): boolean {
    return this.opts.now() - this.lastSpokenAt >= this.opts.minSpeakGapMs;
  }

  /** Tagged narration: speak the first line of each step, then about every third line. */
  private speakTagged(step: string, stepChanged: boolean): boolean {
    if (!this.canSpeak()) return false;
    if (stepChanged || !this.spokenSteps.has(step)) return true;
    return this.sinceSpoken >= 3;
  }

  private push(out: ParsedLine, e: { step: string; message: string }, speak = false): void {
    if (e.message === this.lastMessage) return; // repeated reads of the same file etc.
    this.lastMessage = e.message;
    const ev: LogEventInput = { type: "log", step: e.step, message: e.message };
    if (speak) {
      ev.speak = true;
      this.noteSpoken(e.step);
    } else {
      this.sinceSpoken++;
    }
    out.events.push(ev);
  }
}
