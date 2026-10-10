# Handshake and versioning

`hello` is the first request of every session. Any other operation before it is
refused `HANDSHAKE_REQUIRED`.

```json
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol_version":"0.1.12"}}
```

The response carries the protocol version, the server's identity, what this
build can do, and the whole operation catalog:

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocol_version":"0.1.12",
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
| `max_in_flight` | int or null | Concurrent operations allowed: the size of the core's worker pool, `8`. A ninth request waits in the queue until a worker frees, and a `$/cancelRequest` reaches it there. `null` would mean no ceiling |
| `payload` | object | `inline_max_bytes`, `file_handoff` (bool), `pagination` (bool) |

The whole handshake is **derived, not declared**: `event_kinds` is exactly what
the build's operations emit, `cancellation` is true when any operation reads a
cancellation token, and the catalog is the same one `describe` publishes.

## Versioning { #versioning }

**The core serves a range within its own series.** A client is served when its
`protocol_version` has the core's `major.minor` and a patch between a declared
floor and the core's own. Each part compares as a number, never as text:
`0.1.10` is newer than `0.1.9`. This core speaks `0.1.12` and serves `0.1.5` up
to `0.1.12`. It always answers `hello` with its own version, and a frontend
ignores the keys it does not know.

Anything else — another series, a patch outside the range, or a
`protocol_version` that is not `major.minor.patch` — is refused
`PROTOCOL_VERSION_MISMATCH`. Its `data` carries `expected` (the core's version),
`oldest` (the floor) and `received` (what the client sent); its message names
the range served. The frontend aborts.

**How a version moves.** An additive change — a new operation, an optional
parameter, a result field, an event kind, an error code — bumps the patch. A
breaking change — a rename, a removal, a type change, a parameter made required
— bumps the minor.

**Why there is a floor.** `0.1.5` renamed keys inside the `0.1` series, so no
client older than `0.1.5` reads this core's replies correctly. When the minor
moves, the floor returns to `.0`. See [ADR-094](../adr/protocol.md#adr-094).

## Lifecycle { #lifecycle }

The frontend launches the core, does the handshake, works, and on exit sends
`shutdown` and waits for its answer.

- **`shutdown` drains.** The core cancels every operation still running — each
  answers on its own, exactly as after a
  [`$/cancelRequest`](events.md#cancellation) — waits for them to settle, then
  answers `{"ok": true}` last and exits without reading another line. The answer
  is the signal that the pipe can be dropped.
- **EOF cancels the same way.** If the frontend dies without warning, or closes
  stdin right after its last request, the core detects **EOF on stdin**,
  cancels what is still running, waits, and exits on its own. A script piped
  into the core keeps stdin open until its answers have arrived; closing it
  early cancels what has not finished.
- **What cannot be cancelled runs to its end.** An operation whose catalog
  entry says `cancellable: false` (`load_contract`, `diagnose`, `get_run`,
  `apply_fix_plan`, …) still running at that point completes before `ok`
  arrives.

`hello` and `shutdown` are requests like any other — each carries an `id` and
gets its own response — but neither is a catalog operation, so `describe` lists
neither. See [ADR-095](../adr/protocol.md#adr-095).

## Changelog

The report document that `fuzz`, `replay` and `run_pipeline` answer with is
`schema_version` 1.17. The protocol's own README holds the full entry for each
version; the lines below are the summary.

- **0.1.12** — The catalog says what an operation needs and what it destroys.
  Additive. `requires: "analysis"` on `get_static_analysis`,
  `get_endpoint_static_analysis` and `get_llm_payload`; `destructive` on every
  operation, `true` on `apply_fix_plan` and `apply_prune_plan`. `shutdown` and
  EOF cancel, wait and exit; `max_in_flight` is `8`, and `$/cancelRequest`
  reaches a queued request. `run_pipeline`'s `contract` stage runs the session's
  loaded contract. `specforge.toml`'s `engine.*` values reach a run, checked like
  a request's; `engine.headers` refuses credential headers.
- **0.1.11** — A run shows, and can cancel, the production of its contracts,
  several endpoints at once. Additive. `contract_started`, `contract_finished`
  and `contract_failed` on `fuzz` and `run_pipeline`; `run.production_duration_ms`;
  option `inference.max_workers` (`1` to `16`, default `4`); `minimum` and
  `maximum` on `get_config` rows. `producer.max_cost_usd` is checked as each
  inference is admitted. The report document is `schema_version` 1.17.
- **0.1.10** — An `auth` run degrades per endpoint. Additive. Four
  `unprobed_reason` values (`owner_producer_missing`, `owner_chain_cyclic`,
  `owner_resource_unprovisioned`, `required_role_unheld`) and the signal cause
  `access_preconditions_unmet`; the run fails `EXECUTION_FAILED` only when no
  endpoint with a policy to cross could be crossed. A stateful run counts its
  shrink requests in `requests_shrink`. Nested resources link to their parent's
  bundle, and `minimal_payload` redacts the built-in credential names.
- **0.1.9** — The safety guard holds every spelling of a vetoed route and says
  who caused each hold. Additive on the wire, with one refusal: a `replay` of a
  recording made with `allow_side_effects`, or one that breached the guard,
  needs `allow_side_effects` (`SIDE_EFFECTS_CONSENT_REQUIRED`). `held_back_via`
  on each endpoint; `disposition` (`schema_only` or `withheld`) on each
  `producer_exclusions` entry. The report document is `schema_version` 1.16.
- **0.1.8** — `run_pipeline` produces its contracts once, in its `inference`
  stage, and `execution` runs what that stage produced; a refusal met before the
  engine fails the `inference` stage. Additive. `repo_root` on `run_pipeline`;
  `name`, `openapi_spec` and `base_url` on `init_project`, whose result carries
  `settings` and `spec_found`. A relative `producer.source_repo`,
  `producer.contracts_dir` or `identities_path` resolves against the project
  root.
- **0.1.7** — Inference cost is estimated, approved by token, and capped.
  Additive. `estimate_inference`, which calls no model; `producer.approval_token`
  and `INFERENCE_APPROVAL_REQUIRED`; `producer.max_cost_usd`; `data` on a failed
  `run_pipeline` stage; `run.inference_cost` (`{estimated, actual}`); option
  `inference.require_approval` (default `true`). The report document is
  `schema_version` 1.15.
- **0.1.6** — `hello` negotiates within the series from the floor `0.1.5`; an
  additive change bumps the patch and a breaking one the minor.
  `PROTOCOL_VERSION_MISMATCH` carries `oldest`. Additive. `producer.refresh` on
  `fuzz` and `run_pipeline`; an `inference` run whose store did not open is
  refused `CONTRACT_PRODUCER_FAILED`; `run.contract_cache` (`{hits, misses}`).
  The report document is `schema_version` 1.14.
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
  uses, so live findings correlate with the report. `endpoint_ref.number` becomes
  optional in events (a reload can leave an event about an endpoint the catalog
  does not number). The server also matches the contract where it did not:
  `target_down` carries `reason`, an operation sends a single `started`, and
  `endpoint_failed` carries the closed `code` plus a human `reason` instead of a
  class name.
- **0.1.2** — The contract catches up with what the server does. Breaking for a
  frontend that reads stages or the payload: `started`/`finished` carry
  `operation`; the stage vocabulary is `contract` / `static_analysis` /
  `inference` / `execution`; a stage ends `completed` / `failed` / `skipped` /
  `stopped`. `get_llm_payload` answers an `LlmPayload` with a `delivery`
  discriminant rather than always a file path. A cancelled run keeps and
  persists its evidence, so its document is not null and a cancelled
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
