# Max: web app (Part A)

The React app for Max. It follows the shared contract in `../PRD.md` section 4.

## Run it

```bash
npm install
npm run mock   # stand-in backend on :3001 (skip once the real backend is up)
npm run dev    # app on http://localhost:5173
```

It is built to sit in the left half of the screen with Codevisor on the right.
For a window with no browser chrome on a Mac:

```bash
open -na "Google Chrome" --args --app=http://localhost:5173
```

## Layout

- **Max** (top half): the blob, one caption line saying what is happening
  right now, and one row of controls (Talk to Max, End call, Stop, Standup).
  The scroll icon in the toolbar swaps the blob for the full transcript and
  run log.
- **Graph** (bottom half): Context, Decisions and Team in three columns. A line
  is drawn only where the data states the link: a Linear key or `(meeting)`
  named in a decision or task, or a task's `dependsOn`. Hover a node to trace
  it; the line at the bottom describes it.
- **Decisions** (the other tab): the spec as text you edit in place. Click to
  edit, Enter to save, Esc to undo, empty an item to remove it. A field edited
  by hand stays as edited, and Max is told about the change mid-call. The spec
  locks when the build starts.

## The blob

`src/lib/talking-blob.js` is the approved Opal Talking Blob, copied in
unchanged (WebGL2 and Web Audio, no dependencies). Do not edit its look or
motion; `talking-blob.d.ts` beside it holds the types. It reads speech, not
just volume: loudness swells it, "ah" stretches it tall, "ee" stretches it
wide, "s" makes the rim glint, and each syllable gives it a jelly poke.

`src/components/Blob.tsx` mounts it and only decides what it listens to:

- **Max speaking on a call**: the stream of the hidden `<audio>` element the
  ElevenLabs SDK plays the agent through.
- **Max listening on a call**: a second, analysis-only tap on the microphone
  (never played back, and dropped while the mic is muted).
- **Scripted call and build narration**: the clips from `/api/tts`, played by
  `src/audio.ts`, which also offers them as a stream.
- **Otherwise**: nothing, and the blob idles.

The rim colour is set to the page background, so it follows the theme. Without
WebGL2 a still CSS gradient in the same colours stands in.

## Settings

The gear in the toolbar. Values are saved in the browser; `.env.local` supplies
the defaults (see `.env.example`).

- **ElevenLabs agent ID**: empty plays a scripted call that drives the same
  three client tools and speaks Max's lines through the backend's `/api/tts`,
  so every view works without an agent.
- **Backend**: defaults to `http://localhost:3001`.
- **Theme** and **Read the run log aloud**.

## The ElevenLabs agent

- the system prompt from PRD section A5, plus this line so the graph can show
  where things came from: "When a spec item comes from a Linear issue or the
  last meeting, end it with the source in parentheses, like (CHK-12) or
  (meeting)."
- a dynamic variable named `context_brief`
- three client tools named `update_spec`, `start_build` and `get_standup`;
  `start_build` and `get_standup` must be set to wait for a response

## Code

- `src/store.tsx`: app state, the stage machine, and the client tool handlers
- `src/call/`: the voice session (`voice.ts`) and its scripted stand-in
- `src/components/`: `Stage` (blob, caption, controls), `Graph`, `Decisions`,
  `Thread` (transcript) and the settings dialog
- `src/styles.css`: the design tokens and every style
- `dev-mock/`: the stand-in backend; delete once `MOCK=1` works on the server
