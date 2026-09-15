# Capture: the Codex `/models` endpoint

**Captured:** 2026-09-15, 19:32–19:38 UTC
**codex binary:** `codex-cli 0.154.0` (standalone, `x86_64-unknown-linux-musl`)
**Probe:** `codex debug models` run against an isolated `CODEX_HOME` holding only a
copy of `auth.json`, with `HTTPS_PROXY` pointed at a local `mitmdump` and
`SSL_CERT_FILE` set to a bundle of the system roots plus the mitmproxy CA.
**Addons:** one logged the request line and headers with every credential-shaped
header replaced by its length; a second injected `If-None-Match` into the
outgoing request so the server's conditional-request behaviour could be observed
without forging a request by hand.

This closes open item 1 of the design spec. `src/providers/models.ts` was written
against an inferred endpoint; this is what the endpoint actually is.

No token, refresh token, id token or account id appears here. The proxy addon
redacted `authorization`, `chatgpt-account-id`, `cookie` and `set-cookie` before
anything was written to disk.

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

The catalogue as returned:

| slug | visibility | priority | reasoning levels |
| --- | --- | --- | --- |
| `gpt-6-astra` | list | 1 | low, medium, high, xhigh, max, ultra |
| `gpt-reserve` | hide | 3 | low, medium, high, xhigh, max |
| `gpt-5.6-sol` | list | 4 | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-terra` | list | 7 | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-luna` | list | 8 | low, medium, high, xhigh, max |
| `gpt-5.5` | list | 12 | low, medium, high, xhigh |
| `codex-auto-review` | hide | 43 | low, medium, high, xhigh, max |

## Answers to the three questions the issue asked

**Pagination: none.** The response has exactly one top-level key, `models`. No
cursor, no `has_more`, no `Link` header. The CLI's own decoder agrees — the
binary carries `struct ModelsResponse with 1 element`.

**Deprecation: by omission, or by `visibility: "hide"`.** No `deprecated`,
`retired` or `sunset` field exists on any descriptor. `upgrade` is present and
`null` on every model; its populated shape was not observed, so nothing may be
inferred from it. A retired model simply stops appearing, which is what the
resolver's advance-and-warn recovery already assumes.

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

## Reproducing

```sh
# 1. mitmdump with a redacting addon on 127.0.0.1:8792
# 2. a CA bundle the Rust client will accept
cat /etc/ssl/certs/ca-certificates.crt ~/.mitmproxy/mitmproxy-ca-cert.pem > ca-bundle.pem
# 3. an isolated CODEX_HOME holding only a copy of auth.json, so the fetch is forced
env CODEX_HOME=./codexhome HTTPS_PROXY=http://127.0.0.1:8792 \
    SSL_CERT_FILE=./ca-bundle.pem codex debug models > catalogue.json
```

A second run needs `fetched_at` in `codexhome/models_cache.json` backdated past
24h, or the CLI answers from the cache and makes no request at all.
