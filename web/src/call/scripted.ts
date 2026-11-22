import { useMemo, useRef, useState } from "react";
import { useMaxTools, useStore } from "../store";
import { NO_SPECTRUM, type Call, type CallKind } from "./call";

type Step = { who: "user" | "max"; text: string; spec?: Record<string, unknown> };

// Stands in for the ElevenLabs agent until one is configured. It drives the
// same client tools the real agent calls.
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

const speakMs = (text: string) => Math.min(5200, Math.max(1100, text.length * 38));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function useScriptedCall(): Call {
  const { dispatch } = useStore();
  const tools = useMaxTools();
  const [status, setStatus] = useState<Call["status"]>("idle");
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const session = useRef(0);
  const voiced = useRef(false);
  const bins = useRef(new Uint8Array(48));

  return useMemo<Call>(() => {
    const end = () => {
      session.current += 1;
      voiced.current = false;
      setSpeaking(false);
      setStatus("idle");
    };

    const start = async (kind: CallKind) => {
      const id = (session.current += 1);
      const live = () => session.current === id;

      const say = async ({ who, text, spec }: Step) => {
        voiced.current = true;
        setSpeaking(who === "max");
        // Max's words arrive as the line starts; the founder's once they finish.
        if (who === "max") dispatch({ type: "said", who, text });
        await sleep(who === "max" ? speakMs(text) : speakMs(text) * 0.6);
        if (!live()) return;
        if (who === "user") dispatch({ type: "said", who, text });
        voiced.current = false;
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
        for (const step of PLANNING) {
          if (!live()) return;
          await say(step);
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

    // A stand-in for microphone and speaker levels, shaped like speech.
    const spectrum = () => {
      if (!voiced.current) return NO_SPECTRUM;
      const t = performance.now() / 1000;
      const envelope = 0.55 + 0.45 * Math.sin(t * 7.3) * Math.sin(t * 2.1 + 1);
      const data = bins.current;
      for (let i = 0; i < data.length; i += 1) {
        const ripple = (Math.sin(t * 11 + i * 0.9) + Math.sin(t * 5.7 + i * 0.37) + 2) / 4;
        data[i] = 255 * envelope * ripple * Math.exp(-i / 26);
      }
      return data;
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
      spectrum,
    };
  }, [status, speaking, muted, dispatch, tools]);
}
