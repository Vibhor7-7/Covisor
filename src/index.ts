// HTTP entry point. Thin: every route delegates to a module (or to src/mock.ts when MOCK=1).
// Owned by the lead; module owners should not need to edit this file.
import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { config } from "./config";
import type { RunEvent, Spec } from "./types";
import { streamRun } from "./runs";
import { getContext } from "./context";
import { startBuild, killRun } from "./manager";
import { getAgents, getStandup } from "./status";
import { synthesize } from "./tts";
import { jevSnapshot } from "./jev";
import * as mock from "./mock";

class BadRequest extends Error {}

function sse(events: AsyncIterable<RunEvent>, signal?: AbortSignal): Response {
  const enc = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      keepalive = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: keepalive\n\n`));
        } catch {
          clearInterval(keepalive);
        }
      }, 15_000);
      try {
        for await (const e of events) {
          if (signal?.aborted) break;
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const e: RunEvent = { type: "error", ts: new Date().toISOString(), message: msg };
        controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      } finally {
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      clearInterval(keepalive);
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

const m = config.mock;

export const app = new Elysia()
  .use(cors())
  .onError(({ code, error, set }) => {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof BadRequest || code === "PARSE" || code === "VALIDATION") set.status = 400;
    else if (code === "NOT_FOUND") set.status = 404;
    else set.status = 500;
    console.error(`[api] ${set.status}:`, message);
    return { error: message };
  })
  // Handlers are `async` on purpose: Elysia only routes rejected promises through onError
  // when the handler itself is async (otherwise Bun returns an HTML 500 page).
  .get("/api/health", async () => ({ ok: true, mock: m }))
  .get("/api/context", async () => (m ? await mock.mockContext() : await getContext()))
  .post("/api/build", async ({ body }) => {
    const spec = (body as { spec?: Spec } | undefined)?.spec;
    if (!spec || typeof spec !== "object") throw new BadRequest("Body must be { spec: Spec }");
    return m ? await mock.mockStartBuild(spec) : await startBuild(spec);
  })
  .get("/api/runs/:runId/stream", ({ params, request }) =>
    sse(m ? mock.mockRunEvents(params.runId) : streamRun(params.runId), request.signal),
  )
  .get("/api/agents", async () => (m ? await mock.mockAgents() : await getAgents()))
  // Jev's latest judgment per agent (probabilities, what it changed and why). Not part of the PRD contract.
  .get("/api/agents/judgments", async () => jevSnapshot())
  .get("/api/standup", async () => (m ? await mock.mockStandup() : await getStandup()))
  .post("/api/tts", async ({ body }) => await synthesize((body as { text?: string } | undefined)?.text ?? ""))
  .post("/api/kill", async () => (m ? mock.mockKill() : killRun()));

if (import.meta.main) {
  app.listen(config.port);
  console.log(`[api] listening on http://localhost:${config.port} (MOCK=${m ? 1 : 0})`);
}
