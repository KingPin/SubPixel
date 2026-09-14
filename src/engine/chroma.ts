import { loadSharp } from "./sharpx.js";

/**
 * The key colour.
 *
 * Pure magenta is chosen because almost nothing in a naturally-lit image is close
 * to it, so the tolerance can be generous without eating the subject. Green screen
 * is the film convention, but green is common in real subjects — foliage, fabric,
 * eyes — and keying it out of a generated illustration takes bites out of things
 * the user wanted.
 */
export const CHROMA_KEY_HEX = "#FF00FF";
const KEY = { r: 255, g: 0, b: 255 } as const;

export interface ChromaOptions {
  /** Distance below which a pixel is fully transparent. */
  tolerance?: number;
  /** Width of the fade band above the tolerance, where alpha ramps to opaque. */
  softness?: number;
  /** How strongly to pull magenta fringing toward neutral. 0 disables it. */
  spill?: number;
}

const DEFAULT_TOLERANCE = 60;
const DEFAULT_SOFTNESS = 90;
const DEFAULT_SPILL = 1;

// These three are knobs, not constants of nature. How wide a model's "flat"
// background actually drifts, and how far it bleeds onto the subject, varies by
// model and by prompt — the only way to tune them is to look at a keyed image.
// `softness` is the one to reach for: it sets both the alpha ramp and, with it, how
// far spill suppression reaches. Raise it if a magenta fringe survives; lower it if
// colours near the subject edge shift. `ChromaOptions` exposes all three so a caller
// that has looked at its own output can override them.

/**
 * Replace the key colour with transparency.
 *
 * The maths is a distance threshold with a soft band, not an exact-match test. An
 * exact test produces a hard, aliased cutout with a magenta halo one pixel wide,
 * because the model's "flat" background is never bit-identical across the frame and
 * the subject's anti-aliased edge is a blend of subject and background.
 */
export async function chromaKey(data: Uint8Array, options: ChromaOptions): Promise<Buffer> {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const softness = options.softness ?? DEFAULT_SOFTNESS;
  const spillFactor = options.spill ?? DEFAULT_SPILL;

  const sharp = await loadSharp("--transparent");
  const { data: raw, info } = await sharp(Buffer.from(data))
    .ensureAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  for (let i = 0; i < raw.length; i += channels) {
    const r = raw[i]!;
    const g = raw[i + 1]!;
    const b = raw[i + 2]!;

    const distance = Math.sqrt((r - KEY.r) ** 2 + (g - KEY.g) ** 2 + (b - KEY.b) ** 2);

    if (distance <= tolerance) {
      raw[i + 3] = 0;
      continue;
    }
    // Outside the fade band: a fully opaque subject pixel. Leave it completely
    // alone — colour included. See the note below.
    if (distance >= tolerance + softness) continue;

    const ramp = (distance - tolerance) / softness;
    raw[i + 3] = Math.round(raw[i + 3]! * ramp);

    // Spill suppression, applied ONLY to pixels this pass just made partially
    // transparent — that is, the anti-aliased boundary between subject and key.
    //
    // `min(r, b) > g` describes "magenta-ish", and a great many deliberate colours
    // are magenta-ish. Applied to every surviving pixel it destroys them: opaque
    // purple (128, 0, 128) has spill = 128, and at the default factor both channels
    // go to zero. The subject turns black, with no message, nowhere near the
    // background, and nothing to connect the damage to a transparency flag.
    //
    // Distance alone cannot separate the two cases — purple sits about 180 from the
    // key, FURTHER than a genuinely spilled edge pixel — so distance alone is not
    // what this gates on. Spill is an edge artefact, and the edge is exactly the set
    // of pixels whose alpha changed. Gating on that is conservative in the right
    // direction: a fringe that survives is visible and fixable by raising
    // `softness`, whereas a recoloured subject is neither.
    //
    // `ramp` doubles as the strength: a pixel that is mostly background gets the
    // full correction, one that is mostly subject gets almost none, and the
    // correction fades to zero exactly where suppression stops. No visible step.
    if (spillFactor > 0) {
      const spill = Math.min(r, b) - g;
      if (spill > 0) {
        const strength = spillFactor * (1 - ramp);
        raw[i] = Math.max(0, Math.round(r - spill * strength));
        raw[i + 2] = Math.max(0, Math.round(b - spill * strength));
      }
    }
  }

  // PNG unconditionally. The whole point of this function is the alpha channel, and
  // re-encoding into a format that would drop it silently undoes the work.
  return sharp(raw, { raw: { width: info.width, height: info.height, channels } })
    .png()
    .toBuffer();
}
