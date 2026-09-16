# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the major version is 0, a minor bump may change behaviour a previous
version had. Those changes are listed under **Changed** with what they affect.

## [Unreleased]

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

[unreleased]: https://github.com/KingPin/SubPixel/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/KingPin/SubPixel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/KingPin/SubPixel/releases/tag/v0.1.0
