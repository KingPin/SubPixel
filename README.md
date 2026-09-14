# subpixel

subpixel is a command-line image generator for AI coding agents. It reuses the ChatGPT
or Codex subscription you already pay for, so there's no separate image API key to
provision and no per-image billing to watch. Point it at a prompt, get a file on disk:
`spx generate "a flat-illustration hero image, 1200x630"`. Results are cached by
content, so re-running the same prompt gives you the same file back instead of a new
bill. There's also `spx doctor` to tell you whether your credentials and optional
dependencies are in order, and `spx models` to show which driver models it will try.

Still early — the CLI works, the docs don't exist yet. This README will grow up later.

## License

Apache License 2.0. See [LICENSE](LICENSE).
