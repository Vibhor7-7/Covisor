import { useMemo, useRef, useState } from "react";
import * as api from "../api";
import * as audio from "../audio";
import { useMaxTools, useStore } from "../store";
import type { Call, CallKind } from "./call";

type Step = { who: "user" | "max"; text: string; spec?: Record<string, unknown> };

// Stands in for the ElevenLabs agent until one is configured. It drives the
// same client tools the real agent calls, and speaks Max's lines through the
// backend's text to speech so the blob has a real voice to follow.
const PLANNING: Step[] = [
  {
    who: "max",
    text: "Thursday you agreed on Stripe Checkout over Paddle. Linear has three open checkout issues. Are we fixing those first, or shipping around them?",
    spec: { title: "Stripe checkout v1", decisions: ["Use Stripe Checkout, not Paddle (meeting)"] },
  },
  {
    who: "user",
    text: "Fix them as part of this. The mobile bug blocks checkout anyway.",
    spec: {
      goal: "Ship a working Stripe checkout for the todo app and close the three open checkout issues along the way.",
      scopeIn: ["Stripe Checkout session and redirect", "Fix checkout on mobile Safari (CHK-12)"],
    },
  },
  { who: "max", text: "Got it. Cards only for v1, or wallets like Apple Pay too?" },
  {
    who: "user",
    text: "Cards only. No subscriptions, no saved cards.",
    spec: {
      user: "Free users upgrading to Pro from the checkout page",
      scopeOut: ["Apple Pay and other wallets", "Subscriptions", "Saved cards"],
      decisions: ["Card payments only for v1 (meeting)"],
    },
  },
  { who: "max", text: "Receipts: Stripe's built-in email, or our own?" },
  {
    who: "user",
    text: "Stripe's. And no new database tables.",
    spec: {
      decisions: ["Use Stripe's built-in receipt emails"],
      scopeIn: ["Receipt email after payment (CHK-14)", "Tests for the checkout flow (CHK-15)"],
      constraints: ["No new database tables", "Existing tests must keep passing"],
    },
  },
  { who: "max", text: "Last one. How do we know it's done?" },
  {
    who: "user",
    text: "A test card pays on a phone, a receipt lands, and the tests are green.",
    spec: {
      acceptance: [
        "A Stripe test card completes checkout on mobile Safari",
        "The buyer gets a receipt email",
        "Checkout tests pass",
      ],
      openQuestions: ["The Stripe test key is not in the repo yet"],
    },
  },
  {
    who: "max",
    text: "So: Stripe Checkout, cards only, the mobile fix included, Stripe receipts, no new tables. Done when a test card pays on a phone and tests are green. Ship it?",
  },
  { who: "user", text: "Ship it." },
];

/** How long a line takes to say when there is no audio to time it by. */
const speakMs = (text: string) => Math.min(5200, Math.max(1100, text.length * 38));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Max's line as audio, or null when the backend cannot speak. */
const voice = (text: string) => api.tts(text).catch(() => null);

export function useScriptedCall(): Call {
  const { dispatch } = useStore();
  const tools = useMaxTools();
  const [status, setStatus] = useState<Call["status"]>("idle");
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const session = useRef(0);

  return useMemo<Call>(() => {
    const end = () => {
      session.current += 1;
      audio.stop();
      setSpeaking(false);
      setStatus("idle");
    };

    const start = async (kind: CallKind) => {
      const id = (session.current += 1);
      const live = () => session.current === id;

      const say = async ({ who, text, spec }: Step, clip?: Promise<Blob | null>) => {
        if (who === "max") {
          const spoken = await (clip ?? voice(text));
          if (!live()) return;
          setSpeaking(true);
          dispatch({ type: "said", who, text });
          const played = spoken && (await audio.play(spoken).then(() => true, () => false));
          if (!played) await sleep(speakMs(text));
        } else {
          // The founder's words arrive once they have finished saying them.
          await sleep(speakMs(text) * 0.6);
          if (live()) dispatch({ type: "said", who, text });
        }
        if (!live()) return;
        setSpeaking(false);
        if (spec) tools.updateSpec(spec);
        await sleep(450);
      };

      dispatch({ type: "callStarted", kind });
      setStatus("connecting");
      await sleep(700);
      if (!live()) return;
      setStatus("live");

      if (kind === "standup") {
        const summary = await tools.getStandup();
        if (live()) await say({ who: "max", text: summary });
      } else {
        // Fetch every line up front so Max never pauses to find its voice.
        const clips = new Map(
          PLANNING.filter((step) => step.who === "max").map((step) => [step, voice(step.text)]),
        );
        for (const step of PLANNING) {
          if (!live()) return;
          await say(step, clips.get(step));
        }
        if (!live()) return;
        const result = await tools.startBuild({});
        if (live()) {
          await say({
            who: "max",
            text: result.startsWith("Build started")
              ? "Taking over now. I'll start the agents in Codevisor."
              : result,
          });
        }
      }
      if (live()) end();
    };

    return {
      status,
      speaking,
      muted,
      setMuted,
      error: null,
      scripted: true,
      start,
      end,
      tell: () => {},
      sound: speaking ? audio.stream() : null,
    };
  }, [status, speaking, muted, dispatch, tools]);
}
