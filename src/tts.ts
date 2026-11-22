// OWNER: context agent (B4). POST /api/tts -> ElevenLabs streaming TTS, audio/mpeg passed straight through.
//
// API: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=mp3_44100_128
//      headers xi-api-key, Content-Type: application/json; body { text, model_id }.
// Env: ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID (optional, default George, ElevenLabs' default voice),
//      ELEVENLABS_MODEL_ID (optional, default eleven_flash_v2_5, the low-latency model).
//
// Error contract for the frontend (JSON body { error, code, ... }):
//   503 code "tts_not_configured"  API key missing. 503 is used for nothing else.
//   400 code "tts_bad_request"     empty or too long text.
//   4xx code "tts_upstream_error"  ElevenLabs rejected the request; its status and message passed through.
//   502 code "tts_upstream_error"  ElevenLabs 5xx, or unreachable / timed out.
import { config } from "./config";

const API = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_MODEL = "eleven_flash_v2_5";
// ElevenLabs' default voice ("George"). It is a premade voice, so it works on the free plan;
// library voices return 402 there. Set ELEVENLABS_VOICE_ID to use another voice.
const DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";
const OUTPUT_FORMAT = "mp3_44100_128"; // MP3 -> audio/mpeg
const MAX_CHARS = 5_000; // narration lines are short; guard against burning credits
const HEADERS_TIMEOUT_MS = 10_000; // only until the stream starts, never mid-stream

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** ElevenLabs errors look like { detail: { status, message } } or a 422 { detail: [{ msg }] }. */
function upstreamMessage(raw: string): string {
  try {
    const body = JSON.parse(raw) as { detail?: unknown; message?: unknown };
    const d = body.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) return d.map((e) => (e as { msg?: string })?.msg ?? JSON.stringify(e)).join("; ");
    if (d && typeof d === "object") {
      const o = d as { message?: string; status?: string };
      if (o.message) return o.status ? `${o.status}: ${o.message}` : o.message;
    }
    if (typeof body.message === "string") return body.message;
  } catch {}
  return raw.slice(0, 300) || "no error body";
}

export async function synthesize(text: string): Promise<Response> {
  const apiKey = config.elevenLabsApiKey.trim();
  const voiceId = config.elevenLabsVoiceId.trim() || DEFAULT_VOICE;
  if (!apiKey) {
    console.log(`[tts] skipped: ELEVENLABS_API_KEY not set`);
    return json(503, {
      error: "TTS not configured: set ELEVENLABS_API_KEY in .env",
      code: "tts_not_configured",
      missing: ["ELEVENLABS_API_KEY"],
    });
  }

  const input = typeof text === "string" ? text.trim() : "";
  if (!input) return json(400, { error: "Body must be { text: string } with non-empty text", code: "tts_bad_request" });
  if (input.length > MAX_CHARS) {
    return json(400, { error: `Text too long (${input.length} chars, max ${MAX_CHARS})`, code: "tts_bad_request" });
  }

  const model = (process.env.ELEVENLABS_MODEL_ID ?? "").trim() || DEFAULT_MODEL;
  const url = `${API}/${encodeURIComponent(voiceId)}/stream?output_format=${OUTPUT_FORMAT}`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), HEADERS_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text: input, model_id: model }),
      signal: abort.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = abort.signal.aborted ? `no response within ${HEADERS_TIMEOUT_MS / 1000}s` : err instanceof Error ? err.message : String(err);
    console.warn(`[tts] ElevenLabs unreachable: ${reason}`);
    return json(502, { error: `ElevenLabs unreachable: ${reason}`, code: "tts_upstream_error", upstreamStatus: null });
  }
  clearTimeout(timer);

  if (!upstream.ok || !upstream.body) {
    const message = upstreamMessage(await upstream.text().catch(() => ""));
    // Keep 503 reserved for "not configured": map upstream 5xx to 502, pass 4xx through.
    const status = upstream.status >= 500 || upstream.ok ? 502 : upstream.status;
    console.warn(`[tts] ElevenLabs HTTP ${upstream.status}: ${message}`);
    return json(status, { error: `ElevenLabs error (HTTP ${upstream.status}): ${message}`, code: "tts_upstream_error", upstreamStatus: upstream.status });
  }

  // Pass the upstream stream through untouched (no buffering).
  return new Response(upstream.body, {
    status: 200,
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
}
