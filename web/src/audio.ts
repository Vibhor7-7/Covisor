// Plays narration through an analyser, so the blob can move with Max's voice.

let context: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let playing: AudioBufferSourceNode | null = null;
let bins = new Uint8Array(0);

/** Plays one clip. Resolves when it ends or `stop` cuts it off. */
export async function play(clip: Blob): Promise<void> {
  if (!context || !analyser) {
    context = new AudioContext();
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.connect(context.destination);
    bins = new Uint8Array(analyser.frequencyBinCount);
  }
  await context.resume();
  const buffer = await context.decodeAudioData(await clip.arrayBuffer());
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(analyser);
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
  playing?.stop();
}

/** Frequency data of the clip that is playing. Empty when nothing is. */
export function spectrum(): Uint8Array {
  if (!playing || !analyser) return bins.subarray(0, 0);
  analyser.getByteFrequencyData(bins);
  return bins;
}
