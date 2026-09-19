# subpixel

**Image generation for AI coding agents, on the ChatGPT subscription you already pay
for.** No image API key to provision, no per-image bill to watch, no placeholder PNGs
left in the repository because the agent had nothing better to reach for.

```bash
npx subpixel generate "a flat-illustration hero image of a control room, dark palette" \
  --size 1536x1024 --out public/hero.png
```

The path of the written file goes to stdout. Everything else goes to stderr.

## Install

```bash
npm install -g subpixel        # or: npx subpixel <command>
```

Examples you run by hand use `spx`, the globally installed binary. Without the
global install, each one works as `npx subpixel <command>` instead — which is what
the CI and MCP snippets below use, since neither can assume a global install.

Node 24 or newer. Authentication comes from the
[Codex CLI](https://github.com/openai/codex), which you need once for the login:

```bash
npm install -g @openai/codex
codex login
```

subpixel reads the `~/.codex/auth.json` that login writes. `sharp` is an optional peer
dependency, needed only for `--exact-size`, `--transparent`, `--variants`, and
`spx icons`.

## 30-second quickstart

1. Check the setup. It names anything missing and exits 1.

   ```bash
   spx doctor
   ```

2. Generate an image.

   ```bash
   spx generate "a wide banner, flat vector, teal and slate" --out public/banner.png
   ```

3. Look at what you got. Every image gets a manifest beside it — `hero.png` is
   written with a `hero.png.json` recording the prompt, the model, and the settings,
   so the same image can be re-generated later with `spx regen`.

Results are cached by content. Running the same prompt again returns the same file
rather than a second charge.

## Set it up for your agent

```bash
spx init
```

`spx init` finds the agent harnesses installed on this machine and writes each one the
config it reads: a Claude Code skill, an MCP server entry for Cursor, Windsurf, Cline,
and Kilo Code, and an `AGENTS.md` snippet for harnesses with no MCP support. Add
`--global` to configure them for every project instead of this one, and `--only` to
pick targets by id. It is parse-merge-write throughout — unrelated servers survive, a
second run changes nothing, and `--dry-run` prints every file it would write without
touching the disk.

Claude Code gets the skill and not an MCP entry, because it can already run the CLI
from its own shell ([why](https://github.com/KingPin/SubPixel/blob/main/docs/reference/mcp.md#claude-code)). Ask for the entry with
`spx init --only claude-mcp` if you want it anyway.

The MCP server is `spx mcp`, a stdio server exposing seven tools: `generate_image`,
`edit_image`, `sync_assets`, `list_styles`, `list_models`, `get_image_job`, and
`doctor`. If you prefer to write the config yourself, it is three lines:

```json
{
  "mcpServers": {
    "subpixel": { "command": "npx", "args": ["-y", "subpixel", "mcp"] }
  }
}
```

A generation outlives most host timeouts, so the server takes one of two paths. A host
that asked for progress notifications gets them, and the call stays open. A host that
did not gets a `job_id` back after a few seconds, and polls `get_image_job` for the
result. **Poll, do not retry.** A retried generation is a second image and a second
charge. See [docs/reference/mcp.md](https://github.com/KingPin/SubPixel/blob/main/docs/reference/mcp.md).

## Declared assets and CI

Declare the images a project needs once, in `assets.yml`:

```yaml
assets:
  - id: hero
    prompt: a wide banner, flat vector, teal and slate
    out: public/hero.png
    size: 1536x1024
```

```bash
spx sync            # generate whatever is missing or out of date
spx sync --check    # exit 6 if a committed image has fallen behind the manifest
```

`--check` makes no network calls and spends nothing, so it is safe as a CI gate:

```yaml
- run: npx subpixel sync --check
```

Exit 6 means the manifest and the committed images disagree. Run `spx sync` locally and
commit the result.

## Commands

| Command | What it does |
| --- | --- |
| `spx generate <prompt>` | Generate an image from a prompt |
| `spx edit <image> <instruction>` | Re-generate an image guided by an existing one |
| `spx regen <image>` | Re-generate from the manifest written beside an image |
| `spx sync` | Generate the assets declared in `assets.yml` |
| `spx icons <image>` | Build a favicon and PWA icon pack from an image |
| `spx styles` | List the named styles in the project config |
| `spx init` | Write the skill and MCP config for the harnesses on this machine |
| `spx mcp` | Run the MCP server on stdio |
| `spx doctor` | Check credentials, driver model, and optional dependencies |
| `spx models` | List the driver models subpixel will try, in order |

`spx "a red fox"` is shorthand for `spx generate "a red fox"`. The shorthand needs
more than one word: a bare `spx fox` is reported as an unknown command rather than
generated, so a mistyped subcommand cannot spend a generation. For a one-word
prompt, say `spx generate fox`.

Project settings — the named styles `--style` and `spx styles` read, the default
backend, the output directory — live in a `subpixel.config.json` found by walking up
from the working directory, or under a `subpixel` key in `package.json`. The driver
model is not one of them; it comes from Codex, and `--model` pins it per run.

Full flags, exit codes, and the configuration file formats are in
[docs/reference/cli.md](https://github.com/KingPin/SubPixel/blob/main/docs/reference/cli.md).

## What the flags actually promise

Two things are worth stating plainly, because both are easy to assume otherwise.

**`spx edit` and `--image` are re-generation guided by a reference, not in-place pixel
editing.** The original is sent as a reference image and a new picture is drawn in its
spirit. Details you did not mention can still move. If you need an untouched region to
stay untouched, composite locally instead.

**`--size` and `--quality` are best effort on the subscription backend.** The backend
may return a different size than the one requested. When a dimension is a hard
requirement, use `--exact-size WxH`, which crops and resizes locally and needs `sharp`.

## Terms of service

subpixel drives the undocumented `chatgpt.com/backend-api/codex` endpoint using your
personal ChatGPT subscription. Do not use it to power a public-facing service. No web
endpoints, no bots, no serving generated images to third parties. The endpoint is
undocumented and may change or stop working without notice.

## License

Apache License 2.0. See [LICENSE](LICENSE).
