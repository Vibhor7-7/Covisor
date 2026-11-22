// Stand-in for the real backend so the UI can be built before it exists.
// It serves the PRD section 4 contract on port 3001 with canned data.
// Run with `npm run mock`. Delete once the backend's MOCK=1 mode is live.

import { readFileSync } from "node:fs";
import http from "node:http";

const load = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
const context = load("./context.json");
const tasks = load("./plan.json").tasks;
const task = (id) => tasks.find((t) => t.id === id);

const agents = new Map();
let run = null;

const now = () => new Date().toISOString();
const log = (step, message, speak = false) => ({ type: "log", step, message, speak });
const agent = (taskId, status, detail, sessionId = `ses_${taskId}`) => ({
  type: "agent",
  agent: {
    taskId,
    sessionId,
    title: task(taskId).title,
    model: task(taskId).model,
    status,
    detail,
    lastActivityAt: now(),
  },
});

// [delay before the event in ms, event factory]
const script = [
  [600, () => log("context", "Reading the spec for Stripe checkout v1.", true)],
  [1400, () => log("context", "Pulled 3 open Linear issues: CHK-12, CHK-14, CHK-15.")],
  [1300, () => log("context", "Skimming the repo: a Vite and React todo app with a fake checkout page.")],
  [1300, () => log("context", "No payment provider is wired up yet. Tests live in src/__tests__.")],
  [1200, () => log("plan", "Context gathered. Writing the plan.", true)],
  [2200, () => log("plan", "Splitting the work into 4 tasks. Only the Stripe session is cross-cutting.")],
  [1500, () => ({ type: "plan", plan: { runId: run.id, tasks } })],
  [200, () => log("plan", "Plan written. Four tasks: one for Opus, three for Sonnet.", true)],
  [2600, () => log("codevisor", "Starting agent 1 in Codevisor: the Stripe Checkout session.", true)],
  [900, () => agent("t1", "working", "Reading the checkout page")],
  [1800, () => log("codevisor", "Starting agent 2 in Codevisor: the mobile Safari fix.", true)],
  [900, () => agent("t2", "working", "Reproducing CHK-12")],
  [1500, () => log("codevisor", "Receipts and tests wait on the Stripe session.")],
  [300, () => agent("t3", "queued", "Waiting on the Stripe session", null)],
  [300, () => agent("t4", "queued", "Waiting on the session and the mobile fix", null)],
  [1500, () => log("codevisor", "Two agents are running and two are queued behind them.", true)],
  [1200, () => ({ type: "done" })],
  // After the run, the agents keep changing so the board can be seen updating.
  [5000, () => agent("t2", "done", "+38 -12, 2 files")],
  [3000, () => agent("t4", "stuck", "Needs STRIPE_TEST_KEY")],
  [3000, () => agent("t1", "needs_review", "+212 -8, 4 files")],
  [2000, () => agent("t3", "working", "Enabling receipt emails")],
];

function emit(event) {
  const stamped = { ts: now(), ...event };
  if (stamped.type === "agent") {
    agents.set(stamped.agent.taskId, stamped.agent);
    if (run.finished) return; // staged changes after the run reach the UI by polling only
  }
  if (stamped.type === "done") run.finished = true;
  run.events.push(stamped);
  for (const send of run.listeners) send(stamped);
}

function startRun() {
  if (run) clearTimeout(run.timer);
  agents.clear();
  run = { id: `run_${Date.now().toString(36)}`, events: [], listeners: new Set(), finished: false };
  let step = 0;
  const next = () => {
    if (step === script.length) return;
    const [delay, make] = script[step];
    run.timer = setTimeout(() => {
      step += 1;
      emit(make());
      next();
    }, delay);
  };
  next();
  return run.id;
}

function standup() {
  const list = [...agents.values()];
  const say = (status, text) =>
    list.filter((a) => a.status === status).map((a) => text(a.title, a.detail));
  const lines = [
    ...say("stuck", (title, detail) => `${title} is stuck: ${detail}.`),
    ...say("needs_review", (title) => `${title} is ready for your review.`),
    ...say("working", (title) => `${title} is still working.`),
    ...say("done", (title) => `${title} is done.`),
    ...say("queued", (title) => `${title} is queued.`),
  ];
  const summary = list.length
    ? `${list.length} agents. ${lines.join(" ")}`
    : "No agents are running yet.";
  return { summary, agents: list };
}

// First and second formant of "ah", "ee", "oo", "eh" and "oh".
const VOWELS = [[800, 1200], [300, 2700], [350, 900], [500, 2000], [450, 1000]];

// A babble as long as the line would take to say: a new vowel each syllable,
// with a hiss now and then. It gives the blob the cues real speech would
// (loudness, open and front vowels, sibilants, syllable onsets).
function tone(text) {
  const rate = 16000;
  const samples = Math.round(rate * Math.min(4, Math.max(0.8, text.length * 0.055)));
  const beat = Math.round(rate * 0.24);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  let phase = 0;
  for (let i = 0; i < samples; i += 1) {
    const t = i / rate;
    const syllable = Math.floor(i / beat);
    const swell = Math.sin((Math.PI * (i % beat)) / beat) ** 0.7;
    const pitch = 125 + 25 * Math.sin(t * 2.3) + 12 * Math.sin(t * 7.1);
    phase += (2 * Math.PI * pitch) / rate;
    let voice = 0;
    if (syllable % 5 === 3) {
      voice = (Math.random() * 2 - 1) * 1.6; // "s"
    } else {
      // Harmonics of the pitch, loudest near the vowel's two formants.
      const [f1, f2] = VOWELS[(syllable * 3 + text.length) % VOWELS.length];
      for (let h = 1; h * pitch < 4000; h += 1) {
        const f = h * pitch;
        const gain = Math.exp(-(((f - f1) / 130) ** 2)) + 0.6 * Math.exp(-(((f - f2) / 220) ** 2)) + 0.04 / h;
        voice += gain * Math.sin(h * phase);
      }
    }
    const fade = Math.min(1, i / 800, (samples - i) / 800);
    wav.writeInt16LE(Math.round(voice * 2000 * swell * fade), 44 + i * 2);
  }
  return wav;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const readBody = (req) =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });

http
  .createServer(async (req, res) => {
    const json = (data, status = 200) => {
      res.writeHead(status, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const route = `${req.method} ${new URL(req.url, "http://localhost").pathname}`;

    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    if (route === "GET /api/context") return json(context);
    if (route === "GET /api/agents") return json([...agents.values()]);
    if (route === "GET /api/standup") return json(standup());
    if (route === "POST /api/build") {
      await readBody(req);
      return json({ runId: startRun() });
    }
    if (route === "POST /api/kill") {
      if (run && !run.finished) {
        clearTimeout(run.timer);
        emit(log("manager", "Stopped by user."));
        run.finished = true;
      }
      return json({ ok: true });
    }
    if (route === "POST /api/tts") {
      const { text = "" } = await readBody(req);
      res.writeHead(200, { ...cors, "Content-Type": "audio/wav" });
      return res.end(tone(text));
    }
    if (run && route === `GET /api/runs/${run.id}/stream`) {
      res.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      run.events.forEach(send);
      run.listeners.add(send);
      const listeners = run.listeners;
      return req.on("close", () => listeners.delete(send));
    }
    json({ error: `No mock for ${route}` }, 404);
  })
  .listen(3001, () => console.log("Mock backend on http://localhost:3001"));
