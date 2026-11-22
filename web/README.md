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

`src/components/Blob.tsx` is one WebGL fragment shader with no dependencies.
It draws a soft 3D opal whose surface swells by direction, so the point under
each pixel is solved in three steps rather than ray-marched (about 2 ms a frame
on integrated graphics).

- It moves with real audio: the ElevenLabs output and microphone during a call,
  and the narration audio during a build (`src/audio.ts`).
- Speaking warms it (peach and rose spread through the blues) and swells it;
  listening cools and calms it; working alone turns it steadily.
- Low notes move the big lobes and sharper sounds add finer folds.

## Settings

The gear in the toolbar. Values are saved in the browser; `.env.local` supplies
the defaults (see `.env.example`).

- **ElevenLabs agent ID**: empty plays a scripted call that drives the same
  three client tools, so every view works offline.
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
