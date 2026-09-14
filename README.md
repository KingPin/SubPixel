# subpixel

subpixel is a command-line image generator for AI coding agents. It reuses the ChatGPT
or Codex subscription you already pay for, so there's no separate image API key to
provision and no per-image billing to watch. Point it at a prompt, get a file on disk:
`spx generate "a flat-illustration hero image, 1200x630"`. Results are cached by
content, so re-running the same prompt gives you the same file back instead of a new
bill. There's also `spx doctor` to tell you whether your credentials and optional
dependencies are in order, and `spx models` to show which driver models it will try.

Declare your images once in `assets.yml`, run `spx sync` to generate what changed, and
put `spx sync --check` in CI — it exits 6 if the committed images have fallen behind the
manifest, and it makes no network calls to find out.

See [docs/reference/cli.md](docs/reference/cli.md) for every command, the exit codes, and
the configuration file formats.

## License

Apache License 2.0. See [LICENSE](LICENSE).
