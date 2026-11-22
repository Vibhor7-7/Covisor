// Env config. Bun loads .env from the working directory automatically.
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const RUNS_DIR = join(ROOT, "runs");
export const MOCKS_DIR = join(ROOT, "mocks");

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3001),
  mock: env.MOCK === "1" || env.MOCK === "true",
  codevisorUrl: env.CODEVISOR_URL ?? "http://127.0.0.1:49361",
  codevisorToken: env.CODEVISOR_TOKEN ?? "",
  linearApiKey: env.LINEAR_API_KEY ?? "",
  linearTeamKey: env.LINEAR_TEAM_KEY ?? "",
  elevenLabsApiKey: env.ELEVENLABS_API_KEY ?? "",
  elevenLabsVoiceId: env.ELEVENLABS_VOICE_ID ?? "",
  managerModel: env.MANAGER_MODEL ?? "opus",
  demoRepo: env.DEMO_REPO ?? "",
};
