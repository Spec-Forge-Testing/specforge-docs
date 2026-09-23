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

The 13 kinds. Common to all: `token` and `kind`. `started` and `finished` also
carry `operation`, since a client watching several operations needs to know
which one framed the event.

| `kind` | Class | Own fields | When |
| --- | --- | --- | --- |
| `started` | fact | `operation` (+ operation-specific fields) | An operation begins |
| `finished` | fact | `operation`, `status`, and operation-specific fields | An operation ends |
| `endpoint_started` | fact | `endpoint` (ref), `index`, `total` | An endpoint begins |
| `phase_started` | fact | `endpoint` (ref), `phase` | A phase changes within the endpoint |
| `tick` | state | `elapsed_s` always; other counters optional | Absolute counters, ≤10/s |
| `finding` | fact | `endpoint` (ref), `status`, `invariant`, `phase` | A finding is confirmed |
| `infra_failure` | fact | `endpoint` (ref), `reason`, `streak`, `limit` | A timeout or transport failure |
| `target_down` | fact | `base_url`, `reason` | The liveness probe ruled the API down |
| `truncated` | fact | `endpoint` (ref), `reason` | Cut short by budget |
| `endpoint_resolved` | fact | `endpoint` (ref) | An endpoint's static analysis resolved |
| `endpoint_failed` | fact | `endpoint`, `code`, `reason` | An endpoint's static analysis failed |
| `stage_started` | fact | `stage` | A pipeline stage begins |
| `stage_finished` | fact | `stage`, `status` | A pipeline stage ends |

`finding` speaks the report's own vocabulary — `endpoint`, `status`, `invariant`
and `phase` are exactly what identifies a defect in the persisted report — so a
frontend correlates what it watched live with what it reads back. There is no
`finding_id` or `severity`: an id exists only once a finding is persisted, and
no categorical severity exists anywhere in the product.

Which operation emits which kind is published in `capabilities.event_kinds` and,
per operation, in the catalog. Whether the engine emits `infra_failure` and
`target_down` at this granularity depends on the engine; the contract declares
them either way and `hello` says which ones this build actually emits.

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

**A cancelled operation keeps what it already produced.** The partial run is
returned *and* persisted, and a cancelled `run_pipeline` answers with the stages
that had already finished — cancelling is not losing. In the shipped client,
Ctrl+C is translated into a cancellation, never a kill: a kill would leave the
core orphaned mid-run.
