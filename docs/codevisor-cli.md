# Codevisor: CLI reference and the HTTP calls we use

Checked on 2026-11-22 against Codevisor server **0.1.117** on `http://127.0.0.1:49361`.
Code: `src/codevisor.ts` (client), `src/dispatch.ts` (dispatcher), `scripts/dispatch-smoke.ts` (M5 test).

## TL;DR

- The `codevisor` CLI only controls the server (serve/start/stop/status/token/logs/mcp/...). It has
  **no session subcommands**, so per the PRD fallback order the **HTTP API is our primary path**.
- One call starts an agent the way the app does: **`POST /v1/agents`** (worktree + workspace +
  session + first message, rolled back if any step fails). The session shows in the Codevisor
  sidebar as its own item.
- Model is chosen per session: `model` on `POST /v1/agents`, or `configSelections.model` on
  `POST /v1/sessions`, or later `POST /v1/sessions/{id}/config`.
- Demo repo project id: **`1c98c2c9-5ba9-4574-9ff5-305e9c26384a`** (`covisor-demo`, folder
  `/Users/sharvibhor/Desktop/Projects/covisor-demo`).

## B0 checks

```
$ codevisor status
Codevisor server 0.1.117 is running on port 49361
  platform:  darwin/arm64
  harnesses:
    claude-code: ready 2.1.330
    codex: ready 0.155.1
    (pi, opencode, gemini, cursor, ... unavailable: CLI not found on PATH)

$ curl -s http://127.0.0.1:49361/v1/health
{"ok":true,"version":"0.1.117","database":"ready","git":"ready", ...}
```

`codevisor token` prints the API token. It lives in `.env` as `CODEVISOR_TOKEN`. Never print it;
in shell use it inline: `curl -H "Authorization: Bearer $(codevisor token)" ...`.
Every `/v1` call except `/v1/health` needs `Authorization: Bearer <token>`.

## CLI help

```
$ codevisor --help
DESCRIPTION
  Control the Codevisor server on this machine

USAGE
  codevisor <subcommand> [flags]

GLOBAL FLAGS
  --help, -h                                                          Show help information
  --version, -v                                                       Show version information
  --completions <bash|zsh|fish|sh>                                    Print shell completion script (choices: bash, zsh, fish, sh)
  --log-level <all|trace|debug|info|warn|warning|error|fatal|none>    Sets the minimum log level (choices: all, trace, debug, info, warn, warning, error, fatal, none)

SUBCOMMANDS
  serve       Run the Codevisor server in the foreground
  setup       Onboard this machine: start the server and sign it into Codevisor Cloud
  auth        Connect this machine to a Codevisor Cloud account
  machines    Add, list, and remove the machines on your Codevisor account
  flags       Turn experimental features on or off; the Codevisor apps sync them to your other machines
  start       Start the Codevisor server (systemd unit or background process)
  stop        Stop the Codevisor server
  restart     Restart the Codevisor server
  status      Show server status, machine manifest, and harness readiness
  token       Print this machine's API connection token for scripts (stable until rotated)
  mcp         Serve this machine's Codevisor tools (agents, bots, browser, plugins, skills) to an MCP client over stdio
  update      Update the Codevisor server to the latest release
  logs        Show server logs (journalctl or the log file)
```

Relevant subcommands (global flags omitted, they are the same as above):

```
$ codevisor status --help
  Show server status, machine manifest, and harness readiness
  codevisor status [flags]
  --port integer    Server port (defaults to CODEVISOR_PORT, the systemd unit, the port the server last used, or 49361)
  --json            Print machine-readable JSON

$ codevisor token --help
  Print this machine's API connection token for scripts (stable until rotated)
  codevisor token [flags]
  --port integer    Server port (defaults to CODEVISOR_PORT, ...)
  --rotate          Replace the token; scripts using the old one must be updated

$ codevisor mcp --help
  Serve this machine's Codevisor tools (agents, bots, browser, plugins, skills) to an MCP client over stdio
  codevisor mcp [flags]
  --port integer      Server port (defaults to CODEVISOR_PORT, ...)
  --project string    A project name or id: its plugins and skills join the tools, and agents.start defaults to it

$ codevisor logs --help
  Show server logs (journalctl or the log file)
  codevisor logs [flags]
  --follow, -f    Keep streaming new log lines

$ codevisor serve --help
  Run the Codevisor server in the foreground
  --host string  --port string  --preferred-port string  --serverId string  --auth string (none|token)
  --kind string  --direct-path string  --name string  --db string  --upgrade-status string
  --boot-id string  --app-owned string  --owner-pid string  --version string

$ codevisor start|stop|restart|setup --help      -> only --port
$ codevisor update --help                         -> --port, --alpha
$ codevisor auth|machines|flags --help            -> account/machine/feature-flag management only
```

There is no `--json` session listing in the CLI. `codevisor mcp` exposes two MCP tools, `execute`
(sandboxed TypeScript with `agents.start`, `agents.list`, ...) and `skills` (how-to guides).
`agents.start` there is the same operation as `POST /v1/agents` below; it is our last resort only.

## How we create sessions and send prompts: the exact HTTP calls

Base URL `http://127.0.0.1:49361`, header `Authorization: Bearer <CODEVISOR_TOKEN>`,
`content-type: application/json`. The full spec is at `GET /v1/openapi.json` (about 600 KB, query
it with `jq`); the route list is in `docs/codevisor-paths.txt`.

### 1. Find or register the project (idempotent)

```
GET /v1/projects
-> 200 [ { "id", "name", "origin", "createdAt",
           "locations": [ { "id", "projectId", "serverId", "folderPath", "isGitRepository" } ],
           "isBot"?, ... } ]
```

Match `locations[].folderPath` **exactly** (realpath, no trailing slash). There is a project
`Projects` at the parent folder `/Users/sharvibhor/Desktop/Projects`, so a prefix match is wrong.
If none matches:

```
POST /v1/projects
{ "folderPath": "/Users/sharvibhor/Desktop/Projects/covisor-demo", "name": "covisor-demo" }
-> 201 { "id": "1c98c2c9-5ba9-4574-9ff5-305e9c26384a", "name": "covisor-demo", "origin": "codevisor",
         "locations": [ { "folderPath": "/Users/sharvibhor/Desktop/Projects/covisor-demo",
                          "isGitRepository": true, ... } ], ... }
```

This also makes the project show in the Codevisor app. `ensureProject()` in `src/codevisor.ts`.

### 2. Start an agent: worktree + session + first prompt in one call (primary)

```
POST /v1/agents
{
  "title": "Add Built with Codevisor line",
  "prompt": "<contents of runs/<runId>/tasks/<taskId>.md>",
  "checkout": "worktree",              // new git worktree on a new branch
  "standalone": true,                  // own workspace = own item in the Codevisor sidebar
  "harness": "claude-code",
  "model": "claude-sonnet-5-5",        // see "Choosing the model"
  "project": "1c98c2c9-5ba9-4574-9ff5-305e9c26384a",   // project id (a name also works)
  "labels": { "covisorRun": "<runId>", "covisorTask": "t1", "covisorModel": "sonnet" }
}
-> 200 { "agentId": "7e704374-6b81-4c34-ba9f-c75b49121c87",   // == session id (took ~0.6 s)
         "title": "...", "projectId": "...", "workspaceId": "d61b4b6e-...",
         "worktreeName": "compote", "delivered": "...", "subscribed": false }
```

- `agentId` **is the session id** (works with every `/v1/sessions/{id}` route).
- `checkout` options: `worktree` | `project` (project folder, no branch) | `shared` | `none`.
- The worktree name is picked by Codevisor (a random word, e.g. `compote`); the branch is
  `codevisor/<worktreeName>`; the folder is
  `~/codevisor/worktrees.noindex/<projectId>/<worktreeName>`. Worktrees branch from the current
  `main` HEAD of the project.
- If any step fails, Codevisor removes what the call created and returns the error.
- The dispatcher then reads `GET /v1/sessions/{id}` (`cwd`, `worktreeName`, `workspaceId`) and
  `GET /v1/projects/{id}/worktrees` (`branch`, `path`) and writes them to
  `runs/<runId>/launches.json`.

### 3. Alternative: explicit worktree, session, prompt (fallback, names the branch)

Used when `POST /v1/agents` returns an HTTP error, or always with `CODEVISOR_LAUNCH=sessions`.
**Caveat:** a session made this way gets **no workspace**, so it does not appear in the app's
workspace snapshot and probably not in the sidebar. It runs and works fine otherwise.

```
POST /v1/projects/{projectId}/worktrees
{ "name": "agent-t1-c3cg" }                       // "/" in the name is rejected
-> 201 { "id", "projectId", "serverId", "name": "agent-t1-c3cg",
         "branch": "codevisor/agent-t1-c3cg",
         "path": "/Users/sharvibhor/codevisor/worktrees.noindex/<projectId>/agent-t1-c3cg", "createdAt" }

POST /v1/sessions
{ "projectId": "<projectId>", "harnessId": "claude-code", "title": "Add Built with Codevisor line",
  "worktreeName": "agent-t1-c3cg", "configSelections": { "model": "claude-sonnet-5-5" },
  "labels": { "covisorRun": "<runId>", "covisorTask": "t1" }, "createdBy": "user" }
-> 201 { "id": "e343f04b-...", "cwd": "<worktree path>", "worktreeName": "agent-t1-c3cg",
         "configSelections": { "model": "claude-sonnet-5-5" }, "sidebarState": ..., ... }
   (required: projectId, harnessId; optional: workspaceId, deferAgentSession, ...)

POST /v1/sessions/{sessionId}/prompt
{ "text": "<task markdown>" }                    // optional "delivery": "steer" | "queue"
-> 202 { "accepted": true, "sessionId": "...", "delivered": "sent" | "steered" | "queued" | null }
```

`POST /v1/sessions/{id}/prompt` is also how to send any later message to a running session.

### Choosing the model

There is no harness-level model list. A session's options arrive in `GET /v1/sessions/{id}` under
`stateUpdates[]` with `sessionUpdate: "config_option_update"`. For `claude-code`:

| configId | values |
|---|---|
| `model` | `claude-opus-5-5` (Opus 5.5), `claude-fable-5-2` (Fable 5.2), `claude-sonnet-5-5` (Sonnet 5.5), `claude-haiku-5-5` (Haiku 5.5) |
| `effort` | `low`, `medium` (default), `high`, `xhigh`, `max` |
| `speed` | `standard`, `fast` |

Set it at creation (`model` on `POST /v1/agents`, `configSelections: { "model": ... }` on
`POST /v1/sessions`) or later with `POST /v1/sessions/{id}/config { "configId": "model", "value": "claude-opus-5-5" }`.

Plan model mapping in `src/codevisor.ts` (`MODEL_IDS`): `opus` -> `claude-opus-5-5`,
`sonnet` -> `claude-sonnet-5-5`, `local` -> `claude-sonnet-5-5` (no local harness is ready here).
Override with `CODEVISOR_MODEL_OPUS`, `CODEVISOR_MODEL_SONNET`, `CODEVISOR_MODEL_LOCAL`.

### Reading status (for B3)

```
GET /v1/sessions                 -> Session[]  (light: no transcript)
GET /v1/sessions/{id}            -> { session, conversation[], items[], stateUpdates[], promptQueue[], eventCursor, ... }
GET /v1/agents?project=<id>&label=covisorRun=<runId>   -> { items: [ { agentId, title, state, worktreeName, workspaceId, labels, standalone, updatedAt } ] }
GET /v1/agents/{id}              -> { agentId, title, state, lastReply, pendingQuestion }
POST /v1/agents/wait  { "agentIds": [...], "until": ["idle","waitingForUser","errored"], "timeoutMs": 30000 }
POST /v1/sessions/wait { "ids": [...], "until": ["idle","inProgress","waitingForUser","unread","errored"] }
GET /v1/workspace-snapshot       -> { workspaces[], checkouts[], panes[] }   (what the app shows)
GET /v1/events/cursor, GET /v1/events?since=CURSOR (SSE)
```

Status fields and values:

- `session.sidebarState`: `idle` | `inProgress` | `waitingForUser` | `unread` | `errored`.
  Observed on the smoke runs: `inProgress` right after the prompt, then `unread` when the turn
  ended with a reply nobody has read yet (it becomes `idle` once read).
- `session.actionRequired` (bool) + `actionRequiredKind`: `question` | `approval` | `planApproval`;
  `pendingPlanApproval`, `hasUnreadError`, `unreadCount`, `sidebarStateChangedAt`, `updatedAt`.
- `GET /v1/agents/{id}`: `state` is `working` | `waitingForUser` | `idle` | `errored`
  (observed `idle` while `sidebarState` was `unread`); `lastReply` is the agent's full last
  message; `pendingQuestion` is set while `waitingForUser`.
- Codevisor renames the session after its first turn (e.g. "Add Built with Codevisor line" became
  "README Built with Codevisor line"). Use the plan title, not the session title.

### Other gotchas

- Unknown session id: `GET /v1/sessions/{id}` returns **HTTP 500** `{"error":"Session not found: <id>"}`, not 404.
- `POST /v1/agents/{id}/detach` returns 422 for an agent no other agent started ("already stands alone").
- Sessions run `claude-code` with `bypassPermissions`, so agents never stop for tool approvals.
- There is no route to delete a worktree; archiving an agent (`POST /v1/agents/{id}/archive`)
  reclaims its worktree and releases the branch name.

## Dispatcher behaviour (src/dispatch.ts)

`dispatchPlan(runId, plan)`:

1. Emits an `agent` event with status `queued` for every task (detail "Waiting to start" or
   "Waiting on t1, t2"), and writes `runs/<runId>/tasks/<taskId>.md` (prompt, acceptance
   criteria, ground rules: commit on the current branch, never push/merge, the BLOCKED.md line).
2. `ensureProject(DEMO_REPO)` (falls back to `spec.json` `repoPath` if `DEMO_REPO` is empty).
3. For each task with no unmet `dependsOn`, in plan order: `POST /v1/agents` (fallback: explicit
   path), then writes `runs/<runId>/sessions.json` (`{ "<taskId>": "<sessionId>" }`) and
   `runs/<runId>/launches.json` (worktree name, branch, path, workspace, model id), and emits a
   `log` (`step: "codevisor"`, `speak: true`, "Started agent 1 in Codevisor: <title>, on Sonnet.")
   plus an `agent` event (`status: "working"`, `sessionId`, `detail: "Starting"`).
4. A failed launch emits a `log` and an `agent` event with status `error` and continues.
5. Ends with a "Dispatch finished: N started, ..." log. It never emits `done`; the caller does.

`stopDispatch()` stops any launches not yet started. It never touches running sessions.
Dependents stay `queued` (the second wave is a stretch goal; `launchTask()` is exported for it).

## Test

```
bun scripts/dispatch-smoke.ts                 # creates ONE real session; don't loop it
bun scripts/dispatch-smoke.ts --verify <id>   # read-only re-check of an existing session
```

Smoke result (2026-11-22): session `7e704374-6b81-4c34-ba9f-c75b49121c87` in project
`covisor-demo`, workspace `d61b4b6e-b2f4-4e9f-850b-e4cacddad11c` with a chat pane, worktree
`compote` (branch `codevisor/compote`), model `claude-sonnet-5-5`. It went `inProgress` ->
`unread` in about 6 s and committed `bf06800 Add Built with Codevisor line to README` on its branch.
