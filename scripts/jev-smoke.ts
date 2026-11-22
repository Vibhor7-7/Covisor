// Jev smoke test.
//   bun scripts/jev-smoke.ts           offline: policy, request shape, cache, retries, and the status.ts
//                                      integration against a fake TypeSafe server (real Codevisor read-only)
//   bun scripts/jev-smoke.ts --live    also asks the real Jev about 5 realistic agent turns
//                                      (needs TYPESAFE_API_KEY in .env; costs a few thousand input tokens)
import {
  applyJudgment,
  buildRequest,
  candidateSentences,
  judge,
  jevSnapshot,
  resetJev,
  toDetail,
  type JevEvidence,
  type JevJudgment,
} from "../src/jev";
import { getAgents } from "../src/status";

const live = process.argv.includes("--live");
const realKey = process.env.TYPESAFE_API_KEY ?? "";
let failures = 0;
function check(name: string, ok: boolean, info?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && info !== undefined ? `\n     ${JSON.stringify(info)}` : ""}`);
}

// ---------------------------------------------------------------------------------------------
// Realistic agent turns
// ---------------------------------------------------------------------------------------------

const STUCK_MSG = `I wired up \`src/payments.ts\` to call Stripe test mode and wrote \`src/checkout.test.ts\` with four cases.

The tests can't run yet: \`STRIPE_TEST_KEY\` is not set in this worktree, and CLAUDE.md says not to fake it.
I need a Stripe test secret key (sk_test_...) in \`.env\` to run the checkout tests against Stripe test mode.
I wrote BLOCKED.md and stopped.`;

const DONE_MSG = `I fixed the checkout layout on narrow screens (CHK-12). The two-column grid now stacks below 640px, the card inputs use percentage widths, and I removed the overflow-x: hidden hack.
I checked it at 375px: the Pay button is visible and the page no longer scrolls sideways. \`bun test\` passes (11 tests).
Committed as "CHK-12: stack checkout on small screens". Ready for review.`;

const FAILED_MSG = `I added the receipt email stub in src/checkout.ts and a test for it.
Two existing cart tests now fail with "expected 1080 to equal 1081" after my rounding change, and I couldn't work out which rounding rule the totals are supposed to follow.
I left the change uncommitted.`;

const NOCHANGE_MSG = `I looked into dark mode. The site already defines every colour as a CSS variable on :root, so the only work is a prefers-color-scheme block, and that block already exists at the end of web/styles.css on this branch. No code changes were needed.`;

const BLOCKED_NOTE = `# BLOCKED

Needs STRIPE_TEST_KEY to run the checkout tests against Stripe test mode.

Add a Stripe test secret key to .env as STRIPE_TEST_KEY=sk_test_... and re-run \`bun test\`.`;

function ev(over: Partial<JevEvidence>): JevEvidence {
  return {
    taskId: "t4",
    taskTitle: "Add checkout tests (CHK-15)",
    acceptance: ["src/checkout.test.ts covers a paid order and a declined card", "bun test passes"],
    lastMessage: "",
    blockedNote: "",
    commitsAhead: 0,
    diffStat: null,
    uncommittedFiles: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// 1. Pure functions
// ---------------------------------------------------------------------------------------------

const cands = candidateSentences(BLOCKED_NOTE, STUCK_MSG);
check("candidates: headings and short lines dropped", !cands.some((c) => /^#|^BLOCKED$/.test(c)), cands);
check(
  "candidates: the key sentence is a candidate, backticks stripped",
  cands.includes("I need a Stripe test secret key (sk_test_...) in .env to run the checkout tests against Stripe test mode."),
  cands,
);
check("candidates: duplicates removed", new Set(cands.map((c) => c.toLowerCase())).size === cands.length);

const req = buildRequest(ev({ lastMessage: STUCK_MSG, blockedNote: BLOCKED_NOTE }), cands);
const qs = req.questions as Record<string, { type: string; criteria?: Record<string, string> }>;
check("request: model + object state + 4 questions", typeof req.model === "string" && Object.keys(qs).length === 4);
check("request: needs_human is a noul with true/false criteria", qs.needs_human?.type === "noul" && !!qs.needs_human.criteria?.true);
check(
  "request: choice criteria within 1..255 options, include none",
  ["outcome", "blocker_sentence", "summary_sentence"].every((k) => {
    const n = Object.keys(qs[k]?.criteria ?? {}).length;
    return qs[k]?.type === "choice" && n >= 1 && n <= 255;
  }) && "none" in (qs.blocker_sentence?.criteria ?? {}),
);
check("request: no sentence questions without candidates", !("blocker_sentence" in buildRequest(ev({}), []).questions));

const detailCases: Array<[string, string]> = [
  ["I need a Stripe test secret key in .env to run the tests.", "Needs a Stripe test secret key in .env to run the tests"],
  ["I'm missing STRIPE_TEST_KEY.", "Missing STRIPE_TEST_KEY"],
  ["I couldn't work out which rounding rule the totals follow.", "Couldn't work out which rounding rule the totals follow"],
  ["I am blocked on a decision about refunds.", "Blocked on a decision about refunds"],
  ["STRIPE_TEST_KEY is not set in this worktree.", "STRIPE_TEST_KEY is not set in this worktree"],
  ["I wrote BLOCKED.md and stopped.", "Says: I wrote BLOCKED.md and stopped"],
];
for (const [inp, want] of detailCases) check(`toDetail: ${inp}`, toDetail(inp) === want, toDetail(inp));

function J(over: Partial<JevJudgment>): JevJudgment {
  return {
    model: "jev-test",
    needsHuman: 0.05,
    outcome: "finished",
    outcomeConfidence: 0.9,
    outcomeProbabilities: {},
    blockerSentence: null,
    blockerConfidence: 0,
    summarySentence: null,
    summaryConfidence: 0,
    inputTokens: 0,
    latencyMs: 0,
    at: new Date().toISOString(),
    ...over,
  };
}
const review = { status: "needs_review" as const, detail: "+120 -4, 3 files" };
const noChange = { status: "stuck" as const, detail: "Finished with no changes" };
const keySentence = "I need a Stripe test secret key in .env to run the checkout tests.";
const policy: Array<[string, ReturnType<typeof applyJudgment>, string, string | RegExp]> = [
  [
    "needs_human 0.95 turns needs_review into stuck with the agent's sentence",
    applyJudgment(review, J({ needsHuman: 0.95, outcome: "blocked_on_person", blockerSentence: keySentence, blockerConfidence: 0.8 }), { basis: "turn_ended", hasChanges: true }),
    "stuck",
    "Needs a Stripe test secret key in .env to run the checkout tests",
  ],
  ["needs_human 0.5 keeps the code rule", applyJudgment(review, J({ needsHuman: 0.5 }), { basis: "turn_ended", hasChanges: true }), "needs_review", review.detail],
  ["finished with commits keeps the diff stat", applyJudgment(review, J({}), { basis: "turn_ended", hasChanges: true }), "needs_review", review.detail],
  [
    "no_change_needed with no changes becomes needs_review",
    applyJudgment(noChange, J({ outcome: "no_change_needed", summarySentence: "No code changes were needed.", summaryConfidence: 0.7 }), { basis: "turn_ended", hasChanges: false }),
    "needs_review",
    "No code changes were needed",
  ],
  [
    "failed becomes stuck with the reason",
    applyJudgment(review, J({ outcome: "failed", blockerSentence: "Two existing cart tests now fail after my rounding change.", blockerConfidence: 0.6 }), { basis: "turn_ended", hasChanges: true }),
    "stuck",
    /^Two existing cart tests now fail/,
  ],
  ["low outcome confidence keeps the code rule", applyJudgment(noChange, J({ outcomeConfidence: 0.4 }), { basis: "turn_ended", hasChanges: false }), "stuck", noChange.detail],
  [
    "BLOCKED.md stays stuck even if Jev says no human needed",
    applyJudgment({ status: "stuck", detail: "Blocked" }, J({ needsHuman: 0.1, blockerSentence: "Needs STRIPE_TEST_KEY to run the checkout tests.", blockerConfidence: 0.9 }), { basis: "blocked_file", hasChanges: false }),
    "stuck",
    "Needs STRIPE_TEST_KEY to run the checkout tests",
  ],
  [
    "blocker sentence below confidence 0.4 is ignored",
    applyJudgment(review, J({ needsHuman: 0.9, blockerSentence: keySentence, blockerConfidence: 0.2 }), { basis: "turn_ended", hasChanges: true }),
    "stuck",
    "Needs something from you",
  ],
];
for (const [name, got, status, detail] of policy) {
  const ok = got.status === status && (typeof detail === "string" ? got.detail === detail : detail.test(got.detail));
  check(`policy: ${name}`, ok, got);
}


// ---------------------------------------------------------------------------------------------
// 2. Live Jev (optional, runs first so nothing below can disable it)
// ---------------------------------------------------------------------------------------------

if (live) {
  if (!realKey) {
    console.log("\n--live skipped: TYPESAFE_API_KEY is not set in .env");
  } else {
    const cases: Array<[string, JevEvidence, string]> = [
      ["stuck on Stripe key (reply + BLOCKED.md)", ev({ lastMessage: STUCK_MSG, blockedNote: BLOCKED_NOTE, commitsAhead: 1, diffStat: "+64 -0, 1 file" }), "stuck"],
      ["finished mobile fix", ev({ taskId: "t2", taskTitle: "Fix checkout on mobile (CHK-12)", lastMessage: DONE_MSG, commitsAhead: 1, diffStat: "+31 -12, 1 file" }), "needs_review"],
      ["failed on rounding tests", ev({ taskId: "t3", taskTitle: "Email receipts (CHK-14)", lastMessage: FAILED_MSG, uncommittedFiles: 2 }), "stuck"],
      ["no change needed", ev({ taskId: "t5", taskTitle: "Dark mode", lastMessage: NOCHANGE_MSG }), "needs_review"],
      ["BLOCKED.md only", ev({ taskId: "t6", blockedNote: BLOCKED_NOTE }), "stuck"],
    ];
    console.log("\nLive Jev:");
    for (const [name, e, want] of cases) {
      const j = await judge(e, 20_000);
      if (!j) {
        check(`live: ${name}`, false, jevSnapshot().lastError);
        continue;
      }
      const hasChanges = e.commitsAhead > 0 || e.uncommittedFiles > 0;
      const basis = !e.lastMessage && e.blockedNote ? ("blocked_file" as const) : ("turn_ended" as const);
      const rule =
        basis === "blocked_file"
          ? { status: "stuck" as const, detail: "Blocked" }
          : hasChanges
            ? { status: "needs_review" as const, detail: e.diffStat ?? "uncommitted changes" }
            : { status: "stuck" as const, detail: "Finished with no changes" };
      const got = applyJudgment(rule, j, { basis, hasChanges });
      console.log(
        `     needs_human=${j.needsHuman.toFixed(2)} outcome=${j.outcome}(${j.outcomeConfidence.toFixed(2)}) ` +
          `blocker=${JSON.stringify(j.blockerSentence)} (${j.blockerConfidence.toFixed(2)}) ` +
          `summary=${JSON.stringify(j.summarySentence)} (${j.summaryConfidence.toFixed(2)}) | ${j.model} ${j.latencyMs}ms ${j.inputTokens} tok`,
      );
      check(`live: ${name} -> ${got.status} "${got.detail}"`, got.status === want, { want, why: got.why });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 3. judge() and the status.ts integration against a fake TypeSafe server
// ---------------------------------------------------------------------------------------------

type Mode = "stuck" | "fine" | "429once" | "401";
let mode: Mode = "stuck";
let hits = 0;
let lastBody: any = null;
let sent429 = false;
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    hits++;
    if (new URL(req.url).pathname !== "/v1/systemone" || req.method !== "POST") return new Response("nope", { status: 404 });
    if (req.headers.get("authorization") !== "Bearer fake-key" || mode === "401") {
      return new Response('{"detail":"Invalid API key"}', { status: 401 });
    }
    if (mode === "429once" && !sent429) {
      sent429 = true;
      return new Response('{"detail":"slow down"}', { status: 429, headers: { "retry-after": "0" } });
    }
    const body = (lastBody = await req.json());
    if (typeof body.model !== "string" || typeof body.state !== "object" || !body.questions) {
      return new Response('{"detail":[{"msg":"bad shape"}]}', { status: 422 });
    }
    const opts = Object.entries<string>(body.questions.blocker_sentence?.criteria ?? {});
    const find = (re: RegExp) => opts.find(([k, v]) => k !== "none" && re.test(v))?.[0] ?? "none";
    const stuck = mode !== "fine";
    const answers: Record<string, unknown> = {
      needs_human: { type: "noul", noul: stuck ? 0.96 : 0.03 },
      outcome: {
        type: "choice",
        choice: stuck ? "blocked_on_person" : "finished",
        confidence: 0.9,
        probabilities: stuck ? { blocked_on_person: 0.93, finished: 0.03 } : { finished: 0.94, blocked_on_person: 0.01 },
      },
    };
    if (opts.length) {
      answers.blocker_sentence = { type: "choice", choice: stuck ? find(/need|key|missing/i) : "none", confidence: 0.82, probabilities: {} };
      answers.summary_sentence = { type: "choice", choice: find(/added|fixed|committed/i), confidence: 0.7, probabilities: {} };
    }
    await Bun.sleep(30);
    return Response.json({ model: "jev-fake-1.0", answers, usage: { input_tokens: 512, output_tokens: 20 } });
  },
});
resetJev();
process.env.TYPESAFE_URL = `http://127.0.0.1:${fake.port}`;
process.env.TYPESAFE_API_KEY = "fake-key";

const e1 = ev({ lastMessage: STUCK_MSG, blockedNote: BLOCKED_NOTE });
const j1 = await judge(e1, 3000);
check("judge: fake server answers and parses", j1?.needsHuman === 0.96 && j1.outcome === "blocked_on_person", j1);
check("judge: blocker sentence maps back to the agent's own text", /STRIPE_TEST_KEY/.test(j1?.blockerSentence ?? ""), j1?.blockerSentence);
check("judge: state carries the agent's words", lastBody?.state?.agent?.last_message?.includes("STRIPE_TEST_KEY") === true);
const before = hits;
const j2 = await judge(e1, 3000);
check("judge: second call is served from cache", hits === before && j2 === j1);
check("judge: no evidence, no request", (await judge(ev({ taskId: "t9" }), 1000)) === null && hits === before);
const slow = await judge(ev({ taskId: "t8", lastMessage: DONE_MSG + " (slow)" }), 1);
check("judge: waitMs=1 returns null now, fills the cache for the next poll", slow === null);
await Bun.sleep(150);
check("judge: ...and the next poll gets it", (await judge(ev({ taskId: "t8", lastMessage: DONE_MSG + " (slow)" }), 0)) !== null);

// Integration: the real status.ts on the dispatcher's real run (Codevisor read-only), fake Jev.
const runId = process.env.JEV_SMOKE_RUN_ID || "run_20261122175428_hiyf";
process.env.STATUS_RUN_ID = runId;
process.env.STATUS_EVENTS = "0";
mode = "fine";
let agents = await getAgents({ jevWaitMs: 4000 });
let t1 = agents.find((a) => a.taskId === "t1");
const reply = lastBody?.state?.agent?.last_message ?? "";
check(`integration (${runId}): the session's real lastReply reached Jev`, /Built with Codevisor/.test(reply), reply.slice(0, 120));
check("integration: confident 'finished' keeps needs_review and the diff stat", t1?.status === "needs_review" && /\+\d+ -\d+/.test(t1.detail), t1);
check("integration: judgment recorded for /api/agents/judgments", jevSnapshot().judgments.some((r) => r.taskId === "t1" && r.changedBy === null));
mode = "stuck";
resetJev();
agents = await getAgents({ jevWaitMs: 4000 });
t1 = agents.find((a) => a.taskId === "t1");
check("integration: confident 'needs a person' flips the card to stuck", t1?.status === "stuck", t1);
const rec = jevSnapshot().judgments.find((r) => r.taskId === "t1");
check("integration: the change is attributed to Jev with the rule's decision kept", rec?.changedBy === "jev" && rec.rule.status === "needs_review", rec);

// Failure handling.
resetJev();
mode = "429once";
check("judge: retries once on 429", (await judge(ev({ taskId: "t2", lastMessage: DONE_MSG }), 4000)) !== null && sent429);
mode = "401";
const bad = await judge(ev({ taskId: "t3", lastMessage: FAILED_MSG }), 3000);
check("judge: 401 gives null and pauses Jev", bad === null && jevSnapshot().enabled === false && /401/.test(jevSnapshot().lastError ?? ""));
const fallback = await getAgents({ jevWaitMs: 1000 });
check("integration: with Jev paused, the board falls back to the code rule", fallback.find((a) => a.taskId === "t1")?.status === "needs_review");

fake.stop(true);
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
