# Capture: the Codex `/models` endpoint

**Captured:** 2026-09-15, 19:32–19:38 UTC
**codex binary:** `codex-cli 0.154.0` (standalone, `x86_64-unknown-linux-musl`)
**Probe:** `codex debug models` run against an isolated `CODEX_HOME` holding only a
copy of `auth.json`, with the transport observed through a local intercepting proxy
so the request line, the headers and the server's conditional-request behaviour
could be recorded. Every credential-shaped header was replaced by its length on the
way to disk, and a second observation injected `If-None-Match` into the outgoing
request rather than forging one by hand.

This closes open item 1 of the design spec. `src/providers/models.ts` was written
against an inferred endpoint; this is what the endpoint actually is.

No token, refresh token, id token or account id appears here. `authorization`,
`chatgpt-account-id`, `cookie` and `set-cookie` were redacted before anything was
written to disk.

## Request

```http
GET /backend-api/codex/models?client_version=0.154.0 HTTP/2
Host: chatgpt.com
authorization: Bearer <tokens.access_token from auth.json, 1881 chars>
chatgpt-account-id: <tokens.account_id from auth.json, 36 chars>
originator: codex_cli_rs
version: 0.154.0
accept: */*
user-agent: codex_cli_rs/0.154.0 (CachyOS Linux Rolling Release; x86_64) Konsole/260800
```

No request body. The client version travels twice — once as the `client_version`
query parameter and once as the `version` header.

## Response

```http
HTTP/2 200
content-type: application/json
content-length: 359965
etag: W/"5176fbef59264017aaa01fa3b4710c0a"
cache-control: private, no-store
x-oai-request-id: req_<redacted>
```

Body, structurally:

```json
{ "models": [ /* 7 descriptors */ ] }
```

The raw 359,965-byte body is not kept here and was not retained after the run.
What is recorded below is one descriptor, the union of keys across all seven, and
the catalogue table — enough to write the resolver against, not enough for a
reader to re-derive the schema independently. To get the body, re-run the
procedure under "Reproducing"; `catalogue.json` is it.

One descriptor, verbatim except for the prose fields, which are cut for length:

```json
{
  "slug": "gpt-6-astra",
  "display_name": "GPT-6-Astra",
  "description": "Our most capable model for complex, demanding work.",
  "default_reasoning_level": "low",
  "supported_reasoning_levels": [
    { "effort": "low", "description": "Fast responses with lighter reasoning" },
    { "effort": "medium", "description": "…" },
    { "effort": "high", "description": "…" },
    { "effort": "xhigh", "description": "…" },
    { "effort": "max", "description": "…" },
    { "effort": "ultra", "description": "…" }
  ],
  "shell_type": "unified_exec",
  "visibility": "list",
  "supported_in_api": true,
  "priority": 1,
  "additional_speed_tiers": ["fast"],
  "service_tiers": [{ "id": "priority", "name": "Fast", "description": "…" }],
  "availability_nux": { "message": "…" },
  "upgrade": null
}
```

The full union of keys seen across the seven descriptors:

`additional_speed_tiers`, `apply_patch_tool_type`, `availability_nux`,
`base_instructions`, `comp_hash`, `context_window`, `default_reasoning_level`,
`default_reasoning_summary`, `default_verbosity`, `description`, `display_name`,
`effective_context_window_percent`, `experimental_supported_tools`,
`include_apps_usage_instructions`, `include_plugin_usage_instructions`,
`include_skills_usage_instructions`, `input_modalities`, `max_context_window`,
`model_messages`, `multi_agent_reasoning_effort`, `multi_agent_version`,
`node_repl_auto_review_required`, `node_repl_disabled`, `priority`,
`service_tiers`, `shell_type`, `slug`, `support_verbosity`, `supported_in_api`,
`supported_reasoning_levels`, `supports_experimental_context`,
`supports_image_detail_original`, `supports_search_tool`, `tool_mode`,
`truncation_policy`, `upgrade`, `use_responses_lite`, `visibility`,
`web_search_tool_type`.

The catalogue as returned. Five of the seven descriptors are `visibility: "list"`
and are reproduced below; the other two are `visibility: "hide"` and are not named
here, because nothing in `subpixel` may reach for them — `BUNDLED_MODELS` is the
`list` half and only the `list` half. Their priorities, 3 and 43, are given only so
the gaps in the sequence are not read as an omission.

| slug | visibility | priority | reasoning levels |
| --- | --- | --- | --- |
| `gpt-6-astra` | list | 1 | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-sol` | list | 4 | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-terra` | list | 7 | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-luna` | list | 8 | low, medium, high, xhigh, max |
| `gpt-5.5` | list | 12 | low, medium, high, xhigh |

## Answers to the three questions the issue asked

**Pagination: none.** The response has exactly one top-level key, `models`. No
cursor, no `has_more`, no `Link` header. The CLI's own decoder agrees — the
binary carries `struct ModelsResponse with 1 element`.

**Deprecation: no field carries it, and the retirement signal is unverified.**
Observed: no `deprecated`, `retired` or `sunset` field exists on any descriptor,
and `upgrade` is present and `null` on all seven, so its populated shape says
nothing either.

Not observed: a model being retired. That takes two catalogues far enough apart
to contain a change, and this is one snapshot. Both candidate signals therefore
remain inferences, and neither should be relied on as a contract:

- **`visibility: "hide"`.** Seen on the two unnamed descriptors above. Both read as
  internal or special-purpose rather than withdrawn — one is plainly a job the CLI
  runs for itself. So `hide` is better evidenced as "not offered in the picker" than
  as "on the way out".
- **Omission.** Plausible, unobserved.

Nothing in `subpixel` needs this resolved. The resolver never asks whether a
model is deprecated: it sends a candidate, and a `ModelRejected` advances to the
next. That recovery covers omission, `hide`, and any third mechanism this capture
did not see. Confirm the signal before writing code that branches on it.

**Authentication: the bearer token plus the account id, both from `auth.json`.**
`tokens.access_token` goes in `authorization`, `tokens.account_id` in
`chatgpt-account-id`. Nothing else is credential-bearing. `originator` and
`version` are client identification, not auth.

## The finding that matters: `If-None-Match` does nothing

The design spec's component 4 describes a middle refresh layer that sends the
cached `etag` as `If-None-Match` and treats a `304` as a re-stamp. Neither half
of that holds.

1. **The CLI never sends the header.** Staling `fetched_at` to force a refresh
   produced a request with no `if-none-match`, even though the cache it was
   refreshing carried an `etag`. Codex stores the etag and does not use it.
2. **The server ignores the header when it is sent.** With the addon injecting
   `if-none-match: W/"5176fbef59264017aaa01fa3b4710c0a"` — byte-identical to the
   etag the server had just issued — the response was `200` with the full 359,965
   byte body, not `304`. `cache-control: private, no-store` is consistent with
   that.

So the conditional refresh saves nothing. A refresh layer is a 360 KB download
whether or not the catalogue changed.

## What this means for `subpixel`

Do not implement the refresh layer. The two layers that ship — the on-disk cache
and the bundled list — stay as they are.

The reasoning is no longer "the endpoint is unknown", it is that the layer buys
nothing it does not already have:

- `subpixel` drives `codex` for every generation, and `codex` refreshes
  `models_cache.json` itself on its own staleness check. The cache is warm for
  the same reason the tool works at all.
- Refreshing it ourselves would mean reading `tokens.access_token` out of
  `auth.json` to spend on a metadata call, which is a credential-handling path
  the tool currently does not need for anything but generation.
- The etag cannot make that call cheap, per the finding above.

`spx doctor` already tells the user to run any `codex` command when the cache is
stale. That advice is correct and remains the answer.

## Refreshing the catalogue

To re-derive the slugs and priorities that `BUNDLED_MODELS` pins — which is the only
part of this capture anyone maintaining `subpixel` needs — run `codex debug models`
and read the `visibility: "list"` descriptors out of the result. It is an ordinary
`codex` subcommand and needs no special setup.

Two notes if the command appears to do nothing. A run answers from
`models_cache.json` when `fetched_at` is under 24h old, and makes no request at all;
backdate it to force the fetch. And an isolated `CODEX_HOME` holding a copy of your
`auth.json` keeps the probe off your real cache — that copy is a live credential, so
put it under `mktemp -d` and remove it in a `trap` that fires on a kill as well as a
clean exit.

The header and `If-None-Match` observations above came from watching the transport
itself. That procedure is deliberately not written out here: it decrypts TLS to a
vendor's private endpoint with your own subscription credential, and nothing in this
repository needs it repeated. The findings it produced are recorded above and are the
part that mattered.
