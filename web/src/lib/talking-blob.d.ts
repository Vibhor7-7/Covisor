// Types for talking-blob.js, which is kept exactly as handed off.

export type BlobSource = MediaStream | HTMLMediaElement | AudioNode;

/** One coloured light in view space (x right, y up, z toward the viewer). */
export type BlobLight = { dir: [number, number, number]; color: string };

export type BlobOptions = {
  /** Exactly 8 lights. Index 4 is the warm one. */
  palette?: BlobLight[];
  /** Silhouette tint, as #rrggbb. Keep it close to the page background. */
  rim?: string;
  glow?: number;
  reactivity?: number;
  detail?: number;
  pointer?: boolean;
  audioContext?: AudioContext | null;
};

export type BlobFeatures = {
  level: number;
  open: number;
  front: number;
  hiss: number;
  warmth: number;
  onset: number;
};

export type BlobLook = {
  lobes: number;
  freq: number;
  morph: number;
  sharp: number;
  warp: number;
  warpFreq: number;
  edge: number;
  rimMix: number;
};

export const OPAL_PALETTE: BlobLight[];

export class TalkingBlob {
  /** Throws when WebGL2 is not available. */
  constructor(container: HTMLElement, options?: BlobOptions);
  listen(source: BlobSource): this;
  unlisten(): this;
  poke(x: number, y: number, amount?: number): void;
  setPalette(palette: BlobLight[], rim?: string): this;
  readonly features: BlobFeatures;
  look: BlobLook;
  destroy(): void;
}
