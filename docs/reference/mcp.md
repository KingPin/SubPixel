# The subpixel MCP server

`spx mcp` runs a Model Context Protocol server on stdio. An agent host spawns it; you
should not need to run it by hand except to debug. It takes no flags — everything it
needs comes from the project config in the directory it is launched from.

`spx init` writes the config for every harness installed on this machine, except the
Claude Code entry — see below. The rest of this page is what that config contains and
what the server does once it is running.

## Setup

The launch command is the same everywhere:

```
npx -y subpixel mcp
```

`npx` rather than a bare `subpixel` because the harness spawns the server with its own
PATH, which for a GUI-launched editor often lacks the user's node version manager
shims. `-y` because a stdio transport has no terminal on which to answer an install
prompt.

### Claude Code

**`spx init` does not write this one.** Claude Code gets the skill instead: it drives
the same CLI through the shell it already has, its Bash timeout is long enough for a
six minute codex-exec run, and a skill costs nothing until an image is wanted, while
these seven tool schemas sit in the model's context on every turn. Ask for the entry
with `spx init --only claude-mcp`, or write it by hand.

`.mcp.json` in the project root, committed with the repository. An entry with no
`type` is read as stdio.

```json
{
  "mcpServers": {
    "subpixel": { "command": "npx", "args": ["-y", "subpixel", "mcp"] }
  }
}
```

### Cursor

`.cursor/mcp.json` for one project, or `~/.cursor/mcp.json` for every project. Cursor
is the one host whose field table marks `type` required for stdio.

```json
{
  "mcpServers": {
    "subpixel": { "type": "stdio", "command": "npx", "args": ["-y", "subpixel", "mcp"] }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`. User-scoped; Windsurf documents no
project-scoped MCP file. There is no `type` field.

```json
{
  "mcpServers": {
    "subpixel": { "command": "npx", "args": ["-y", "subpixel", "mcp"] }
  }
}
```

### Cline

`~/.cline/data/settings/cline_mcp_settings.json`, shared by the IDE extension, the
CLI, and the SDK. **Not** the VS Code global-storage file — Cline v4 moved off it, and
the old path is now only a migration source.

```json
{
  "mcpServers": {
    "subpixel": { "command": "npx", "args": ["-y", "subpixel", "mcp"], "disabled": false }
  }
}
```

### Kilo Code

`${XDG_CONFIG_HOME:-~/.config}/kilo/kilo.jsonc`, or `kilo.jsonc` in the project root.
Kilo Code v7 moved MCP into the main config file and renamed the shape: the container
is `mcp`, the transport is `local`, and `command` is the whole argv with no separate
`args`. An `mcpServers` entry here is read by nothing and reports no error.

```json
{
  "mcp": {
    "subpixel": {
      "type": "local",
      "command": ["npx", "-y", "subpixel", "mcp"],
      "enabled": true
    }
  }
}
```

### Harnesses with no MCP support

`spx init` writes an `AGENTS.md` block describing the CLI instead. There is no server
to configure.

## Working directory

The server inherits the working directory of the host that spawned it, and that
directory decides everything downstream: which `subpixel.config.*` is in force, which
`assets.yml` `sync_assets` reads, and which `.subpixel/jobs/` holds the job records.

A project-scoped config therefore needs no `cwd` override — the host is already in the
project. **A user-scoped config has no project to be in.** The Windsurf, Cline, and
Kilo Code entries above apply to every project you open, and the server reads whichever
project the host happens to be running from. If a host runs from your home directory,
that is the project the server sees.

## Tools

| Tool | Read-only | Spends quota |
| --- | --- | --- |
| `generate_image` | no | yes |
| `edit_image` | no | yes |
| `sync_assets` | no | yes, unless `check` |
| `list_styles` | yes | no |
| `list_models` | yes | no |
| `get_image_job` | yes | no |
| `doctor` | yes | no |

### generate_image

Generate an image from a text prompt. `prompt` is required. The optional arguments are
`reference_images`, `size`, `quality`, `background`, `format`, `exact_size`,
`transparent`, `variants`, `style`, `model`, `out`, `out_dir`, `backend`, `n`,
`no_cache`, `cache_only`, and `dry_run`.

`reference_images` is reference-guided generation, not in-place pixel editing. `size`,
`quality`, and `background` are best effort on the subscription backend; `exact_size`
is the one that is guaranteed, and it needs `sharp`.

`dry_run: true` reports what the call would do — the backend chain, the driver model
and where it came from, the effective prompt after the style is applied, the output
directory, and the cache key — and then stops. It makes no network call, spends
nothing, and writes nothing. It is the argument to reach for before an expensive
call, and the cache key it reports is the key the real call will look up, so an agent
can tell a hit from a miss without paying to find out.

A preview is not a reservation. Nothing is held: another process can fill or empty the
cache between the preview and the real call, and the driver model can rotate.

`n` accepts only 1. Every image costs subscription quota, and a tool that could be
asked for eight of them is a tool that will be.

`no_cache: true` skips the cache lookup and draws the request again, which spends
quota every time. Earlier releases withheld it on the grounds that an agent given a
bypass will use it. That reasoning does not survive contact: an agent that wants a
different picture for the same prompt and has no bypass appends noise to the prompt
instead, which spends exactly the same quota and leaves a junk entry in the cache
under a prompt nobody will type again. The argument is named for what it does, its
description says it spends, and the reported `cached` field still tells the host which
calls were free.

It is not a retry, and using it as one is the expensive mistake. Generation banks the
bytes it paid for before post-processing, so a call that failed *after* the image was
drawn does leave cache data, and an ordinary retry re-processes those bytes locally
for nothing. `no_cache` skips the bank too and buys the picture a second time.
Retrying a slow call is what `get_image_job` is for.

It is also separate from overwriting: a bypassed run writes a `-v2` sibling rather
than replacing the file the first run produced.

`cache_only: true` is the opposite: answer only if this request is already in the
cache, and fail with `CACHE_MISS` rather than draw it. Nothing is spent either way, so
it is the cheap way for an agent to find out whether an image is already paid for
before it decides to ask for one. Passing it with `no_cache` is refused.

Pinning `model` does **not** force a fresh draw. The driver model is deliberately not
part of the cache key, so a pinned model still serves a hit that some other model
drew. Pass `model` with `no_cache: true` to get this model's own work; `model` alone
only decides who draws a miss.

`backend` does not accept `api`. The paid OpenAI backend is not implemented in this
release, on any surface. When it ships it will be a deliberate, local CLI decision,
never a value a host can pick from a tool schema.

### edit_image

Re-generate an existing image against an instruction. `image` and `instruction` are
required, and the same optional arguments as `generate_image` apply. The source is
sent as a reference, so the result is a new image in the same spirit rather than the
original with pixels changed. Details the instruction did not mention can move.

### sync_assets

Generate the assets declared in `assets.yml` that are missing or out of date.
Arguments: `file`, `check`, `force`, `backend`.

`check: true` reports drift and stops. It makes no network call and spends nothing, so
it is the safe one to reach for first. `check` and `force` together are refused —
one reports, the other regenerates.

### list_styles, list_models, doctor

Read-only. No network call, no quota. `doctor` is the one to run first when a
generation fails: it names the missing credential or dependency directly.

### get_image_job

Read the status of a job started by one of the generating tools. `job_id` is required.
Status is `running`, `done`, or `failed`.

## The two paths a generation takes

A generation takes about 30 seconds on the HTTP backend and up to 6 minutes on
`codex-exec`. That is longer than many hosts will hold a tool call open, so the server
takes one of two paths depending on what the host asked for.

**The host asked for progress.** If the call carries a `progressToken`, the server
holds the request open and streams `notifications/progress` as the engine reports
stages. The result comes back on that same call, however long it takes.

The `progress` value is a counter owned by the request, not the engine's image count.
MCP requires each notification to carry a larger value than the last, and the engine
is allowed to repeat itself. `total` is deliberately never sent: the engine's total
counts images while the counter counts notifications, and an honestly indeterminate
bar is better than one labelled with a denominator from a different unit.

**The host did not.** Without a `progressToken`, the server waits a few seconds — long
enough that a cache hit returns the image rather than a job — and then returns:

```json
{
  "status": "running",
  "job_id": "…",
  "tool": "generate_image",
  "poll": "Call get_image_job with job_id \"…\". Do not retry generate_image."
}
```

The cut-over is 5 seconds by default. Set `mcp.cutoverMs` in the project config, or
`SUBPIXEL_MCP_CUTOVER_MS` in the environment, which wins.

### How many run at once

The server runs 2 spending tool calls at a time. A third waits its turn — it still
gets a job record and still gets a `job_id` at the cut-over, so the host is never
held open by the queue, only by its own work. Set `mcp.concurrency` in the project
config, or `SUBPIXEL_MCP_CONCURRENCY` in the environment, which wins.

This is a process-wide budget, and it is a different number from the top-level
`concurrency` key, which bounds one batch. The backend is one personal subscription;
several agents each running their own batch is how that subscription gets rate
limited.

Calls that cannot spend do not queue: `dry_run`, `cache_only`, `sync_assets` with
`check`, and every read-only tool run immediately however busy the server is. The
limit is on spending, not on answering.

It is in-process only. Two `spx mcp` servers, or a server and a CLI run, do not see
each other's work.

### Poll, do not retry

A tool call that returns a `job_id` has not failed. The work is still running, and the
first attempt may already have been billed. Call `get_image_job` until it reports
`done` or `failed`. **Never re-issue the original call** — that buys a second image.

A job lives only as long as the server process that started it. If the host restarts
the server mid-generation, the orphaned record is marked `failed` on the next startup
and is never resubmitted, for the same reason: the first attempt may already have cost
something.

Records live in `.subpixel/jobs`. A finished one is kept for 24 hours and swept on the
next server startup — far longer than any host polls, short enough that the directory
does not grow without bound. The image and its sidecar manifest are the durable
artifacts; the job record is a receipt for a call that has already been answered.

## Errors

A failed tool call comes back as an MCP error result whose text is one JSON document:

```json
{ "error": { "code": "CONTENT_BLOCKED", "message": "…" } }
```

The code is the same taxonomy the CLI turns into [exit codes](cli.md#exit-codes):

| Code | Exit code | Meaning |
| --- | --- | --- |
| `CONFIG_ERROR` | 2 | A malformed argument, config file, or `assets.yml`. Retrying will not help. |
| `AUTH_EXPIRED` | 3 | Run `codex login`, then retry. |
| `RATE_LIMITED` | 4 | Wait. Retrying immediately makes it worse. |
| `BACKEND_UNAVAILABLE` | 5 | Transient. Safe to retry. |
| `DRIFT_DETECTED` | 6 | `sync_assets` with `check` found the images behind the manifest. |
| `CACHE_MISS` | 7 | `cache_only` was given and this request is not in the cache. Nothing was spent. |
| `CONTENT_BLOCKED` | 1 | The prompt was refused. Change the prompt; retrying is a second charge. |
| `MODEL_REJECTED` | 1 | The pinned model refused the request. |
| `MODEL_UNAVAILABLE` | 1 | The pinned model does not exist or is not reachable. |
| `STREAM_ABORTED` | 1 | The stream ended early. |
| `SUBMISSION_UNCERTAIN` | 1 | The request may have been submitted. Do not retry blind — check for the file. |
| `OUTPUT_ERROR` | 1 | The image was generated but could not be written or post-processed. The bytes exist; do not regenerate. |
| `UNKNOWN` | 1 | Anything that is not a subpixel error. |

Every message is redacted before it leaves the process, so a token pasted into a
prompt or a path never reaches the host.

## Terms of service

subpixel drives the undocumented `chatgpt.com/backend-api/codex` endpoint using your
personal ChatGPT subscription. Do not use it to power a public-facing service.
