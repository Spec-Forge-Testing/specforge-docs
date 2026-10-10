# Events and cancellation

Events are **core → client notifications**. There is **one method only**,
`progress`; the event's type travels inside as `kind`, a discriminated union.
Any language reads it without guessing, and adding an event never touches the
client's routing.

```json
{"jsonrpc":"2.0","method":"progress","params":{"token":"t7","kind":"started","operation":"analyze_endpoints","endpoints":19}}
```

## The progress token

The client sends `progress_token` in the request's `params`; the core echoes it
back as `token` in every notification for that operation. **Omitting the token
means "don't send me events"** — the core emits nothing, which is what machine
mode and CI use. The token is a client-chosen string, unique among the
operations in flight; a repeat is refused `INVALID_PARAMS`.

## State vs fact

The bottleneck is not the pipe, it is the UI. Hence a **semantic** distinction:

| Class | `kind` | Rule |
| --- | --- | --- |
| **State** | `tick` | A snapshot, not a log entry. **Absolute** counters, never increments; ceiling ~10/s. A slow client can **drop intermediate ticks without losing anything**. |
| **Fact** | everything else | Happens once and never repeats. All emitted, **never dropped, never batched**. |

There is never one event per HTTP request: there would be thousands per second,
none carrying information the counter does not already hold.

## The event catalog

The 16 kinds. Common to all: `token` and `kind`. `started` and `finished` also
carry `operation`, since a client watching several operations needs to know
which one framed the event.

| `kind` | Class | Own fields | When |
| --- | --- | --- | --- |
| `started` | fact | `operation`; on `fuzz`, `base_url`, `execution` and `strategy`; on `analyze_endpoints`, `endpoints` (int); on `replay`, `analysis_id`; on `get_run`, `run_id` | An operation begins |
| `finished` | fact | `operation`, `status` (`completed`, `cancelled`, `failed` or `safety_breached`; see [operation status](vocabularies.md#operation-status)), and operation-specific fields | An operation ends |
| `contract_started` | fact | `endpoint` (ref), `index`, `total` | The run starts producing one endpoint's contract |
| `contract_finished` | fact | `endpoint` (ref), `source` (`cache`, `model`, `fixture` or `absent`); with `model`, `input_tokens`, `output_tokens` (int) and `cost_usd` (number, absent when the model has no price) | The endpoint's contract is ready to fuzz with, or (`absent`) the endpoint runs schema-only |
| `contract_failed` | fact | `endpoint` (ref), `reason`, `disposition` (`schema_only`, `withheld` or `aborted`) | The endpoint's contract could not be produced or used |
| `endpoint_started` | fact | `endpoint` (ref), `index`, `total` | An endpoint begins |
| `phase_started` | fact | `endpoint` (ref), `phase` | A phase changes within the endpoint |
| `tick` | state | `elapsed_s` always; on `fuzz`, `sent`, `total` and `findings`; on `analyze_endpoints`, `resolved` and `failed` | Absolute counters, ≤10/s |
| `finding` | fact | `endpoint` (ref), `status`, `invariant`, `phase` | A finding is confirmed |
| `infra_failure` | fact | `endpoint` (ref), `reason`, `streak`, `limit` | A timeout or transport failure |
| `target_down` | fact | `base_url`, `reason` | The run concluded the API is down: a liveness probe failed, or every circuit breaker opened; `reason` says which |
| `truncated` | fact | `endpoint` (ref), `reason` | Cut short by budget |
| `endpoint_resolved` | fact | `endpoint` (ref) | An endpoint's static analysis resolved |
| `endpoint_failed` | fact | `endpoint`, `code`, `reason` | An endpoint's static analysis failed |
| `stage_started` | fact | `stage` | A pipeline stage begins |
| `stage_finished` | fact | `stage`, `status` (`completed`, `failed`, `skipped` or `stopped`; for the execution stage it follows the run: `failed` for a breached run, `stopped` for a cancelled one; see [stage status](vocabularies.md#stage-status)) | A pipeline stage ends |

`finding` speaks the report's own vocabulary — `endpoint`, `status`, `invariant`
and `phase` are exactly what identifies a defect in the persisted report — so a
frontend correlates what it watched live with what it reads back. There is no
`finding_id` or `severity`: an id exists only once a finding is persisted, and
no categorical severity exists anywhere in the product.

Which operation emits which kind is published in `capabilities.event_kinds` and,
per operation, in the catalog. Whether the engine emits `infra_failure` and
`target_down` at this granularity depends on the engine; the contract declares
them either way and `hello` says which ones this build actually emits.

## Contract production events { #contract-production }

A run with a producer produces every selected endpoint's contract before the
engine starts, so every `contract_*` event arrives before the first
`endpoint_started`. In `fuzz` they follow `started`; in `run_pipeline` they sit
between the `inference` stage's `stage_started` and `stage_finished`.

- `index` is the endpoint's 1-based position in the selection and `total` the
  selection's size. An endpoint the run cannot project at all gets no
  `contract_*` event, so a run may emit fewer `contract_started` than `total`.
- Several contracts are produced at once (option `inference.max_workers`):
  `contract_started` arrives in selection order, `contract_finished` and
  `contract_failed` as each endpoint ends. **Pair them by `endpoint`, never by
  order.**
- Every endpoint whose production started gets exactly one start and one end. A
  cancellation or an abort leaves the endpoints not yet started with no event.
- `disposition` says what the run does without the contract: fuzz the endpoint
  schema-only, withhold it (see
  [`producer_exclusions[].disposition`](vocabularies.md#producer-exclusion-disposition)),
  or stop (`aborted`: the operation then fails).
- These events do not add up to the run's spend: what a failed inference paid is
  only in `run.inference_cost.actual`.

## Cancellation

**One mechanism only: the `$/cancelRequest` notification**, carrying the `id` of
the request to cancel.

```json
{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":2}}
```

The cancelled operation ends in **its own response**, with `status:
"cancelled"`; there is no separate confirmation. **Cancelling an unknown,
already-finished or non-cancellable `id` is a silent no-op** — a notification
has no response to carry an error, and the race between cancellation and an
operation's end is normal. That harmlessness rests entirely on an `id` never
being reused.

A `$/cancelRequest` also reaches a request still **queued** because
`capabilities.max_in_flight` operations are already running (see
[capabilities](handshake.md#capabilities)).

**A cancelled operation keeps what it already produced.** The partial run is
returned *and* persisted, and a cancelled `run_pipeline` answers with the stages
that had already finished — cancelling is not losing.

**Cancelling while contracts are produced.** No new inference starts; the ones
already sent finish, are paid for, and are written to the inferred-contract
cache, and then the operation ends. There is no run to keep yet: `fuzz` answers
`cancelled` with no `run`, and `run_pipeline` marks its `inference` stage
`stopped`. The next run with the same inputs is served those contracts by the
cache at no cost; a project without a store has no cache. Two waits are not cut:
tracing the source before the first inference, and, under
`producer.max_cost_usd`, admitting the next inference while the ones in flight
settle — so a cancellation can take as long as the longest inference still
running.

In the shipped client,
Ctrl+C is translated into a cancellation, never a kill: a kill would leave the
core orphaned mid-run.
