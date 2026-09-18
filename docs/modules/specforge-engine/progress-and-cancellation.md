# Progress and cancellation

`run` takes two optional signals a caller may wire in: a **cancellation token**
to stop a run cooperatively, and an **observer** to watch it while it goes. Both
are keyword-only, both default to a Null Object, and both are inert when unset —
a run nobody stops and nobody watches pays nothing for either.

```python
result = run(engine_input, config, mode=ExecutionMode.STATELESS,
             cancellation=source.token, observer=my_observer)
```

The engine owns both shapes and imports nothing from the core↔frontend protocol
the CLI speaks. The events it emits carry only what it knows; a listener adapts
them to the wire ([below](#adapting-to-the-protocol)). This keeps the engine a
black box with no dependency on how a frontend renders it
([ADR-062](adr/engine.md#adr-062)).

## Cancellation

### Wiring it

A caller holds a `CancellationSource` and passes its `.token` to `run`:

```python
source = CancellationSource()
# on another thread, when the user asks to stop:
source.cancel()
```

The split is deliberate. The **source** is the write side — the only object that
can `cancel()` — and the caller keeps it. The **token** is the read side, a
`CancellationToken`: a Protocol with a single read-only `cancelled` property that
**never raises**. The run only ever reads its token; it cannot cancel itself, and
the observer cannot cancel the run. `cancel()` is idempotent — calling it more
than once is safe. Omitting `cancellation` passes `NULL_TOKEN`, whose `cancelled`
is permanently `False`: the default for a run nobody can stop.

`CancellationSource` is backed by a `threading.Event`, so the caller cancels from
any thread — a signal handler, a UI thread, a watchdog — while the run reads the
flag on its own thread.

### Where the engine reads it

The token is polled **between units of work**, never in the middle of one. A unit
already on the wire always finishes; the run stops before starting the next. Each
mode has its own natural boundaries:

| Boundary | Modes | On cancel |
|---|---|---|
| Between endpoints | stateless, performance, resilience, auth | the next endpoint is not started |
| Between generation passes and between drawn examples | stateless, performance | the current endpoint stops at the pass or batch boundary |
| Between ladder steps | performance | the endpoint's ladder ends at the completed steps |
| Before each stateful step and between stateful passes | stateful | the pass in flight stops sending at the mark, then the supervisor loop stops before the next pass |
| Before each replayed request | replay | the trace stops at the requests sent so far |
| Before the shrinker's next send | stateless, performance | the finding under minimization is left unverified |

Two waits would otherwise stall a prompt stop, so both are **chunked**: the HTTP
retry backoff (`runtime/http/orchestrator.py`) and the replay pacer's inter-request
sleep (`runtime/replay/pacing.py`) both sleep through `wait_chunks`, which breaks a
delay into steps of at most `CANCELLATION_POLL_INTERVAL_S` (0.05 s) and ends the
moment the token is cancelled. A cancelled run therefore wakes within that window
rather than at the end of a full backoff. A backoff interrupted this way never
triggers another attempt: the last attempt's result is returned as-is, in flight
but unretried.

### Cancellation is a value, never an exception

A seen cancellation becomes a `TruncationRecord` with reason `cancelled`, carried
back on the run's trace like any other cut — it is never thrown across the engine.
Inside stateless exploration the cut is **sticky**: `mark_cancelled` sets it only
if no earlier cut is already in place, so a deadline or a target-down cut that came
first keeps its own, more specific reason. At the shrinker's send point the same
check is a hard gate — a shrink search cancelled before its next request abandons
that finding rather than confirming it. In the stateful mode the collector gates
**every** send on the token, so a pass in flight stops sending at the mark rather
than running to the pass boundary — against a dead target that turns a full
per-step timeout into nothing. The liveness probe obeys the same rule everywhere:
both stateless failure streaks read the token before probing and cut with
`cancelled` instead, a replay skips its liveness check once cancelled, and a
stateful streak completed by the request in flight never probes once the run is
cancelled — a cancelled run never sends the probe. The shared
`TargetLivenessMonitor` also **abandons a probe already in flight**: it runs the
`HEAD` as a task and races it against the token, so a cancellation landing while a
probe is outstanding drops that probe and yields no verdict rather than holding the
run for the probe's full timeout. A cancelled run therefore neither sends a new
probe nor waits out one in flight.

### What a cancelled run returns

A cancelled run returns a complete, honest `EngineRunResult`:

- `status` is `RunStatus.CANCELLED` — a distinct terminal outcome, separate from
  `completed`, `truncated` and `aborted`. It says the **caller** asked to stop; it
  makes no claim about the API, which may be perfectly healthy.
- The trace carries a `TruncationRecord` whose `reason` is `cancelled` and whose
  `endpoint_id` is the endpoint the run stopped at. `requests_sent` counts only
  what was actually sent for that endpoint — zero when the cut fell on the boundary
  before it started.
- No request is sent after the mark. Everything already on the wire stays in the
  record; nothing new is generated, paced or shrunk.
- Findings a cancelled run has not confirmed are counted **unverified**, one
  `UnverifiedFinding` per signature, rather than spending requests shrinking them —
  a run the caller has abandoned cannot afford to confirm anything. A stateful run,
  which confirms each defect as it goes, keeps the reports it had already settled;
  a defect it was still confirming when the mark landed is reported **flaky**,
  because the state machine's replay of it no longer sends — the same fact under
  the name that mode has for it.
- The shared HTTP client is closed on the way out, cancelled or not.

The engine **persists nothing** — a cancelled result is returned to the caller,
which decides whether to keep it.

### Precedence: cancellation outranks a budget cut, not a dead target

When more than one reason to stop is present, the ranking is fixed. A cancellation
seen between endpoints, or after exploration finishes, **outranks** a soft budget
or deadline cut already recorded — the caller's intent wins over a partial run's
own truncation. A cancellation arriving during the last stateful pass is sealed
`cancelled` too, and the resilience and auth runners seal it the same way: each
reads the token only at the *next* endpoint, so a shared post-loop seal
(`seal_cancellation`) catches a cancellation that lands while the last endpoint's
batch was still in flight, which would otherwise be lost and the run reported
`completed`. But a cancellation does **not** outrank a confirmed dead target: a
stateless liveness probe, a stateful run whose run-wide liveness probe confirmed
it, a stateful run whose circuit breakers all opened, or a resilience or auth run
whose per-batch watch confirmed it has established the API is down, and that
verdict (`aborted`, reason `target_down`) stands over a cancellation that arrived
alongside it — the dead target already stopped the run. A dead target is a fact
about the world; a cancellation is a fact about the caller, and the world wins.

## The observer

### Wiring it

A caller passes any object satisfying the `RunObserver` Protocol — a single method
`on_event(event: RunEvent) -> None` — as `observer=`. Omitting it passes
`NULL_OBSERVER`, which swallows every event. When no observer is supplied the
engine builds no emitter and computes no counters at all: watching is
**zero-cost** when nobody is listening.

```python
class Printer:
    def on_event(self, event: RunEvent) -> None:
        print(event.kind, event)

run(engine_input, config, observer=Printer())
```

### The events

A run emits a closed set of nine events, each a frozen value object carrying a
`kind` — an `EventKind` member — that discriminates the union `RunEvent`. A
listener switches on `kind` and never guesses a type:

| Event | `kind` | Fields | Meaning |
|---|---|---|---|
| `RunStarted` | `started` | `endpoints` | The run began fuzzing this many endpoints, after the safety guard held any back. |
| `EndpointStarted` | `endpoint_started` | `endpoint_id`, `index`, `total` | Exploration of one endpoint began; `index` is 1-based. |
| `PhaseStarted` | `phase_started` | `endpoint_id`, `phase` | The endpoint moved on to a new generation phase. |
| `ProgressTick` | `tick` | `elapsed_s`, `sent`, `total`, `findings` | A snapshot of the run's absolute counters. |
| `FindingObserved` | `finding` | `endpoint_id`, `status_code`, `invariant`, `phase` | A response broke an invariant. |
| `InfraFailure` | `infra_failure` | `endpoint_id`, `reason`, `streak`, `limit` | A transport failure advanced an endpoint's infrastructure streak. |
| `TargetDown` | `target_down` | `base_url`, `verdict` | The run concluded the target itself is down. |
| `RunTruncated` | `truncated` | `endpoint_id`, `reason` | One endpoint's exploration was cut short before its plan was exhausted. |
| `RunFinished` | `finished` | `status` | The run reached its terminal `RunStatus`. |

`FindingObserved` is a *raw* observation: in stateless and performance it is
emitted for each finding once shrinking has confirmed it, so it is unconfirmed
until then; in stateful it fires the moment a defect is confirmed. `TargetDown`
carries a `TargetDownVerdict` naming how the run decided —
`LIVENESS_PROBE_FAILED` (a `HEAD` probe confirmed it: stateless, replay, the
stateful run's own run-wide probe, or the resilience and auth runners' per-batch
watch) or `CIRCUIT_BREAKERS_OPEN` (a reachable base URL whose stateful rule
endpoints all broke — a gateway up with its backends down). `CIRCUIT_BREAKERS_OPEN`
is the stateful mode's alone: resilience and auth have no per-endpoint breakers, so
they always report `LIVENESS_PROBE_FAILED`.
`RunFinished` is always the last event, and `RunTruncated` precedes it only for a
cut local to one endpoint — a run that halted outright (`target_down`,
`cancelled`) reports its reason through the final status instead.

### State versus fact

The events split into two classes, and the split is semantic, not about volume:

| Class | Events | Rule |
|---|---|---|
| **State** | `tick` | A snapshot with **absolute** counters, never increments. It is throttled to at most one every `MIN_TICK_INTERVAL_S` (0.1 s, about ten a second) — the `ProgressEmitter` drops a tick that falls inside the window. Because each tick carries the whole state, a slow listener can drop the intermediate ones without losing anything. |
| **Fact** | every other event | Happens once and never repeats. Facts are **always** emitted, never throttled and never dropped. |

The tick's three counters are accumulated by the emitter as the run reports them:
`sent` is the orchestrator's live wire-request count, `total` is the sum of the
example budgets the run has planned so far, and `findings` counts raw findings as
they are observed. `total` is `0` for a mode that plans no example budget, as
every stateful tick is.

### What each mode emits

Not every mode reaches every boundary, so the set of events differs by mode.
`started` and `finished` bracket every run:

| Event | stateless | performance | stateful | replay | resilience | auth |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| `started` | ● | ● | ● | ● | ● | ● |
| `endpoint_started` | ● | ● | | | ● | ● |
| `phase_started` | ● | ● | | | | |
| `tick` | ● | ● | ● | ● | | |
| `finding` | ● | ● | ● | | ● | ● |
| `infra_failure` | ● | ● | ● | ● | | |
| `target_down` | ● | ● | ● | ● | ● | ● |
| `truncated` | ● | ● | ● | ● | | |
| `finished` | ● | ● | ● | ● | ● | ● |

Replay emits no `finding` — it evaluates only for a dead target, never contracts —
and its `started` reports the endpoints partitioned for the run, which a
trace-only caller leaves empty. Resilience and auth never `tick` (each endpoint is
one deterministic exchange, so a counter adds nothing) and never `truncated`: they
stop on a cancellation or a confirmed dead target, and both halt the run outright
and report through the final status rather than a per-endpoint `truncated` event —
a confirmed dead target also emitting one `target_down` first. Stateful
never announces an endpoint or a phase: it drives a sequence, not one endpoint at a
time, and its `tick` always carries `total` of `0`.

### Threading and cost

Events are emitted **synchronously, on the caller's own thread**, at the run's
folding boundaries — where results are already being reduced sequentially. HTTP
requests run concurrently on the engine's internal event loop, but folding is
serial, so the observer is called from one thread and needs no locking of its own.

There is deliberately **never a distinct event per HTTP request**: a batch of
concurrent requests folds into a single `tick`, and at thousands of requests a
second a per-request event would carry nothing the counter does not already hold.
The stateless runner also ticks once per shrink attempt, so the counter keeps
moving while findings are being minimised. A stateful run ticks on every executed
step and every transition probe, on top of its per-pass tick, so a long sequence's
counter tracks work instead of freezing between passes; and replay ticks once per
replayed request. In every case the underlying advance is bounded by the emitter:
`MIN_TICK_INTERVAL_S` collapses ticks inside its window, so neither a fast replay
nor a long stateful sequence floods the listener.

An observer's `on_event` runs inline in the run: it should be cheap and must not
raise. Anything expensive — rendering, disk, network — belongs on the listener's
own side, off the run's thread.

## Adapting to the protocol

The engine's events are plain in-process value objects; the CLI translates them to
the core↔frontend protocol at its own boundary. A listener registered as the run's
observer maps each `RunEvent` to a `progress` notification whose `kind` matches the
event's, and fills in the fields the engine deliberately does not know:

- **Endpoint numbers.** The engine names an endpoint by its canonical
  `"{METHOD}:{path}"` id; the short integer a person types is assigned and tracked
  by the listener, not the engine.
- **Finding ids and severity.** `FindingObserved` reports the endpoint, status,
  invariant and phase of a raw observation. The stable finding id and the severity
  the frontend paints are the listener's to derive from the settled result.
- **The wire status.** `RunFinished.status` is a `RunStatus`; the protocol's
  `finished` event narrows it to the values a frontend acts on — a `cancelled` run
  maps to `cancelled`, an `aborted` one to `failed`.
- **The subscription.** A caller that supplies no progress token gets no observer,
  and the engine emits nothing — the same zero-cost path a machine-mode run takes.

Because the mapping lives entirely on the listener, adding an event to the engine
never reaches into the protocol's routing, and the engine stays free of any
knowledge of how it is displayed.
