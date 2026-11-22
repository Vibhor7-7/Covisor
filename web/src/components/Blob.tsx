import { useEffect, useRef, useState } from "react";
import * as audio from "../audio";
import { useCall } from "../call/call";
import { OPAL_PALETTE, TalkingBlob } from "../lib/talking-blob.js";
import { useSettings } from "../settings";
import { useStore } from "../store";

/** The page background as #rrggbb: the colour the blob's rim fades into. */
function pageColor(): string {
  const channels = getComputedStyle(document.body).backgroundColor.match(/\d+/g)!.slice(0, 3);
  return `#${channels.map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Max, as the opal talking blob (src/lib/talking-blob.js). This only decides
 * what it listens to: Max's voice or the founder's microphone during a call,
 * the narration during a build, and nothing the rest of the time.
 */
export function Blob() {
  const { state } = useStore();
  const call = useCall();
  const { appearance } = useSettings();
  const box = useRef<HTMLDivElement>(null);
  const blob = useRef<TalkingBlob | null>(null);
  const [flat, setFlat] = useState(false);

  useEffect(() => {
    const el = box.current!;
    try {
      blob.current = new TalkingBlob(el, { rim: pageColor() });
    } catch {
      // No WebGL2. A still gradient in the same colours stands in.
      el.replaceChildren();
      setFlat(true);
      return;
    }
    return () => {
      blob.current?.destroy();
      blob.current = null;
    };
  }, []);

  // The rim follows the theme, whether the setting or the system changes it.
  useEffect(() => {
    const tint = () => blob.current?.setPalette(OPAL_PALETTE, pageColor());
    tint();
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    system.addEventListener("change", tint);
    return () => system.removeEventListener("change", tint);
  }, [appearance]);

  const narrating = state.narratingId !== null;
  const source = call.status === "live" ? call.sound : narrating ? audio.stream() : null;
  useEffect(() => {
    if (!source) {
      blob.current?.unlisten();
      return;
    }
    try {
      blob.current?.listen(source);
    } catch (error) {
      // A stream the browser will not analyse should cost the motion, not the app.
      console.warn("The blob cannot follow this audio:", error);
    }
  }, [source]);

  return <div ref={box} className={`blob ${flat ? "is-flat" : ""}`} aria-hidden="true" />;
}
