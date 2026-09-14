/**
 * An 8x8 solid-colour PNG, 74 bytes, as base64.
 *
 * A checked-in binary fixture is worse than a constant here: it cannot be read in
 * a diff, it invites a `git add` that silently changes it, and every test that
 * wants "a valid image" wants only these 74 bytes. Generated once with zlib and
 * verified against `sniffFormat`.
 */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4YGCAFTEMLQkA2ntMAeuWKpoAAAAASUVORK5CYII=";

export function tinyPng(): Buffer {
  return Buffer.from(TINY_PNG_BASE64, "base64");
}

export const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;
