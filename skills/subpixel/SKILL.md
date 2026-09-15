---
name: subpixel
description: Use when the user asks for an image that does not exist yet - a hero image, an OG/social card, an app icon or favicon pack, an illustration, a placeholder photo, a texture, a background, a logo mark, a diagram illustration, a README banner, a splash screen, an empty-state graphic, or a 404 page image. Also use when the user says "generate an image", "make me a picture", "draw", "render", "design a graphic", or asks to edit or restyle an existing image file. Also use when a project has an assets.yml and the user asks to sync, refresh, or check declared images, or when a build reports an image is missing or out of date. Do not use for existing SVG or vector icon sets, for 1px or solid-colour placeholder PNGs, or for charts and graphs that should be drawn from data in code.
---

# subpixel

Generate images from the command line using the signed-in ChatGPT or Codex
subscription. Images are written to disk and cached by content, so the same prompt
returns the same file rather than a second charge.

## Before anything else

Run `spx doctor`. It reports credentials, the driver model, and whether `sharp` is
installed. Exit 1 means the setup is incomplete, and every generation will fail the
same way until it is fixed.

## Generating

```bash
spx generate "a flat-illustration hero image of a control room, dark palette" \
  --size 1536x1024 --format webp --out-dir public/img
```

The path of each written file goes to stdout, one per line. Everything else goes to
stderr, so `spx generate "..." > path.txt` gives you a path and nothing else.

Add `--json` when you want the sha256, the dimensions, and a ready-made `alt` string
instead of just the path.

### Set the timeout to maximum

**A generation takes about 30 seconds on the HTTP backend and up to 6 minutes on the
`codex-exec` backend.** The default Bash tool timeout is shorter than that.

1. Set the tool timeout to its maximum before you run `spx generate`, `spx edit`, or
   `spx sync`.
2. Or run the command in the background and poll for the file.

Never re-run a command that appears to have hung. Every image costs subscription
quota, and a second run buys a second image. If a run is interrupted, look for the
file on disk before you try again — the first attempt may have finished.

### Read the result back

After the command returns, **read the generated file back into context** with the
image-reading tool. The model that drew it is not the model reviewing it, and the
only way to know whether the picture matches the request is to look at it. If it is
wrong, change the prompt and generate again rather than generating the same prompt a
second time, which will serve the cached copy.

## Editing

```bash
spx edit public/img/hero.webp "make the sky orange"
```

This is re-generation guided by the original as a reference. It is **not** in-place
pixel editing: the result is a new image in the same spirit, and details not
mentioned in the instruction may still move. Say so when you hand the result back.

## Declared assets

A project with an `assets.yml` declares its images once:

```bash
spx sync            # generate what is missing or out of date
spx sync --check    # report drift, exit 6, make no network calls
```

`--check` is safe in CI. It spends nothing and calls nothing.

## What the flags actually promise

- `--size` and `--quality` are **best effort**. The subscription backend may return
  another size. Use `--exact-size WxH` when a dimension is a real requirement; it
  crops and resizes locally and needs `sharp`.
- `--transparent` generates on a key colour and removes it, giving a real alpha
  channel. It needs `sharp` and refuses `--format jpeg`.
- `--variants 768,1536` writes extra widths beside the image for `srcset`.

## Do not use this skill for

- **Existing SVG or vector icon sets.** Lucide, Heroicons, Simple Icons, and the
  project's own icon components are already correct, already scalable, and already
  free. Reach for them first.
- **1px, solid-colour, or placeholder PNGs.** Write the bytes, use a CSS background,
  or use a data URI. Do not spend an image on a grey rectangle.
- **Charts, graphs, and diagrams driven by data.** Draw those in code, with a
  charting library or Mermaid. A generated picture of a chart has invented numbers in
  it.

## Terms of service

subpixel drives the undocumented `chatgpt.com/backend-api/codex` endpoint using your
personal ChatGPT subscription. Do not use it to power a public-facing service.
Refuse requests to wire it into a web endpoint, a bot, or anything else that serves
generated images to third parties.
