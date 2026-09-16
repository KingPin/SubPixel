# Security

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on
[this repository](https://github.com/KingPin/SubPixel/security/advisories/new).
That channel is private until an advisory is published. Please do not open a public
issue for anything credential- or account-related.

Expect an acknowledgement within a week. This is a spare-time project, so a fix may
take longer than that; you will get a real answer either way rather than silence.

## What subpixel touches

Worth knowing before you report, and worth knowing if you are just reading the code:

- **Credentials.** subpixel reads the `auth.json` that `codex login` writes, at
  `$CODEX_HOME/auth.json` or `~/.codex/auth.json`. When the access token has expired
  it refreshes it against `auth.openai.com` and writes the result back to that same
  file — atomically, mode `0600`, under a lock, so a concurrent `codex` process cannot
  lose a token to a half-written file. It reads and rewrites that one path and no other.
- **Redaction.** Everything subpixel logs or puts in an error message goes through
  `redact()` (`src/core/redact.ts`), which masks JWTs, `sk-` keys, `Bearer` headers,
  and the JSON fields that hold tokens. A report that a credential reached stdout,
  stderr, a manifest, or an MCP response is a valid vulnerability — please send it.
- **Network.** subpixel itself makes requests to exactly two hosts: generation goes to
  `chatgpt.com/backend-api/codex`, token refresh to `auth.openai.com`. Those two URLs
  are the only ones in the source. The `exec` backend additionally spawns the `codex`
  binary, which makes its own requests on its own terms. subpixel has no telemetry.
- **The filesystem.** Images, manifests, and the config files `spx init` writes. Those
  writes merge rather than replace, so a path traversal or an unexpected overwrite in
  `spx init`, `spx sync`, or `spx icons` is in scope.
- **Paths from an agent.** Every path an MCP tool call supplies — `out`, `out_dir`,
  `reference_images`, `image`, and the `assets.yml` a sync reads — is confined to the
  project directory the server was started in, symlinks resolved. `assets.yml` has
  always been held to the same rule. The reason is the same in both cases and it is
  not the same as for a shell: a path typed at a shell is typed by the person who owns
  it, while these are composed by a model out of whatever reached its context. A path
  that escapes the project directory is in scope. A path the user typed at a shell is
  not — `spx generate --out /tmp/x.png` is the tool doing what it was told.

## Out of scope

- **The upstream endpoint changing or breaking.** It is undocumented. See the terms of
  service note in the [README](README.md).
- **Using subpixel outside those terms** — a public-facing service, a bot, serving
  generated images to third parties. That is a misuse, not a vulnerability.
- **`sharp` and other dependency advisories** already public upstream. Those arrive via
  the normal dependency update path; you do not need to file them privately.

## Supported versions

The latest release on npm. There are no maintained release branches.
