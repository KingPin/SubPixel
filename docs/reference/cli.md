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
| `-b, --backend <name>` | `codex-http`, `codex-exec`, `auto`. |
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
except `--image`, `-n` and `--concurrency`: the source is the positional argument,
and `edit` turns one image into one image, so there is nothing to run in parallel.
`--emit` works here exactly as it does on `generate`.

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

| Flag | Meaning |
| --- | --- |
| `--size <WxH>` | Override the recorded generation size. |
| `--style <name>` | Replace the recorded style with a named one from the config. |
| `--model <slug>` | Pin a driver model instead of the recorded one. |
| `-b, --backend <name>` | `codex-http`, `codex-exec`, `auto`. |
| `-o, --out <path>` | Write here instead of over the original. |
| `--json` | Emit the whole result as one JSON document on stdout. |
| `--emit <format>` | `path`, `markdown`, `jsx`, `html`. |
| `-v, --verbose` | Verbose logging on stderr. |
| `-q, --quiet` | Errors only on stderr. |

Each override beats what the manifest recorded; everything else replays as written.
There is no `--no-cache`, because `regen` always ignores the cache, and no
`--overwrite`, because writing over the original is the whole point. Manifests
written before this shape existed replay best-effort and say so once on stderr.

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
| `--json` | Emit the report as one JSON document on stdout. |
| `-v, --verbose` / `-q, --quiet` | Log level on stderr. |

`sync` reads the project config as well as the manifest, so `budget.maxImagesPerRun`,
`backend`, and `concurrency` apply to it. A sync whose plan exceeds the
budget is refused before anything is submitted.

With `--json`, stdout carries exactly one document whether the run succeeded, drifted,
or failed. The human report goes to stderr. `spx sync --check --json | jq .drift` is
therefore safe in CI even though the command exits 6.

`--check` is the CI gate. It reads the sidecar manifest beside each image, compares
it against `assets.yml`, and exits 6 if they disagree. It makes no network calls, so
it is safe to run on every pull request.

## init

```bash
spx init              # write the skill and MCP config for the harnesses on this machine
spx init --dry-run    # print every file that would be written, and write nothing
spx init --force      # replace a config file that could not be parsed
spx init --only cursor,kilo    # write those two targets and nothing else
spx init --global     # configure every harness on this machine, for every project
```

| Flag | Meaning |
| --- | --- |
| `--dry-run` | Render every file that would be written. Writes nothing. |
| `--force` | Replace a config file that could not be parsed, instead of skipping it. The old file is kept beside it as `<name>.bak`. |
| `--only <targets>` | Comma-separated target ids, in place of every target. An unknown id is an error. |
| `--global` | Write each harness its user-scoped config, so every project gets subpixel. |

`init` writes each harness the file it actually reads:

| Target id | Destination | Scope |
| --- | --- | --- |
| `claude-skill` | `.claude/skills/subpixel/SKILL.md` | project |
| `claude-mcp` | `.mcp.json` | project, opt-in |
| `cursor` | `.cursor/mcp.json` | project |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` | user |
| `cline` | `~/.cline/data/settings/cline_mcp_settings.json` | user |
| `kilo` | `${XDG_CONFIG_HOME:-~/.config}/kilo/kilo.jsonc` | user |
| `agents-md` | `AGENTS.md` | project |

Every run prints the id beside each target, so `--only` never needs this table.

`--global` moves the project-scoped targets to the file the same harness reads in
every project:

| Target id | `--global` destination |
| --- | --- |
| `claude-skill` | `~/.claude/skills/subpixel/SKILL.md` |
| `claude-mcp` | `~/.claude.json` — the same file `claude mcp add --scope user` writes |
| `cursor` | `~/.cursor/mcp.json` |
| `agents-md` | none. Reported as "project only": it is a file in a repository and nothing else. |

`windsurf`, `cline`, and `kilo` are user-scoped already, so `--global` leaves them
where they are. Under `--global`, Claude Code is detected like every other harness:
without a `~/.claude` directory it is reported as "not installed" and nothing is
written. Combine the two flags to configure one harness everywhere —
`spx init --global --only cursor`.

`claude-mcp` is opt-in: a plain run does not write it, and `--only claude-mcp` is how
you ask. Claude Code reads the skill and runs the CLI from its own shell, so the server
buys it nothing while its tool schemas cost the model context on every turn. Every run
says so at the foot of the report.

A harness whose config directory does not exist is skipped and reported as "not
installed". The project-scoped files with no directory to detect — the skill and
`AGENTS.md` — are always written. `.mcp.json` has no directory to detect either, but
it is opt-in, so it is written only under `--only claude-mcp`.

Every writer is parse-merge-write. An MCP server someone else configured survives, a
second run produces a byte-identical file, and a file that cannot be parsed is
reported as a conflict and left alone. A file that changes between the plan and the
write is reported as changed and left alone too — run `init` again and it merges into
what is there now. A run with any conflict or any changed file exits 2.

**A user-scoped entry is not project-scoped.** Windsurf, Cline, and Kilo Code keep one
MCP config for every project — and so does everything `--global` writes — so the entry
`init` writes applies everywhere, and the server reads whichever `subpixel.config.*`
and `assets.yml` sit in the directory the host happens to run from.

## mcp

```bash
spx mcp    # run the MCP server on stdio, for an agent host to spawn
```

The server speaks MCP over stdin and stdout. It takes no flags: everything it needs
comes from the project config in the directory it is launched from. Run it by hand
only to debug — an agent host spawns it.

See [mcp.md](mcp.md) for the tools, the dual-path generate contract, and per-host setup.

## doctor and models

```bash
spx doctor              # credentials, driver model, optional dependencies
spx doctor --json       # the same, as one JSON document
spx models              # which driver models spx will try, in order
spx models --model o3   # show the effect of pinning one
spx models --json       # the same, as one JSON document
```

`doctor` reports two lines about agent setup: how many tools `spx mcp` declares, and
which harnesses are still waiting for `spx init`. Neither affects the exit code — an
unconfigured editor cannot stop an image being generated. `doctor` exits 1 only when
the credentials are unusable.

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

The keys are `outDir`, `format`, `style`, `backend`, `concurrency`,
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
