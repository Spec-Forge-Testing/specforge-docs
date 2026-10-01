# Handshake and versioning

`hello` is the first request of every session. Any other operation before it is
refused `HANDSHAKE_REQUIRED`.

```json
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol_version":"0.1.5"}}
```

The response carries the protocol version, the server's identity, what this
build can do, and the whole operation catalog:

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocol_version":"0.1.5",
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

- **0.1.5** — Every reader of a run says the same thing under the same name.
  Breaking for a frontend that reads the renamed keys or relies on absences: an
  analysis's `repo_hash` is `generated_against_repo_hash` in `list_analyses`,
  `get_analysis` and `get_run`; in the report document an endpoint's
  `crash_count` is `findings_confirmed` and an unconfirmed finding's
  `occurrences` is `represented_findings`. A missing fact is `null`, never `""`:
  the report's `held_back_by` and `unprobed_reason`; in `get_run`, an endpoint's
  `load_profile` is a list of steps (`[]` when no concurrency ladder ran) and a
  crash's `transition_sequence` is `null` for a crash a stateless run found (a
  stateful crash keeps a list, `[]` on its first step), instead of `[]`.
  Added: a per-endpoint `truncation` (`{reason, detail}`) in `get_run` and the
  report; `run.oracle_scope`; coverage's `reached_by_transition` and
  `reached_by_transition_endpoints`. In `compare_runs`, each caveat carries
  `detail` beside `reason`, and `reason` is always a token of the
  [result vocabularies](vocabularies.md#caveats), with `oracle_scope_differs`
  and `safety_breached` new. A run that reached a route the safety guard held
  back is stored as `safety_breached`; the operation and its `finished` event
  answer `safety_breached`, and `run_pipeline`'s execution stage ends `failed`
  (`stopped` when cancelled), live and in the reply. The report document is
  `schema_version` 1.13.
- **0.1.4** — Additive: nothing is removed or renamed, but `hello` must say
  0.1.4. In `list_runs` and `get_run`, a run's `truncation` gains `detail` and
  `target_down_verdict`; in `get_run`, each endpoint gains `by_category` and
  `held_back_transitions`; in `get_run` and `get_finding`, an unconfirmed finding
  gains `body_fingerprint` (`""` means the response had no body). The report
  document is `schema_version` 1.12. `target_down`'s description names both ways
  a run concludes the API is down: a failed liveness probe, or every circuit
  breaker open.
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
