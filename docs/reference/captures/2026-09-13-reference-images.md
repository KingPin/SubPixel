# Capture: how a reference image travels on each backend

**Captured:** 2026-09-14 (two runs, 04:21 UTC and 04:26 UTC)
**Driver model:** `gpt-6-astra` (source: cache)
**codex binary:** `codex-cli 0.154.0`
**Probe:** `tests/live/reference.live.test.ts`, run with `SUBPIXEL_LIVE=1`
**Fixture:** `tests/fixtures/tiny.png.ts` — an 8×8 solid PNG, 74 bytes, every pixel `rgb(208, 48, 48)`

This document exists because `src/providers/codex-http-request.ts` sends whatever
string the caller puts in `referenceImages` straight out as `image_url`, and
nothing in the repository established what that string has to be. Tasks 4 and 5
implement against the **Verdict** section below and nothing else.

No token value appears here. Every transcript line passed through `redact()`
before it was printed.

## Transcript

Run 1 — 2026-09-14T04:21:41.101Z. The two `codex exec` routes in this run are
**void**: the probe used `promisify(execFile)`, which leaves stdin as a pipe, and
`codex exec` then blocked on `Reading additional input from stdin...` until the
120 s timeout killed it. Neither request reached the backend. They are recorded
here only because a timeout that looks like a refusal is exactly the mistake this
task exists to catch.

```
- codex-http, `data:` URL → image produced
    event: response.image_generation_call.in_progress
    event: response.image_generation_call.generating
    event: response.image_generation_call.completed
    (item id ig_00d4fd3b551c29aa016aa77656bd9887d1b0c7a24099752237)

- codex-http, bare local path → HTTP 400
    {
      "error": {
        "message": "Invalid 'input[0].content[1].image_url'. Expected a valid URL,
                    but got a value with an invalid format.",
        "type": "invalid_request_error",
        "param": "input[0].content[1].image_url",
        "code": "invalid_value"
      }
    }

- codex exec image flags: -i, --image <FILE>...  "Optional image(s) to attach to
  the initial prompt"
- codex binary: codex-cli 0.154.0

- codex exec, -i flag                        → VOID (probe blocked on stdin)
- codex exec, filename in prompt, file in cwd → VOID (probe blocked on stdin)
```

Run 2 — 2026-09-14T04:26:52Z, after the probe was changed to `spawn` with
`stdio: ["ignore", "pipe", "pipe"]`. The HTTP paths are byte-identical code to
run 1 and are not restated. Both exec routes answered:

```
- codex exec, -i flag → answered:
    user  Name the single colour of the attached image in one word.
          If you cannot see an image, say NO IMAGE.
    codex Peach
    tokens used 8,940

- codex exec, filename in prompt, file in cwd → answered:
    codex I'll open tiny.png to check its colour.
    (PostToolUse)
    codex Red
    tokens used 9,248
```

The fixture is `rgb(208, 48, 48)`. "Peach" and "Red" are both in that colour's
family and neither is producible by guessing from the prompt text, which never
names a colour. The model saw the pixels in both routes.

The two routes are not the same mechanism, and the difference matters to Task 5:
`-i` attaches the image to the prompt, while naming the file made the **agent**
open it with a file-read tool (note the `PostToolUse` hook). Only `-i` is an
image attachment.

## Verdict

Tasks 4 and 5 implement against these five sentences.

1. **`codex-http` accepts a `data:` URL and only a `data:` URL — USED.** A
   `data:image/png;base64,...` string in `input[].content[].image_url` produced a
   completed image (`response.image_generation_call.completed`). A bare local
   filesystem path is rejected conclusively with HTTP 400
   `invalid_value` on `input[0].content[1].image_url`, "Expected a valid URL". A
   remote `https:` URL was **not tried** and is therefore `INCONCLUSIVE`; nothing
   in this plan needs one, so no code path may assume it works.

2. **`codex exec` accepts an image attachment flag, spelled `-i` / `--image
   <FILE>...`, and the model does read the attached pixels — USED.** Asked to
   name the colour of an `rgb(208, 48, 48)` square attached with `-i`, the model
   answered "Peach". It repeats and it is not guessable from the prompt.

3. **Naming the file in the prompt also works, by a different and weaker
   mechanism — NOT USED.** The model answered "Red", but the transcript shows it
   did so by invoking a file-read tool, not by receiving an attachment. That
   depends on the agent's sandbox permitting a read of that path and on the file
   surviving until the agent gets to it. `-i` exists and is explicit, so Task 5
   uses `-i` and never this.

4. **No size ceiling is visible in any rejection message.** The only rejection
   captured was a format rejection. The 74-byte fixture says nothing about where a
   ceiling would be, so no limit may be hard-coded from this capture; if a large
   reference is ever rejected, re-capture before inventing a number.

5. **Both backends consume references, so `--image` ships on both.** Task 5 routes
   `codex-http` references as `data:` URLs built from the file's own bytes, and
   `codex-exec` references as repeated `-i <path>` arguments. Neither route is
   speculative and neither needs a fallback branch to the other.

**Operational finding, binding on Task 5:** `codex exec` must be spawned with
stdin closed (`stdio[0] = "ignore"`). With stdin left as a pipe it waits on
`Reading additional input from stdin...` and hangs until killed. `src/providers/
codex-exec.ts` must not be given a piped stdin it never writes to.
