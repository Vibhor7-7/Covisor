// Plays Max's spoken audio, and offers the same audio as a stream so the blob
// can watch the voice while it plays.

let context: AudioContext | null = null;
let tap: MediaStreamAudioDestinationNode | null = null;
let playing: AudioBufferSourceNode | null = null;
let cuts = 0;

// Built on first use, which is always after a click: browsers keep an
// AudioContext made earlier than that suspended.
function graph() {
  if (!context || !tap) {
    context = new AudioContext();
    tap = context.createMediaStreamDestination();
  }
  return { context, tap };
}

/** Plays one clip. Resolves when it ends or `stop` cuts it off. */
export async function play(clip: Blob): Promise<void> {
  const { context, tap } = graph();
  const cut = cuts;
  await context.resume();
  const buffer = await context.decodeAudioData(await clip.arrayBuffer());
  // `stop` was called while this clip was still decoding.
  if (cut !== cuts) return;
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.connect(tap);
  return new Promise((done) => {
    source.onended = () => {
      if (playing === source) playing = null;
      done();
    };
    playing = source;
    source.start();
  });
}

export function stop() {
  cuts += 1;
  playing?.stop();
}

/** Everything `play` plays, to analyse. It is not routed to the speakers. */
export const stream = (): MediaStream => graph().tap.stream;
