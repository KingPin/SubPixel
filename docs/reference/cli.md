# spx command reference

Every command writes artifact paths to stdout and everything else to stderr, so
`spx generate "..." > path.txt` gives you a path and nothing else.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Success | — |
| 1 | Generation failed | Read the message. A refused prompt, a bad output path, an aborted stream. |
| 2 | Configuration error | A malformed flag, config file, or `assets.yml`. Fix the input; retrying will not help. |
| 3 | Authentication expired | Run `codex login`, then retry. |
| 4 | Rate limited | Wait. Retrying immediately makes it worse. |
| 5 | Backend unavailable | Transient. Safe to retry, and safe to fall back to another backend. |
| 6 | `sync --check` found drift | Run `spx sync` and commit the result. |

A CI job that wants to retry should retry on 5 and never on 2.

## generate

```bash
spx generate "an isometric analytics dashboard, dark mode" --size 1536x1024 --format webp
```

| Flag | Meaning |
| --- | --- |
| `--size <WxH>` | Requested generation size, as `WIDTHxHEIGHT`. Advisory to the backend. The names `square`, `portrait`, and `landscape` are an `assets.yml` convenience and are **not** accepted here. |
| `--exact-size <WxH>` | Crop and resize locally to exactly this. Needs `sharp`. |
| `--quality <level>` | `low`, `medium`, `high`, `auto`. |
| `--format <fmt>` | `png`, `jpeg`, `webp`. Defaults to the style, then the config, then `png`. Conversion is local, so anything but the backend's native format needs `sharp`. |
| `--style <name>` | A named style from your config. See below. |
| `--image <path>` | A reference image. Repeatable. |
| `--transparent` | Generate on a flat key colour and chroma-key it to a real alpha channel. Needs `sharp`. Defaults the format to `png`; `webp` also carries alpha; `--format jpeg` is rejected, because JPEG has no alpha channel. |
| `--variants <widths>` | Comma-separated widths, e.g. `768,1536`. Writes `name-768w.ext` beside the image. A width larger than the source is skipped with a warning rather than upscaled, and the skip is recorded in the sidecar so `sync --check` does not report it as drift forever. Needs `sharp`. |
| `--background <mode>` | `transparent`, `opaque`, `auto`. A hint to the backend, unlike `--transparent`. |
| `--model <slug>` | Pin a driver model instead of taking the first available one. |
| `-o, --out <path>` | Write to exactly this file. |
| `--out-dir <dir>` | Directory for derived names. Defaults to the config, else the working directory. |
| `-n <count>` | Number of images. Refused up front if it exceeds `budget.maxImagesPerRun`. |
| `--emit <format>` | `path`, `markdown`, `jsx`, `html`. |
| `--json` | Emit the whole result as one JSON document on stdout. |
| `--dry-run` | Print the resolved plan and exit without spending quota. |
| `--no-cache` | Ignore the cache for this request. |
| `--overwrite` | Replace an existing output file. |
| `--no-overwrite` | Write a `-v2` sibling instead of replacing. This is the default; the flag exists to spell it. |
| `-f, --force` | `--no-cache --overwrite`. |
| `-b, --backend <name>` | `codex-http`, `codex-exec`, `api`, `auto`. |
| `--allow-paid` | Permit the paid `api` backend, which spends OpenAI credits. |
| `--concurrency <n>` | Maximum simultaneous requests. |
| `--timeout <seconds>` | Whole-request budget, measured from the start of the request. |
| `--stall-timeout <sec>` | Give up after this many seconds with no stream activity. |
| `-v, --verbose` | Verbose logging on stderr. |
| `-q, --quiet` | Errors only on stderr. Format-mismatch and collision warnings survive it. |

Existing files are never overwritten without `--force`. A collision writes
`name-v2.ext` and says so on stderr. Re-running a request that already produced the
file on disk rewrites the same path rather than adding a sibling, so `spx sync` is
idempotent.

## edit

```bash
spx edit logo.png "put it on a dark navy background"
```

Takes exactly one source image and an instruction. Every `generate` flag applies,
except `--image`, `--emit` and `-n`: the source is the positional argument, and
`edit` writes one image.

## regen

```bash
spx regen images/hero.png                 # replay the recorded request, new pixels
spx regen images/hero.png --size 1024x1024
spx regen images/hero.png --style brand -o images/hero-v2.png
```

Re-generates an image from the sidecar manifest written beside it — the `.json` file
`generate`, `edit` and `sync` leave next to every image. The manifest records the
whole request: prompt, style, reference images, quality, background, transparency,
the requested variant widths and their names. `regen` replays all of it, ignores the
cache, and writes over the original.

Reference paths are stored relative to the sidecar, so a replay reads the same files
whichever directory you run it from. A missing, unparseable, or wrong-shaped
manifest exits 2 before any quota is spent; it never regenerates from nothing.

Accepted overrides: `--size`, `--style`, `--model`, `--backend`, `-o`. Each beats
what the manifest recorded. Manifests written before this shape existed replay
best-effort and say so once on stderr.

## icons

```bash
spx icons logo.png --out-dir public
spx icons logo.png --overwrite   # replace an existing pack
spx icons logo.png --json        # the file list as one JSON document
```

Writes a favicon and PWA icon pack into `--out-dir` (default `icons`):
`favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png`,
`android-chrome-192x192.png`, `android-chrome-512x512.png`, and a multi-resolution
`favicon.ico` holding 16, 32, and 48 pixel PNG payloads. Every file is PNG whatever
the source format is. A non-square source is cropped to a square from the centre and
says so on stderr. Needs `sharp`.

## styles

```bash
spx styles          # list the styles your config defines
spx styles brand    # show one, resolved
spx styles --json   # the same, as one JSON document
```

## sync

```bash
spx sync                  # generate what is missing or out of date
spx sync --dry-run        # say what would be generated, spend nothing
spx sync --check          # exit 6 on drift, zero network calls, zero quota
spx sync --force          # regenerate everything, ignoring the cache
spx sync --json           # the report as one JSON document, on success and on failure
```

| Flag | Meaning |
| --- | --- |
| `-f, --file <path>` | Path to the manifest. Note that `-f` means `--file` here and `--force` on `generate`. |
| `--check` | Report drift and exit 6. Makes no network calls. |
| `--force` | Regenerate every asset, not only the drifted ones, and ignore the cache. |
| `--dry-run` | Report what would be generated and exit without spending quota. |
| `--concurrency <n>` | Maximum simultaneous requests. Defaults to the config. |
| `-b, --backend <name>` | Overrides `backend` in the config. |
| `--allow-paid` | Permit the paid `api` backend. |
| `--json` | Emit the report as one JSON document on stdout. |
| `-v, --verbose` / `-q, --quiet` | Log level on stderr. |

`sync` reads the project config as well as the manifest, so `budget.maxImagesPerRun`,
`backend`, `allowPaid`, and `concurrency` apply to it. A sync whose plan exceeds the
budget is refused before anything is submitted.

With `--json`, stdout carries exactly one document whether the run succeeded, drifted,
or failed. The human report goes to stderr. `spx sync --check --json | jq .drift` is
therefore safe in CI even though the command exits 6.

`--check` is the CI gate. It reads the sidecar manifest beside each image, compares
it against `assets.yml`, and exits 6 if they disagree. It makes no network calls, so
it is safe to run on every pull request.

## doctor and models

```bash
spx doctor              # credentials, driver model, optional dependencies
spx doctor --json       # the same, as one JSON document
spx models              # which driver models spx will try, in order
spx models --model o3   # show the effect of pinning one
spx models --json       # the same, as one JSON document
```

## subpixel.config.json

Discovered by walking up from the working directory. `package.json#subpixel` works
too. Relative paths resolve against the config file's own directory, not yours.

```json
{
  "outDir": "public/images",
  "format": "webp",
  "style": "brand",
  "backend": "auto",
  "concurrency": 2,
  "budget": { "maxImagesPerRun": 8 },
  "styles": {
    "brand": {
      "palette": "deep navy, warm amber",
      "modifiers": "flat vector, generous whitespace",
      "negative": "no gradients, no drop shadows"
    }
  }
}
```

The keys are `outDir`, `format`, `style`, `backend`, `allowPaid`, `concurrency`,
`budget`, and `styles`. There is no `size` key: a project-wide generation size is a
per-image decision, and `assets.yml` already has `defaults.size`. `style` names the
style used when `--style` is absent. An unknown key is ignored with a warning, so a
config written by a newer release still works on an older one; a known key with the
wrong type is an error.

A style changes only the text sent to the backend. Your filenames and the `prompt`
field in the manifest keep the prompt you typed.

Precedence, lowest to highest: built-in defaults, the config file, the style named by
`--style` or `config.style`, command-line flags. There is no environment layer.

Exactly one config file is read — the nearest one found walking up from the working
directory. In the same directory a `subpixel.config.json` wins over
`package.json#subpixel`; configs are not merged across directories.

## assets.yml

```yaml
defaults:
  outDir: public/images
  style: brand
  format: webp
  size: landscape

styles:
  brand:
    palette: "deep navy, warm amber"
    modifiers: "flat vector, generous whitespace"

assets:
  - id: hero
    prompt: "Analytics dashboard, dark mode, isometric"
    variants:
      - width: 1536
      - width: 768
        suffix: "@sm"
  - id: og-card
    prompt: "Wide social card, product name centred"
    exactSize: 1200x630
    format: png
```

`size` accepts `square`, `portrait`, `landscape`, or a literal `1024x1536`. `out`
defaults to `<outDir>/<id>.<format>` and must stay inside the manifest's directory.

## The optional sharp dependency

`sharp` is an optional peer dependency. Install it with `npm i sharp`. Without it,
generation works and these do not: `--exact-size`, `--transparent`, `--variants`,
`spx icons`, and any `--format` that differs from the backend's output. Each says so
by name rather than failing obscurely. `spx doctor` reports whether it is present.
