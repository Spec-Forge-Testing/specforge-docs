# Handshake and versioning

`hello` is the first request of every session. Any other operation before it is
refused `HANDSHAKE_REQUIRED`.

```json
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol_version":"0.1.3"}}
```

The response carries the protocol version, the server's identity, what this
build can do, and the whole operation catalog:

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocol_version":"0.1.3",
  "server":{"name":"specforge-core","version":"…","frozen":false},
  "capabilities":{…},
  "catalog":{…}
}}
```

## Capabilities

| Field | Type | Declares |
| --- | --- | --- |
| `events` | bool | The core emits progress notifications |
| `event_kinds` | list of strings | The `kind`s **this build actually emits** — where `infra_failure` and `target_down` show up or not, depending on the engine |
| `cancellation` | bool | The core honors `$/cancelRequest` |
| `max_in_flight` | int or null | Concurrent operations allowed; `null` = no ceiling |
| `payload` | object | `inline_max_bytes`, `file_handoff` (bool), `pagination` (bool) |

The whole handshake is **derived, not declared**: `event_kinds` is exactly what
the build's operations emit, `cancellation` is true when any operation reads a
cancellation token, and the catalog is the same one `describe` publishes.

## Versioning by exact equality

**There is no backward compatibility to promise.** Every frontend ships with
its own core inside, so the two can never drift out of sync. The handshake stays
as a **sanity check**: if `hello`'s `protocol_version` is not **exactly** the
core's, the core answers `PROTOCOL_VERSION_MISMATCH` and the frontend aborts —
no negotiation, no degradation. What makes this safe is never offering the
option to point at an external core.

**Lifecycle.** The frontend launches the core, does the handshake, works, and on
exit sends `shutdown` and waits. If the frontend dies without warning, the core
detects **EOF on stdin** and exits on its own.

## Changelog

- **0.1.3** — `finding` catches up with what the engine knows while a run is in
  flight. Breaking for a frontend that reads `finding`: `finding_id` and
  `severity` are gone (neither has an honest source before a run is persisted),
  and `invariant` and `phase` arrive — the same vocabulary the persisted defect
  uses, so live findings correlate with the report. `endpoint_ref.number` is now
  optional in events (a reload can leave an event about an endpoint the catalog
  no longer numbers). The server also matches the contract where it did not:
  `target_down` carries `reason`, an operation sends a single `started`, and
  `endpoint_failed` carries the closed `code` plus a human `reason` instead of a
  class name.
- **0.1.2** — The contract catches up with what the server does. Breaking for a
  frontend that reads stages or the payload: `started`/`finished` carry
  `operation`; the stage vocabulary is `contract` / `static_analysis` /
  `inference` / `execution`; a stage ends `completed` / `failed` / `skipped` /
  `stopped`. `get_llm_payload` answers an `LlmPayload` with a `delivery`
  discriminant rather than always a file path. A cancelled run keeps and
  persists its evidence, so its document is no longer null and a cancelled
  `run_pipeline` answers with the stages already finished. Two new operations
  (`apply_prune_plan`, `apply_fix_plan`), a `requires` field on every operation,
  `deadline_ms` on `fuzz`/`run_pipeline`, and five new error codes. Parameters
  are coerced and validated, so a wrong type or an out-of-vocabulary enum answers
  `INVALID_PARAMS` instead of leaking an `INTERNAL_ERROR`.
- **0.1.1** — Three holes in the validator closed (a `progress` envelope was
  never validated; a token-less notification crashed instead of reporting;
  nothing checked an emitted `kind` against `capabilities.event_kinds`). Adds
  `fixtures/invalid/`. Contract hole closed: an `id` is never reused within a
  session.
- **0.1.0** — First version: framing, message shapes, the progress token, the
  event catalog, cancellation, the handshake, errors, endpoint reference and
  payload policy. Events are one method with a union by `kind` (the counter is
  `tick`); cancellation is `$/cancelRequest` only; the payload threshold is read
  from the handshake.
