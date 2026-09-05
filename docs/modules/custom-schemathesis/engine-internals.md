# Engine internals

`engine/` executes a compiled `EngineInput` against a live API and turns what
comes back into findings, statistics and a replayable trace. It is the deep
machinery the [runners](execution-modes.md) drive: an HTTP transport, the
Hypothesis harness, the response oracles, the finding pipeline, the two
fuzzers, and the trace and replay layers. This page follows those layers in the
order a request travels through them.

The [modes page](execution-modes.md) covers the runners and how they compose
these layers; this page is the layers themselves.

## HTTP transport

`engine/http/` owns everything the wire needs. One `AsyncOrchestrator` is
opened for a whole run — a single `httpx.AsyncClient`, a concurrency
`asyncio.Semaphore(max_concurrency)`, and a retry policy — and every request of
the run passes through it.

`execute(blueprint)` sends one request through the retry wrapper;
`send_chaos(blueprint, content, extra_headers)` sends one deliberately broken
attempt with no retry; `probe_liveness()` sends a single retry-free `HEAD` to
`base_url` to tell a live target from a dead one. `wire_requests` counts the
attempts that reached the wire — each retry counts, a refused request does not —
so a runner can price a phase by difference.

**Retries cover only transient infrastructure faults.** A response with status
`429`, `502` or `503`, or an `httpx.ConnectTimeout`, is retried up to
`max_retries` times; the backoff is exponential (`2**attempt * backoff_base`)
with jitter, capped at `MAX_BACKOFF_S`, and it is slept **outside** the
concurrency slot so a waiting retry frees its slot for other work. Every other
transport error is returned on the first attempt: a 4xx or 5xx is the API's
answer, not a fault to paper over, and a malformed URL will never succeed.

`error_classifier.py` maps outcomes to an `ErrorCategory`. `classify_response`
turns a status into `SERVER_ERROR` / `CLIENT_ERROR` / `None` (a clean 2xx/3xx);
`classify_exception` walks `type(exc).__mro__` against a small table so a
transport exception resolves to the nearest matching category — a subclass need
not be listed to be classified.

### From payload to request: `ContextInjector`

`ContextInjector.build` turns a `ZonedPayload`, a compiled endpoint, the run
config and an optional `Identity` into an immutable `RequestBlueprint`. It:

- **interpolates the path** by percent-encoding each path value
  (`quote(..., safe="")`) and recording which segments the template actually
  consumed;
- **layers headers** in three coats, each overriding the one below it —
  config headers, then the identity's credential headers
  (`merge_credential_layer`, case-insensitive, the identity winning), then the
  fuzzer's generated headers on top — and records the credential header *names*
  in `config_header_names` so their values are never persisted;
- **sets the content type** from the endpoint's first declared `content_type`
  when a body is present and nothing already set one;
- **flags an unsendable request** when a percent-encoded path segment is one
  URL normalization would strip (`""`, `"."`, `".."`), because a request whose
  path silently re-routes tests nothing. The blueprint carries an
  `unsendable_reason` and the orchestrator refuses it rather than send it.

The identity's `label` rides on the blueprint — unless a generated header
overrode one of the identity's own, in which case the request does not speak
for that identity and the label is dropped.

## The zoned payload

`ZonedPayload` is the value object a strategy draws and the injector reads: the
values for one request, keyed by `Zone` (`path`, `query`, `header`, `body`),
plus the `Phase` they were drawn for. It is frozen; `with_field` returns a copy
with one field written, never mutating the original
([ADR-033](adr/engine.md#adr-033)).

Its `body` has **three** states, and the type keeps them apart with a private
`_NO_BODY` sentinel: absent (no body zone at all), an explicit `None` (a body
drawn as JSON `null`), and a value. `has_body` is true for the last two.
`from_mapping` builds one from the zone-keyed dict Hypothesis draws;
`as_mapping` renders it back, omitting empty zones and an absent body.

## The Hypothesis harness

`engine/harness/` is the seam between Hypothesis's synchronous callbacks and the
engine's async HTTP. There is exactly one event loop for the whole process,
started eagerly in a daemon thread when `harness/bridge` is imported; `run_sync`
hands a coroutine to it and blocks for the result. Every async call the fuzzers
make — one request, a whole batch, a liveness probe — goes through that one
loop, so the single `AsyncClient` is only ever touched from one thread.

Three `settings` presets shape every Hypothesis search, and all three share the
non-negotiables: **no deadline** (a real HTTP call under load must not trip
Hypothesis's timer), **no example database** (a run is reproduced by replaying
its trace, not by a local corpus), and the `too_slow` / `filter_too_much`
health checks suppressed.

| Preset | For | Also sets |
|---|---|---|
| `exploration_settings(max_examples)` | one endpoint-phase pass | phases restricted to `explicit` + `generate` |
| `shrink_settings()` | one finding's minimization | a fixed shrink example cap |
| `stateful_settings(options, reserved_steps)` | one state-machine pass | `stateful_step_count`, `report_multiple_bugs=False` |

`identity_strategy(identities)` is `st.sampled_from` over the declared
identities — the one place a run draws which caller a request is sent under.

## Response oracles

`engine/oracles/` judges one response. Oracles form an **ordered pipeline**, a
Chain of Responsibility, not a keyed lookup. Each satisfies the `ResponseOracle`
Protocol — a `name`, an `order: OraclePrecedence`, and `check(context) ->
OracleVerdict` — and precedence is a named `IntEnum` value, never a magic gap
([ADR-036](adr/engine.md#adr-036)):

| Precedence | Oracle `name` | Fires on |
|---|---|---|
| `INFRA` (10) | `infra` | an infrastructure failure — suppresses everything below it |
| `RESILIENCE` (15) | `resilience_degradation` | a 5xx under a chaos request |
| `SERVER_ERROR` (20) | `server_error` | any 5xx |
| `STATUS_CODE` (30) | `status_code` | a status no response contract declared |
| `CONTENT_TYPE` (40) | `content_type` | a body whose `Content-Type` misses the declared one |
| `SCHEMA` (50) | `schema` | a body that fails the declared schema |
| `LATENCY` (60) | `latency_sla` | a clean 2xx/3xx slower than the run's SLA |

`evaluate` runs them in `(order, name)` order, accumulating each `OracleVerdict`'s
violation and stopping at the first `terminal` one. `check_response(result,
endpoint, latency_sla_ms=, is_chaos=)` builds the `ResponseContext` — resolving
the endpoint's response contract for the status by exact code → status class →
`default`, once, for the whole pipeline — and evaluates it;
`evaluate_contract_free(result)` evaluates against no contract, which is what a
replay and a transition probe use.

All seven built-ins are registered explicitly by `register_builtin_oracles`,
never as a side effect of importing a runner, so the registered set is one
readable function. `validate_value(value, contract)` structurally checks a
response body against a strategy-contract shape through a `SchemaType`-keyed
table of checkers — a missing type is a lookup miss, not a silent pass.

## The finding pipeline

`engine/findings/` turns raw findings into deduplicated crash reports, the
public finding union and the run's statistics. A finding's life runs signature →
group → shrink → materialize → dedupe → assemble → stats.

- **Signature.** `signature_of` builds a `FindingSignature` from what the
  failure looks like from the outside: endpoint, phase, primary violation,
  status code, identity label, and a *fingerprint of the body's shape* — never
  its values (an object becomes its keys mapped to JSON type names; free text
  is lowercased with digit runs masked). `group_findings` collapses findings
  that share a signature, in first-seen order.
- **Shrink.** `shrink_groups` attempts at most two representatives per signature
  (`MAX_REPRESENTATIVES_PER_SIGNATURE`). The first faithful reproducer stands
  for the group's untouched members (counted `collapsed`); a member that was
  never attempted counts `unverified`; one whose shrink did not reproduce counts
  `flaky` — **measured here, where it is observed, never derived by
  subtraction** ([ADR-018](adr/engine.md#adr-018)).
- **Materialize.** `build_crash_report` is the single assembler of a
  `CrashReport`, from a `FindingFacts` — the source-agnostic subject of a report
  — plus the request and result. Redaction happens here and nowhere else:
  sensitive headers and payload fields are replaced with a placeholder.
  `materialize_report` is the no-shrink path, used by the modes that never
  minimize ([ADR-037](adr/engine.md#adr-037)).
- **Dedupe.** `dedupe_crash_reports` keeps one report per `ReportKey` — method,
  endpoint, invariant, status, identity and the canonical reproducer, phase
  deliberately excluded — and folds every duplicate's `represented_findings`
  into the one it kept.
- **Assemble.** `assemble_findings` reifies the outcomes as the closed `Finding`
  union `EngineRunResult.findings` carries: one `ConfirmedFinding` per
  deduplicated report, then the shrinker's own `FlakyFinding`s and
  `UnverifiedFinding`s — each an entry per signature carrying the raw
  `occurrences` it stands for. The counters stay the measurement; the union
  reifies them ([ADR-044](adr/engine.md#adr-044)).
- **Stats.** Four builders, one per lifecycle — `build_stats` (stateless),
  `build_stateful_stats`, `build_unshrunk_stats` (performance, resilience) and
  `build_replay_stats` — all start from the shared `RequestBreakdown`:
  per-endpoint request counts and latency, plus the run's `by_phase` and
  `by_category` totals. Latency percentiles are **nearest-rank** (P50/P95/P99):
  always an observed sample, never interpolated, and an unsent request is never
  sampled into a latency it never took.

The counters and their single producers are laid out in
[Data flow](data-flow.md#results-findings-and-their-counters).

## Stateless exploration

`engine/fuzzers/stateless/` explores one endpoint at a time, no sequencing.

`plan_passes` builds one `Pass` per `(phase, identity)`: the phase's example
budget (authoritative from the `GenerationPlan`, or the budget split for a
plan-less endpoint) split across the declared identities by `share_budget`. Each
pass carries its merged per-zone strategy; an endpoint with no zone at all falls
back to a single empty `valid` pass.

The driver `explore_pass` runs a Hypothesis `@given` over the pass's strategy,
but the callback **never raises on a finding** — it only accumulates drawn
payloads into a batch and, when the batch fills to `max_concurrency`, flushes
it: builds every blueprint, executes them concurrently on the one loop, and
folds each result back in draw order. Folding evaluates the oracles, records a
`RawFinding` on a violation, and maintains the abort counters.

**One stop signal crosses the `@given` boundary.** When folding decides the pass
must stop, it sets a `Cut` on the shared state and raises a single internal
`_StopExplorationError`, which unwinds cleanly out of Hypothesis's machinery to
the carried `Cut` — no ad-hoc exception per abort reason
([ADR-034](adr/engine.md#adr-034)). A pass stops for one of four reasons, each a
`TruncationReason`:

| Reason | Trips when |
|---|---|
| `DEADLINE_EXCEEDED` | the endpoint's `deadline_ms` elapsed before a batch |
| `INFRASTRUCTURE_ABORT` | `MAX_INFRA_FAILURES` target failures, target still answering a probe |
| `TARGET_DOWN` | those failures, and a liveness probe confirms the target is down |
| `GENERATION_EXHAUSTED` | a phase never produced a single generatable candidate |

`ExplorationState` is fresh per endpoint, but the `LivenessProbe` is injected
and **shared across every endpoint of the run**, so the last known-good safe
request (one of `SAFE_PROBE_METHODS`) persists between endpoints and is there to
resend the moment an abort streak needs adjudicating
([ADR-035](adr/engine.md#adr-035)). A run of consecutive 5xx on one endpoint is
adjudicated the same way: past `MAX_CONSECUTIVE_SERVER_ERRORS`, the known-good
request is resent off-budget; if it answers, the 500s are genuine findings, and
if it does not, the run cuts `TARGET_DOWN`. A dead target can confirm nothing, so
its raw findings are counted `unverified` — one `UnverifiedFinding` per
signature — rather than spending requests rediscovering the target is down.

**Shrinking** (`shrinking.py`) runs off the findings, never the results, so its
requests stay out of the trace. It first re-sends the finding's own payload to
confirm it still reproduces (status *and* violation), then `find`s the smallest
payload that still does, then re-executes that minimal payload to package it; a
minimal payload that does not reproduce on re-execution is flaky and yields no
report.

## Stateful sequencing

`engine/fuzzers/stateful/` drives sequences of linked operations as a Hypothesis
`RuleBasedStateMachine`, built **dynamically** for a given set of endpoints:
one `Bundle` per referenced name, one `@rule` per endpoint, and an optional
`@initialize` that fixes one identity for the whole sequence
([ADR-038](adr/engine.md#adr-038)).

A rule's state link drives the chaining: it **produces** a captured
response value into a bundle, **consumes** bundled values into later requests'
zones (optionally `invalidates`-ing the bundle so a deleted resource is not
operated on again), and declares **transition invariants** — a follow-up probe
whose observed status must fall in an expected set, and whose body must reflect
the request's `echoed_fields`. A response that breaks its endpoint's own
invariant, or a transition probe that breaks its own, raises a
`StatefulViolationError` — the engine's one control-flow exception — which is
also the signal Hypothesis shrinks the *sequence* on.

A **supervisor** runs passes until the machine stops finding anything new. Each
pass is classified into a closed union of `PassOutcome` — `Reported`,
`LinkBroken`, `Exhausted`, `Flaky`, `Completed` — in one small function that
isolates the single `try`/`except` ([ADR-038](adr/engine.md#adr-038)):

- `Reported` appends a minimized crash report and **suppresses** that defect's
  signature, so the next pass looks past it; the run keeps going until
  `max_distinct_bugs` distinct defects are reported or the machine draws dry.
- `LinkBroken` raises `StatefulLinkError` carrying the partial exploration.
- `Flaky` — a shrink replay that stopped reproducing with no link error inside
  it — is **dropped on purpose**, so `findings_flaky` is `0` for every stateful
  run ([ADR-019](adr/engine.md#adr-019)).

A per-endpoint `EndpointCircuitBreaker` takes an endpoint that stops answering
out of the machine for the rest of the run — there is no half-open state — so a
dead endpoint cannot starve a still-live consumer of a bundle it needs.
The run-level truncation is inferred from which breakers opened:
`TARGET_DOWN` when every rule endpoint the run reached opened,
`INFRASTRUCTURE_ABORT` when only some did, `GENERATION_EXHAUSTED` when the
machine never drew an eligible sequence, and `STATE_LINK_ABORT` when a link
could not be honored.

## Trace and replay

`engine/trace/` records **only what a run put on the wire**, in send order —
the recipe for reproducing it. Shrinking requests are absent by construction.
Each `TracedRequest` is an observed fact: credentials are *omitted* rather than
redacted (only the config header names are kept), a URL's `user:pass@` is
stripped and flagged with `omitted_url_userinfo`, and `sent_at_ms` is excluded
from anything hashed. `canonical_json` serializes a trace so equal content
yields equal bytes, and `content_hash` is its SHA-256 with the timing dropped,
so two runs that sent the same requests content-address alike.

`rehydrate_request` is the inverse: it reconstructs a `RequestBlueprint` from a
traced request under a fresh config, applying three rules — the recorded
**identity** must still be declared, its **credential** header names must be
suppliable, and when the URL's userinfo was omitted the live `base_url` must
supply it for a **matching host**. Each rule that fails raises, so a replay
stops before sending a request it cannot fully reconstruct.

`validate_replayable(trace, config)` runs those rules over a whole trace
**without raising**, returning a `ReplayReadiness` value object with four
tuples — `missing_identities`, `missing_credentials`, `missing_url_userinfo`
(recorded hosts whose omitted userinfo the live `base_url` cannot supply) and
`host_mismatches` (recorded hosts that differ from the live host) — and an
`is_ready` that is true only when all four are empty
([ADR-022](adr/engine.md#adr-022), [ADR-046](adr/engine.md#adr-046)). The host
is checked for **every** request, not only where userinfo was omitted, so a
replay pointed at another host is refused pre-flight even when the trace kept its
own userinfo. A trace that cannot be replayed is an expected answer, not an
error.

`engine/replay/` compares and paces. `assess_fidelity` classifies a replay as
`EXACT` or `REDUCED`: a request whose observed status differs from the recorded
one is a `ResponseDivergence`, but a divergence on a request that was itself a
finding does not reduce fidelity — re-observing it is the point. Pacing is a
strategy chosen by a factory, never a runtime flag
([ADR-040](adr/engine.md#adr-040)): `TimedPacer` waits until each request's
recorded `sent_at_ms` measured from a fixed `t0`, so drift never compounds and a
past slot waits zero; `ImmediatePacer` never waits.
