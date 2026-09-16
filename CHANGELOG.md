# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the major version is 0, a minor bump may change behaviour a previous
version had. Those changes are listed under **Changed** with what they affect.

## [Unreleased]

## [0.3.0] - 2026-09-16

Works through a UX and security review of 0.2.0. The themes are the filesystem
authority of an MCP tool, overwrite protection that covers a whole destination
rather than half of one, and telling a caller what actually happened.

### Security

- **Every path an MCP tool takes from an agent is confined to the project.**
  `out`, `out_dir`, `reference_images`, and `image` were resolved against the
  working directory and never checked, so `../../.ssh/id_rsa` was a readable
  reference and `../../../etc/cron.d/x.png` was a writable destination.
  `assets.yml` already had a containment check; `within()` and `realish()` moved
  to `core/fsx.ts` and every path site now calls the same one. `SECURITY.md`
  states the scope: a path from an agent is in scope, a path typed into a shell
  is not.
- **`spx init --dry-run` no longer prints the merged configuration file.** The
  preview was built by merging subpixel's entry into the user's existing config
  and serialising the result, so a dry run of `spx init claude` printed back
  every other MCP server's API keys. Each writer renders only subpixel's own
  entry now.
- **The sidecar is treated as half of the destination.** `writeManifest`
  replaced `<image>.json` unconditionally, and it ran after the image had
  landed: finding `hero.png` free was enough to claim it, and the run then
  destroyed a neighbouring JSON nobody passed `--overwrite` for. The slot is
  checked while the destination is still being chosen, and the manifest is then
  published with `link()`/`EEXIST` like the image beside it, so the only file it
  can replace is one it has just read and recognised as subpixel's. A slot that
  cannot be read at all — a directory, a permission error — is not an empty
  slot, and the run steps to a sibling name.

### Added

- `spx generate` reports progress on stderr. A multi-image run printed nothing
  until it finished. A TTY gets one rewritten line, a pipe gets one line per
  event, stdout stays the artifact paths and nothing else, and `--quiet`
  silences it.
- `--json` reports the variants that were written, the widths that were skipped,
  and a format redirect. The payload described only the primary image, so a
  caller consuming `spx generate --json` could not see which variant widths
  existed or that its requested format had been changed.

### Changed

- **`spx sync --check` reads the bytes back.** A cache-key match says the inputs
  are unchanged. It says nothing about the file, which a half-finished copy can
  truncate and an optimiser can rewrite while the sidecar beside it still
  matches. Every artifact is verified, the primary and each variant: a variant
  is a file nothing in the cache key describes, so existing was not evidence of
  being intact. `sync` itself deliberately does not, because it is about to
  consult the cache and write anyway. A sidecar written before this release
  records no digest per variant and is taken on trust rather than reported as
  drift.
- **Bad enum values and impossible dimensions are refused before a request is
  sent.** `--quality ultra` and `--format gif` reached the backend and came back
  as a provider error after the wait, and `--size 999999999x999999999` reached
  aspect-ratio arithmetic and threw a raw `RangeError`. The accepted values are
  declared once in `core/types.ts` and shared by the Commander options, the
  manifest validator, the MCP tool schemas, project config, and the `assets.yml`
  schema, so the five cannot drift. Dimensions are bounded at 16384.
- A reference image is refused at its `stat`, before it is read. The 12 MiB cap
  was applied to a buffer that was already resident, so the 3 GiB file someone
  pointed at by mistake was in the process before anything objected, and the
  objection was an allocation failure. The whole-request budget is threaded
  through the set, so the file that breaks the 32 MiB cap is named rather than
  reported as a grand total after every remaining file has been read.
- A JSONC configuration file is handed the exact entry to paste rather than
  pointed at `--force`. There is still no JSONC parser: the comments belong to
  the user and a round-trip would eat them.
- `spx sync --check` hashes its references instead of loading them.
  `referenceHashes` built a base64 data URL for a request body — a second copy
  of every file, a third longer than the first — and then read one field off the
  result. A check sends nothing anywhere, so all of it was discarded, once per
  reference per asset, on every run. The size caps still apply.
- `spx icons` packs the ICO from the PNGs it has already rendered.
  `buildIconPack` resized the source five times for the pack and three more for
  the ICO, two of them at 16 and 32 — sizes it had just written out. Eight
  resizes become six, and the ICO payloads are byte-identical to the files
  beside them.

### Fixed

- A partial `sync` over MCP no longer discards the report. When some assets
  synced and one failed, the server threw and the successful half of the report
  went with it. Error metadata travels on a `Symbol.for("subpixel.details")`
  property, so the report survives without collapsing the error taxonomy or the
  exit code the way wrapping would.

## [0.2.0] - 2026-09-15

### Added

- `spx init --only <ids>` writes a chosen subset of the harness targets instead
  of the whole default set. Every report line now names the id it wrote, so the
  vocabulary the flag takes is readable from a plain run.
- `spx init --global` configures a harness for every project rather than one
  repository: the skill to `~/.claude/skills`, the Claude Code MCP entry to
  `~/.claude.json`, and Cursor to `~/.cursor/mcp.json`. `AGENTS.md` has no
  user-scoped form and is reported as `unsupported`.
- `SECURITY.md`: a private advisory channel, and what subpixel touches — the
  credential file it reads, the redaction every log goes through, the two hosts
  the source talks to, and the filesystem writes that are in scope.

### Changed

- **`spx init` no longer writes the Claude Code MCP entry by default.** The
  skill and the server configured the same harness twice, and the server cost
  7392 bytes of tool schema in the model's context on every turn against a 4618
  byte skill. Ask for it with `--only claude-mcp`; a default run names the
  target it skipped. An entry already in a project's `.mcp.json` is untouched.
- The HTTP backend pins `reasoning_effort` to `low` rather than inheriting
  whatever the resolved model defaults to. Three of the five listed models
  default to `medium`, so a reorder of the Codex model cache could have raised
  the cost of a generation with no change here. The one forced
  `image_generation` call has nothing to buy with the extra effort.
- The etag refresh layer for the model catalogue is withdrawn. The captured
  `/models` endpoint answers a matching `If-None-Match` with 200 and the full
  360 KB body, so a conditional refresh does not exist to make; a stale cache
  stays reported rather than acted on, and `codex` rewrites it on its own
  staleness check anyway.
- The bundled fallback catalogue carries the slugs and priorities from the
  captured response. It was missing `gpt-6-astra`, which is priority 1.

### Fixed

- `spx init --force` copies the old bytes to `<name>.bak`, with the file's own
  mode, before writing a file it could not parse. Under `--global` the
  unparseable file is Claude Code's session state, and discarding it is not what
  the flag is for. The plan says so before it runs.
- `spx init` refuses to write a target that changed between the plan and the
  apply, reporting `stale` instead. Claude Code writes `~/.claude.json` while it
  runs, which is exactly when someone runs `spx init --global` from inside it.
  Re-running merges into what is there now.
- `spx init` keeps the mode of a file it merges into. Updating a 0600
  `~/.claude.json` handed it back at 0644 — one user's session state readable by
  every account on the machine, with nothing in the output to say so. A
  user-scoped file it creates is 0600 rather than whatever the umask gave.
- `spx init --dry-run` reports the size of a file over 16 KB instead of printing
  its contents. `--global --only claude-mcp` merges one entry into hundreds of
  kilobytes of session history, and the preview put all of it on stdout and into
  any log that captured the run.
- `spx init --only ''` and `--only ,` are a `ConfigError` naming the known
  targets. Both parsed to an empty list, which read as "no preference" and
  planned the default set — a malformed flag wrote more targets than the flag
  exists to narrow to.
- `spx doctor` no longer reports `.mcp.json` as pending on a machine whose
  default run will never write one.

### Documentation

- The README says where the `codex` CLI comes from, how the `npx` and `spx`
  spellings map onto each other, and which file "the project config" names. It
  no longer lists a `model` config key the loader has never accepted.
- The `/models` capture drops the TLS-interception procedure, which used a live
  subscription credential, in favour of `codex debug models` — the findings it
  produced are recorded in prose, and they were the part that mattered. Two
  unlisted model descriptors are no longer named.
- The `init` CLI reference stops counting `.mcp.json` among the files a plain
  run always writes, and names the `stale` outcome.

## [0.1.0] - 2026-09-15

Initial release.

[unreleased]: https://github.com/KingPin/SubPixel/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/KingPin/SubPixel/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/KingPin/SubPixel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/KingPin/SubPixel/releases/tag/v0.1.0
