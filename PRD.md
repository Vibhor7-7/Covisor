# PRD: Max, the AI engineering manager for your agent team

Working name: **Max** (rename anytime).
Event: YC Startups x ElevenLabs Hackathon. Track: "An AI coworker you would actually hire." Target prizes: Best project built with Codevisor, Best Use of ElevenLabs, Grand Prize.
Rule reminder: fresh repo, all code written today.

---

## 1. One-liner

Codevisor gives you a team of coding agents. Max is the manager: you talk through the project by voice, Max pulls your context (Linear, last meeting), locks the spec with you, then takes over, plans the work, staffs each task with the right model, and launches the agents in Codevisor. Later you ask "how's it going?" and get a real standup.

## 2. The demo we are building toward

1. **Brief.** Open the app. Context panel already shows open Linear issues and the last meeting summary. Click "Talk to Max."
2. **Planning call.** Max opens with context: "Thursday you agreed on Stripe. Linear has 3 open checkout bugs. Fixing those first or shipping around them?" 2 to 3 sharp technical questions. The spec panel fills in live as we talk. You say "Ship it."
3. **Takeover.** Max says "Taking over now." Screen switches to Build view: live log streams ("Reading Linear... Writing plan... Starting agent 1 in Codevisor..."), staffing table shows each task with its model, short spoken narration. Codevisor window on the side fills with new sessions.
4. **Standup.** Switch to pre-run agents. "Max, standup." Max: "Two done, one needs review, tests agent is stuck on a missing Stripe key."
5. **Close.** "Built with Codevisor, built for Codevisor. A manager that actually knows your project."

Everything below exists to make this flow work. If a feature does not show up in this flow, it is a stretch goal.

---

## 3. Architecture

```
[Browser: React app]
   |  ElevenLabs voice agent (@elevenlabs/react), client tools
   |  REST + SSE
   v
[Backend: Bun + Elysia, localhost:3001]
   |-- Context: Linear API/MCP, Granola (MCP or exported file)
   |-- Manager run: `claude -p` headless, writes plan.json
   |-- Dispatcher: launches each task via Codevisor CLI (fallback: HTTP API, then `codevisor mcp`)
   |-- Status: Codevisor CLI/events -> normalized agent status
   |-- TTS narration: ElevenLabs TTS
   v
[Codevisor app + local server on the same Mac]
```

Owner split:
- **Person A: UI and front-facing features** (Section 5). Owns the React app and the ElevenLabs agent config (prompt, client tools).
- **Person B: Backend and setup** (Section 6). Owns the server, context fetching, manager run, Codevisor integration, status, TTS.

They only meet at the **shared contract** (Section 4). A builds against mocks until B is live.

---

## 4. Shared contract (agree on this first, do not change without telling the other person)

### 4.1 Spec object (produced by the voice conversation)

```ts
type Spec = {
  title: string;               // "Stripe checkout v1"
  goal: string;                // one paragraph
  user: string;                // who it is for
  scopeIn: string[];
  scopeOut: string[];
  decisions: string[];         // "Use Stripe Checkout, not Elements"
  constraints: string[];       // "No new DB tables", "Must pass existing tests"
  acceptance: string[];        // how we know it is done
  openQuestions: string[];     // things Max could not resolve
  repoPath: string;            // absolute path to demo repo
};
```

### 4.2 Plan object (produced by the manager run)

```ts
type Plan = {
  runId: string;
  tasks: Array<{
    id: string;                // "t1"
    title: string;
    prompt: string;            // full spec handed to the coding agent
    acceptance: string[];
    model: "opus" | "sonnet" | "local";
    reason: string;            // why this model ("routine UI work")
    dependsOn: string[];
  }>;
};
```

### 4.3 Agent status (what the board and standup show)

```ts
type AgentStatus = "queued" | "working" | "needs_review" | "stuck" | "done" | "error";

type Agent = {
  taskId: string;
  sessionId: string | null;    // Codevisor session id
  title: string;
  model: string;
  status: AgentStatus;
  detail: string;              // "Needs STRIPE_TEST_KEY", "+212 -8, 4 files"
  lastActivityAt: string;      // ISO
};
```

### 4.4 REST endpoints (backend serves, frontend calls)

| Method | Path | Body | Returns | Notes |
|---|---|---|---|---|
| GET | `/api/context` | none | `{ brief: string, linear: Issue[], meeting: { title, date, summary } }` | `brief` is a short paragraph injected into the voice agent |
| POST | `/api/build` | `{ spec: Spec }` | `{ runId: string }` | Starts the manager run |
| GET | `/api/runs/:runId/stream` | none | SSE stream of `RunEvent` | Live log for the Build view |
| GET | `/api/agents` | none | `Agent[]` | Board polls it |
| GET | `/api/standup` | none | `{ summary: string, agents: Agent[] }` | `summary` is speakable text |
| POST | `/api/tts` | `{ text: string }` | `audio/mpeg` | Narration lines |
| POST | `/api/kill` | none | `{ ok: true }` | Kill switch, stops the manager run |

```ts
type Issue = { id: string; key: string; title: string; state: string; priority?: number };

type RunEvent =
  | { type: "log";     ts: string; step: string; message: string; speak?: boolean }
  | { type: "plan";    ts: string; plan: Plan }
  | { type: "agent";   ts: string; agent: Agent }
  | { type: "done";    ts: string }
  | { type: "error";   ts: string; message: string };
```

### 4.5 Mocks

`/mocks` folder at the repo root, owned by B, written before anything else:
- `context.json`, `plan.json`, `agents.json`, `standup.json`
- `run-events.jsonl` (one RunEvent per line, about 15 lines, realistic)

Backend flag `MOCK=1` serves these from the real endpoints (SSE replays `run-events.jsonl` with short gaps between events). Frontend always talks to the real endpoints, so switching off mocks needs no frontend change.

---

## 5. Section A: UI and front-facing features (Person A)

Stack: Vite + React + TypeScript, `@elevenlabs/react`. Single page, three views driven by one state machine:

`brief -> planning -> build -> standup`

### A1. Brief view
- Left: **Context panel**. Linear issues (key, title, state) and last meeting card (title, date, 3-line summary). Data from `GET /api/context`.
- Right: big **"Talk to Max"** button.
- Done when: renders mock context cleanly; empty states read well if a source is missing ("No meeting notes connected").

### A2. Planning view (voice conversation)
- Voice orb with speaking/listening state, live transcript (both sides).
- **Live spec panel**: the fields of `Spec` render as a checklist that fills in during the call (driven by the `update_spec` client tool, see A5).
- "End call" button.
- Done when: transcript scrolls; spec panel updates as soon as the tool fires; mic permission error shows a clear message.

### A3. Takeover / Build view
- Top banner: "Max is driving. Press Esc to stop." Esc and a Stop button call `POST /api/kill`.
- **Live log timeline** from `GET /api/runs/:runId/stream`. One line per `log` event, newest at bottom, step tag on the left (`context`, `plan`, `codevisor`).
- **Staffing table** from the `plan` event: task, model badge, reason. Summary line: "Staffed 4 tasks: 1 Opus, 3 Sonnet."
- **Narration**: for `log` events with `speak: true`, call `POST /api/tts` and play the audio. Queue them, never overlap. Mute toggle.
- Done when: the mock run replays cleanly start to finish and reads well on a projector (large type, high contrast).

### A4. Team board + standup view
- Agent cards from `GET /api/agents`: title, model badge, status pill, detail line, "last active" label.
- Status colors: working = amber, needs_review = blue, stuck = red, done = green, error = red outline, queued = gray.
- **"Standup" button** starts a voice session (same agent) that calls `get_standup` and speaks the summary. Cards for stuck agents pulse while Max talks about them (nice to have).
- Done when: the board updates live without a refresh.

### A5. ElevenLabs agent config (A owns this)

One agent in the ElevenLabs dashboard. LLM: the strongest available in the agent settings. Voice: calm, fast, clear.

**Dynamic variable at session start:** `context_brief` = `brief` from `GET /api/context`.

**Client tools** (registered in the React app, the browser executes them):

| Tool | Params | What the browser does |
|---|---|---|
| `update_spec` | partial `Spec` | Merges into spec state, updates the live panel |
| `start_build` | full `Spec` | `POST /api/build`, switches to Build view, stores `runId` |
| `get_standup` | none | `GET /api/standup`, returns `summary` to the agent |

Plus the built-in end-call system tool.

**System prompt (starting point, tune live):**

```
You are Max, an engineering manager. Your team is a group of AI coding agents running in Codevisor.
You are talking to the founder. Be direct, warm, and fast. Short sentences. No filler.

Context you already know (from Linear and the last meeting):
{{context_brief}}

Planning mode:
1. Open by showing you know the context in one or two sentences, then ask the single most important open question.
2. Ask at most 4 questions total. Each must change what gets built: scope, approach, constraints, or definition of done.
3. Every time you learn something concrete, call update_spec with just the new fields.
4. When the spec is clear, read it back in 3 sentences and ask "Ship it?"
5. On yes: call start_build with the full spec, say "Taking over now. I'll start the agents in Codevisor.", then end the call.

Standup mode (when the user asks for a standup or status):
Call get_standup and speak the summary. Lead with what needs the user (stuck or needs review), then what is done.

Never invent progress. If a tool fails, say so in one sentence.
```

### A6. Stretch (only after A1 to A5 work end to end)
- Phone number for Max (ElevenLabs telephony).
- Click a card to see the task prompt and acceptance criteria.
- "Merge" by voice with spoken confirm (needs B's stretch endpoint).

---

## 6. Section B: Backend and setup features (Person B)

Stack: Bun + Elysia + TypeScript, port 3001, CORS open to the Vite dev server.

### B0. Setup checklist
- [ ] **Mocks written (Section 4.5) and `MOCK=1` working. Do this first: it unblocks Person A.**
- [ ] `codevisor status` to confirm the server port (default `127.0.0.1:49361`).
- [ ] `curl -s http://127.0.0.1:49361/v1/health` returns OK.
- [ ] `codevisor --help` and the session subcommand `--help` saved to `docs/codevisor-cli.md`. Find: create session (project, worktree, harness, model), send prompt, list sessions with status, JSON output flags.
- [ ] `curl -s http://127.0.0.1:49361/v1/openapi.json | jq '.paths | keys'` saved to `docs/codevisor-paths.txt` (fallback reference).
- [ ] `codevisor token` stored in `.env` as `CODEVISOR_TOKEN` (never log it, never screenshot it).
- [ ] Linear API key in `.env` as `LINEAR_API_KEY`.
- [ ] ElevenLabs API key in `.env` as `ELEVENLABS_API_KEY`, voice id as `ELEVENLABS_VOICE_ID`.
- [ ] Granola: use its MCP or API if one works. Otherwise export the last meeting to `context/meeting.md` and read the file.
- [ ] **Demo target repo** created today (small app, for example a todo app with a fake checkout page), path in `.env` as `DEMO_REPO`. Add it as a project in Codevisor.

### B1. Context service: `GET /api/context`
- Linear: fetch open issues for the team or project (limit 10), map to `Issue`.
- Meeting: Granola via MCP/API, else `context/meeting.md`.
- `brief`: one short paragraph built from both (template string is fine; an LLM summary is a stretch). Example: "Open Linear: CHK-12 checkout fails on mobile, CHK-14 no receipts, CHK-15 add tests. Last meeting (Thu): agreed on Stripe Checkout over Paddle, ship v1 this week."
- Cache the result.
- Done when: returns real data and never throws if one source is missing.

### B2. Manager run: `POST /api/build`
- Create `runs/<runId>/`, write `spec.json`.
- Spawn the headless manager:

```bash
claude -p "$(cat manager_prompt.md)\n\nRUN_DIR: runs/<runId>\nSPEC:\n$(cat runs/<runId>/spec.json)" \
  --mcp-config mcp.json \
  --model "$MANAGER_MODEL" \
  --permission-mode acceptEdits \
  --allowedTools "mcp__linear" "Read" "Write" "Bash(git:*)" \
  --output-format stream-json --verbose
```

- `MANAGER_MODEL` defaults to `opus`; set it to the strongest planner you have access to.
- Parse the stream-json lines into `RunEvent`s: tool calls become `log` events with a readable message and step tag. Mark about 1 in 3 as `speak: true` (context fetched, plan written, each agent started, done).
- Watch `runs/<runId>/plan.json`. When it appears, emit a `plan` event and start dispatch.
- Keep the child process handle so `/api/kill` can stop it.

**`mcp.json`:**
```json
{
  "mcpServers": {
    "linear": { "...": "Linear MCP config" }
  }
}
```

**`manager_prompt.md` (starting point):**
```
You are the engineering manager. You were handed a spec after a planning call with the founder.

1. Gather context: read the open Linear issues related to the spec and skim the repo at the spec's repoPath (structure, package.json, key files). Keep it brief.
2. Write RUN_DIR/plan.json matching this schema exactly: { runId, tasks: [{ id, title, prompt, acceptance, model, reason, dependsOn }] }.
   - 3 to 5 small tasks, each small enough for one coding agent to finish in a single pass.
   - model: "opus" for hard or cross-cutting work, "sonnet" for routine work.
   - Every prompt must be self-contained: goal, files to touch, acceptance criteria, and this line:
     "If you need anything from a human (keys, decisions), write BLOCKED.md explaining what and stop."
3. Stop after writing plan.json. The backend launches the agents.
4. Print one short line before every action, starting with a step tag: [context], [plan].
Never merge, push, or delete anything.
```

**Dispatch (backend, not the LLM).** When `plan.json` appears, the backend launches each task with no unmet dependencies, in this priority order:
1. **Codevisor CLI** (preferred). Fill in the exact commands from `codevisor --help` into `docs/codevisor-cli.md`. Shape:
   ```bash
   # placeholders, replace with real commands/flags from --help
   codevisor <create-session> --project "$DEMO_REPO" --worktree "agent/<taskId>" \
     --harness claude-code --model <model> --json        # -> sessionId
   codevisor <send-prompt> <sessionId> --file runs/<runId>/tasks/<taskId>.md
   ```
   Write each task's prompt to `runs/<runId>/tasks/<taskId>.md` first, so long prompts never go through shell quoting.
2. **Codevisor HTTP API** (`127.0.0.1:49361/v1`, routes from `openapi.json`) if the CLI cannot do it.
3. **`codevisor mcp`** via the manager LLM only as a last resort.

After each launch, write `runs/<runId>/sessions.json` as `{ "<taskId>": "<sessionId>" }` and emit a `log` event (`step: "codevisor"`, `speak: true`) plus an `agent` event.

- Done when: one `POST /api/build` produces a plan and real sessions visible in the Codevisor app.

### B3. Status service: `GET /api/agents`, `GET /api/standup`
- **Primary source:** the Codevisor CLI session list with JSON output, if it exists.
- **Secondary source:** Codevisor events, `GET /v1/events?since=CURSOR` (SSE), cursor from `GET /v1/events/cursor`, auth `Authorization: Bearer $CODEVISOR_TOKEN`. Map `session.updated` (and any status kinds you find) for sessions in `sessions.json` to `AgentStatus`.
- **Fallback heuristics** (always on):
  - `BLOCKED.md` exists in the session's worktree: `stuck`, detail = its first line.
  - Process ended and commits exist on the branch: `needs_review`, detail = `git diff --stat` summary.
  - Recent commit or event: `working`.
  - Long inactivity and no BLOCKED.md: `stuck`, detail = "No recent activity".
- `/api/standup`: build `summary` as speakable text. Order: stuck, needs review, working, done. Example: "Four agents. Tests is stuck: it needs a Stripe test key. Checkout is ready for your review. Dark mode is still working. Readme is done."
- Done when: a status change in Codevisor shows up on the board without a refresh.

### B4. TTS: `POST /api/tts`
- Call ElevenLabs text to speech with the low-latency model and `ELEVENLABS_VOICE_ID`. Stream `audio/mpeg` back.
- Keep the API key server side only.

### B5. Kill switch: `POST /api/kill`
- Kill the manager child process and stop dispatching. Emit a final `log` event "Stopped by user." Do not touch running Codevisor sessions.

### B6. Optional: Jev
- Only for apps with no API (Granola if it has none). Expose as an MCP tool `jev_do(instruction)` in `mcp.json`.
- Do not route Codevisor through Jev. The CLI is faster and does not break.

### B7. Stretch
- `POST /api/merge { taskId, confirmed }`: refuses unless `confirmed: true`, merges the task branch into main in `DEMO_REPO`.
- Second dependency wave: when a task finishes, launch its dependents.
- LLM-written `brief` in B1.

---

## 7. Milestones (in order, each unlocks the next)

| # | Milestone | Owner | Proof it's done |
|---|---|---|---|
| M1 | Mocks served with `MOCK=1` | B | Frontend loads all views from real endpoints with mock data |
| M2 | All four views built against mocks | A | Full mock run plays from Brief to Standup |
| M3 | Voice agent calls `update_spec` and `start_build` | A | Talking fills the spec panel, "Ship it" triggers `POST /api/build` |
| M4 | Manager writes a valid `plan.json` | B | Real spec in, schema-valid plan out |
| M5 | Dispatcher launches a real Codevisor session | B | Session appears in the Codevisor app with the task prompt |
| M6 | Live status on the board | B + A | Status changes in Codevisor show on the board and in the standup |
| M7 | Full end-to-end run with `MOCK=0` | A + B | Voice call to agents running in Codevisor, no manual steps. **Screen-record this first clean run as the backup video.** |
| M8 | Demo states staged | B | 1 done, 1 needs review, 1 stuck (BLOCKED.md), 1 working |
| M9 | Submitted | A + B | Section 8 checklist complete |

Fallback rules (tied to milestones, not the clock):
- **M3 blocked:** A drops all UI polish until `start_build` fires.
- **M5 blocked on the CLI:** switch to the HTTP API, then to `codevisor mcp`, in that order.
- **M6 blocked on events:** ship with the fallback heuristics only.
- **After M7:** feature freeze. Only demo prep and submission from here.

---

## 8. Submission checklist
- [ ] Project link (repo)
- [ ] 2-minute demo video anyone can open (include a shot of the Codevisor window with agents running)
- [ ] Partner tools used: ElevenLabs (agent + TTS), Codevisor (CLI, events API, and we built the project in Codevisor), Linear
- [ ] README with: one-liner, how it works diagram, "Built with Codevisor" stats (humans, agents, sessions, branches)

## 9. Out of scope
Auth, multi-user, real deploys, GitHub PRs, phone calling (stretch only), anything that is not in the demo flow in Section 2.
