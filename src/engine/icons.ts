import { OutputError } from "../core/errors.js";
import { probeDimensions, resizeTo } from "./sharpx.js";

export interface IconSpec {
  name: string;
  size: number;
}

/**
 * What a web project actually needs, and nothing else.
 *
 * This list is short on purpose. Icon generators historically emit forty files for
 * browsers and platforms that stopped mattering a decade ago, and every one of them
 * is a file a reviewer has to look at. These six cover current browsers, iOS home
 * screen, and the Android PWA manifest.
 */
export const ICON_PACK: IconSpec[] = [
  { name: "favicon-16x16.png", size: 16 },
  { name: "favicon-32x32.png", size: 32 },
  { name: "apple-touch-icon.png", size: 180 },
  { name: "android-chrome-192x192.png", size: 192 },
  { name: "android-chrome-512x512.png", size: 512 },
];

/** The sizes packed inside favicon.ico. */
const ICO_SIZES = [16, 32, 48];

/**
 * Every file `buildIconPack` produces, named without producing any of them.
 *
 * A caller that has to decide whether it may write the pack should not have to
 * build the pack to find out what it would be called. Kept honest by a test that
 * runs `buildIconPack` and compares.
 */
export const ICON_PACK_FILES: string[] = [...ICON_PACK.map((spec) => spec.name), "favicon.ico"];

export interface IconFile {
  name: string;
  data: Buffer;
}

/**
 * Build a PNG-payload ICO.
 *
 * ICO is a container: a six-byte header, a sixteen-byte directory entry per image,
 * then the payloads. Every browser in use has accepted PNG payloads since 2011, so
 * there is no BMP encoder here and no need for one. Writing this by hand is about
 * forty lines and costs nothing at install time; the alternative is a dependency
 * that exists only to concatenate buffers.
 */
export function buildIco(images: Array<{ size: number; png: Buffer }>): Buffer {
  if (images.length === 0) throw new OutputError("An ICO must contain at least one image.");

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const at = index * 16;
    // 256 is encoded as 0. The field is one byte, so 256 does not fit.
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, at);
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1);
    directory.writeUInt8(0, at + 2); // palette colours: 0 for a PNG payload
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(image.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

export async function buildIconPack(
  source: Uint8Array,
  warn: (message: string) => void = () => {},
): Promise<IconFile[]> {
  const dimensions = await probeDimensions(source);
  if (dimensions && dimensions.width !== dimensions.height) {
    warn(
      `The source image is not square (${dimensions.width}x${dimensions.height}). ` +
        "Each icon is cropped to a square from the centre, so content near the long edges is cut off.",
    );
  }

  // Every output here is PNG by contract: the pack files are named `.png`, and the
  // ICO directory entries this feeds declare a PNG payload. The format argument is
  // therefore not a preference — without it `resizeTo` re-encodes in the SOURCE
  // format, so `spx icons logo.jpg` would write JPEG bytes into `favicon-32x32.png`
  // and into an ICO that says they are PNG. Both files would be silently broken.
  const files: IconFile[] = [];
  // Keyed by size because the ICO wants two of these back. 16 and 32 are in both
  // lists, and a resize is a decode plus a re-encode of the whole source — on a
  // 2048px master that was two of them spent reproducing bytes already in hand.
  const rendered = new Map<number, Buffer>();
  for (const spec of ICON_PACK) {
    const data = await resizeTo(source, spec.size, spec.size, "cover", "png");
    rendered.set(spec.size, data);
    files.push({ name: spec.name, data });
  }

  const packed = [];
  for (const size of ICO_SIZES) {
    packed.push({
      size,
      png: rendered.get(size) ?? (await resizeTo(source, size, size, "cover", "png")),
    });
  }
  files.push({ name: "favicon.ico", data: buildIco(packed) });

  return files;
}

/** The markup the user has to paste. Printed rather than injected into their HTML. */
export const ICON_SNIPPET = `<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">`;

export const MANIFEST_SNIPPET = JSON.stringify(
  {
    icons: [
      { src: "/android-chrome-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "/android-chrome-512x512.png", sizes: "512x512", type: "image/png" },
    ],
  },
  null,
  2,
);
