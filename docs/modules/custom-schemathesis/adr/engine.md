# Custom Schemathesis — Decision records — Engine

Part of the [Custom Schemathesis decision records](index.md). Decisions about
execution: the per-request record, how findings are counted, how runners are
composed, how a request is sent and checked, and what replay needs.

---

## ADR-017 — `ExecutionResult` is the canonical record of a request; stats and trace are projections { #adr-017 }

**Status:** accepted · `models/engine/execution.py`, `engine/findings/stats.py`, `engine/trace/recorder.py`

### Context

A run produces one `ExecutionResult` per request. The counters in `RunStats`
and the `ExecutionTrace` are both built from that stream, but nothing said so,
and a reader could reasonably suspect that a counter and a trace row were
produced by different code observing different things.

### Decision

`ExecutionResult` is the canonical record of one request. The stats builders
and the trace recorder are projections of the stream of results — a read
model each — and never a second source of truth. This framing moves no code:
`stats` stays in `findings/`, the recorder in `trace/`.

### Rejected

Event-sourcing the run — an event log with the results and the findings
derived from it. There is no problem it would solve that the single stream of
`ExecutionResult`s does not already solve.

### Consequences

A counter has exactly one producer, and the trace and the stats of one run
always agree, because they read the same records.

---

## ADR-018 — Flaky findings are counted where they are observed, in the shrinker { #adr-018 }

**Status:** accepted · `engine/findings/shrinker.py`, `models/engine/results.py`

### Context

The shrinker already sees a flaky finding: a `ShrinkAttempt` with
`attempted=True` and no report is a search that ran and did not reproduce.
Deriving `findings_flaky` afterwards by subtracting confirmed from attempted
produces a number nobody measured, protected by a `ge=0` guard against going
negative — which is the guard admitting the subtraction can be wrong.

### Decision

The shrinker counts the flaky findings it observes into `ShrinkOutcome.flaky`;
the stats builder reads that field. No subtraction, no guard. The scope is the
stateless lifecycle, where the accounting partition — raw, confirmed, flaky,
collapsed, unverified — is the identity of the mode.

### Rejected

A five-mode finding ledger that tracks every finding's state across all
execution modes. The partition is a stateless concept: performance and
resilience materialize findings without shrinking, so labelling theirs
"confirmed" would report reproductions that never happened. The four stats
builders stay, one per lifecycle, sharing the per-endpoint back-fill.

### Consequences

`findings_flaky` is a measurement. The same counters as before for a stateless
run — the number was correct when the subtraction was right; now it is correct
by construction.

---

## ADR-019 — Stateful runs discard flaky findings { #adr-019 }

**Status:** accepted · `engine/fuzzers/stateful/outcome.py`

### Context

A stateful pass that fails and then does not reproduce under Hypothesis's
own re-check surfaces as a flaky failure without a nested `StatefulLinkError`.
It carries no minimal sequence and no report body; there is nothing to
materialize.

### Decision

`classify_pass_outcome` returns a `PassOutcome` for every way a pass can end;
the flaky outcome is discarded by the supervisor, deliberately, in one small
function whose docstring says so. `findings_flaky` is `0` for every stateful
run.

### Rejected

Counting the discarded pass into `findings_flaky`. It would report a defect
the run cannot describe, and the count would not be comparable with the
stateless one, which is measured per finding, not per pass.

### Consequences

The stateful stats builder sets `findings_flaky=0` explicitly. A reader of a
stateful run's stats should not take the zero as "nothing was flaky".

---

## ADR-020 — Finding resolution is a callable on the loop specification { #adr-020 }

**Status:** accepted · Superseded in part by [ADR-043](#adr-043) · `engine/runners/loop.py`

### Context

Stateless, performance and resilience share the loop `explore → group →
resolve → dedupe → stats`, but resolve differently: stateless shrinks each
group to a minimal reproducer; performance and resilience materialize the
first member without shrinking. Two implementations, no third in sight.

### Decision

`EndpointLoopSpec` is a frozen value object bundling `fuzz_one`, `build_stats`,
`on_confirmed_down` and `resolve`, with
`Resolve = Callable[[Sequence[FindingGroup]], ShrinkOutcome]`. The loop runs
`resolve` after exploring every endpoint; each runner supplies its own.

### Rejected

A `FindingResolver` Protocol with one class per strategy — two
implementations do not justify a class hierarchy. A `BaseRunner` class with
the loop as a template method — inheritance where a function suffices, and a
base class every future runner would have to extend.

### Consequences

A runner that reuses the loop passes four callables in one object; a runner
whose shape is different (stateful, replay) writes its own loop and owes the
spec nothing.

---

## ADR-021 — Options are resolved beside the runner registry { #adr-021 }

**Status:** accepted · `engine/runners/registry.py`

### Context

Each runner declares an `options_type`. Validating the caller's `options`
against it, and supplying the defaults when `None` is passed, is the same
three lines for every mode. Spread across the runners, they drift.

### Decision

`resolve_options(runner, options)` lives next to `register_runner` and
`resolve_runner`: resolve the runner by mode, then resolve its options, in
the one module that knows what a runner is.

### Rejected

Each runner validating its own options in `run`. It works until one forgets
the `None` case.

### Consequences

Adding a runner does not touch the dispatcher and does not repeat the options
handling; it declares `options_type` and the registry does the rest.

---

## ADR-022 — Replay readiness is a value object the engine computes { #adr-022 }

**Status:** accepted · Superseded in part by [ADR-045](#adr-045), [ADR-046](#adr-046) · `engine/trace/`, `models/engine/replay.py`

### Context

Replaying a trace needs the identities it was recorded under, credentials for
them, and a host that matches. Whether a trace can be replayed is a property
of the trace and the runtime config, judged by the same rules that rehydrate
a request — engine knowledge. A consumer that recomputes it by mirroring the
rehydration logic will drift from it.

### Decision

`validate_replayable(trace, config) -> ReplayReadiness`, exported by the
facade and living next to `rehydrate_request`. `ReplayReadiness` is a frozen
value with three tuples — `missing_identities`, `missing_credentials`,
`host_mismatches` — and `is_ready`, true only when all three are empty. It is
a Result object, not an exception: a trace that cannot be replayed is an
expected answer.

### Rejected

Leaving the check to the consumer. Also raising for an unreplayable trace:
the caller wants to show what is missing, not catch an error.

### Consequences

`EngineRunResult` carries no run status field; readiness is judged before the
run, fidelity after it, and the two are separate values.

---

## ADR-033 — A zoned payload is a value object with a body sentinel { #adr-033 }

**Status:** accepted · `engine/payload.py`

### Context

A generated request is a set of values keyed by request zone — path, query,
header, body. The body is unlike the other three: it can be absent, or it can
be drawn as JSON `null`. Modelled as a plain dict, an absent body and a body of
`None` collapse to the same thing, and a caller cannot tell "no body zone" from
"a body whose value is null".

### Decision

`ZonedPayload` is a frozen value object carrying the four zones plus the `Phase`
they were drawn for. The body defaults to a private `_NO_BODY` sentinel, so
`has_body` distinguishes an absent body from an explicit `None`. `with_field`
returns a copy with one field written; inputs are never mutated.

### Rejected

Threading a bare `dict[str, Any]` keyed by zone name. It cannot represent the
third body state, and a mutable dict passed down the injector invites a write
that the frozen contract is meant to forbid.

### Consequences

The three body states are distinct everywhere the payload travels; a payload is
copied, never edited in place; and the injector reads one typed shape instead of
guessing a dict's keys.

---

## ADR-034 — One stop signal crosses the `@given` boundary { #adr-034 }

**Status:** accepted · `engine/fuzzers/stateless/state.py`, `engine/fuzzers/stateless/exploration.py`

### Context

Stateless exploration runs inside a Hypothesis `@given`, whose callback must not
raise on a finding — a finding is data to accumulate, not a failure. But the
pass still has to stop early for genuine reasons: a deadline, an infrastructure
abort, a target confirmed down. Each reason needs to unwind cleanly out of
Hypothesis's own control flow and reach the code that records the truncation.

### Decision

There is one internal exception, `_StopExplorationError`, carrying a `Cut`
value (a `TruncationReason` plus optional detail). Whichever fold decides the
pass must stop sets the `Cut` on the shared state and raises that one
exception; the driver catches it once and turns the carried `Cut` into the run's
truncation record. Every abort reason travels the same channel.

### Rejected

A distinct exception type per abort reason, or a boolean the callback returns
that the driver re-checks. Multiple exception types multiply the catch sites,
and a return-value protocol cannot unwind Hypothesis's generation loop from
inside a batch fold.

### Consequences

The abort reasons stay data (`Cut`), the control flow stays one exception, and a
finding never rides the same channel as a stop — the callback appends, the cut
raises.

---

## ADR-035 — Exploration state is run-scoped; the liveness probe is shared across endpoints { #adr-035 }

**Status:** accepted · `engine/fuzzers/stateless/state.py`, `engine/fuzzers/stateless/folding.py`

### Context

Deciding whether a streak of failures means "this endpoint is broken" or "the
whole target is down" needs a request known to be safe to resend. Such a
request may have been seen while exploring an *earlier* endpoint; the endpoint
currently failing may itself expose no safe method. If the known-good request
resets with each endpoint, the adjudication has nothing to resend the moment it
is needed most.

### Decision

`ExplorationState` — results, findings, the abort counters — is fresh per
endpoint. The `LivenessProbe` is injected into it and **shared across every
endpoint of the run**, so the last safe-to-resend request persists between
endpoints. Adjudication resends it off-budget: if the target answers, the
failures are genuine findings; if not, the run cuts `TARGET_DOWN`.

### Rejected

A liveness probe scoped to each endpoint. An endpoint with only unsafe methods
could then never be adjudicated, and a target that died mid-run would be
mislabelled as that one endpoint's defect.

### Consequences

Per-endpoint bookkeeping stays isolated, while the one piece of knowledge that
is genuinely about the target — is it still alive — outlives any single
endpoint.

---

## ADR-036 — Oracles run as an ordered pipeline with central precedence, registered explicitly { #adr-036 }

**Status:** accepted · `engine/oracles/precedence.py`, `engine/oracles/registry.py`, `engine/oracles/builtin.py`

### Context

Several independent checks judge one response — a 5xx, an undeclared status, a
wrong content type, a schema mismatch, an SLA breach, a chaos degradation. They
are not independent in *order*: an infrastructure failure must suppress the
rest, and a chaos response must be judged by the resilience rule before the
plain server-error rule sees it. The order is a property of the whole set, not
of any one oracle.

### Decision

Each oracle carries an `order: OraclePrecedence`, a named `IntEnum` value. The
registry runs them sorted by `(order, name)` as a Chain of Responsibility,
accumulating violations and stopping at the first terminal verdict. All
built-ins are registered explicitly in one function, never as a side effect of
importing a runner.

### Rejected

Magic integer priorities, or registration on import of each oracle module. Bare
integers hide the ranking's meaning and leave gaps to guess at; import-time
registration makes the active set depend on which modules were imported and in
what order.

### Consequences

Precedence is a readable enum, the built-in set is one function a test can start
empty from, and a new oracle slots into the order by declaring its precedence —
no dispatcher edit, no import-order surprise.

---

## ADR-037 — `FindingFacts` is the single subject of every crash report { #adr-037 }

**Status:** accepted · `engine/findings/materializer.py`, `models/engine/results.py`

### Context

A crash report is assembled from three different sources: a stateless finding, a
shrunk minimal payload, and a stateful transition step. Each has the same
essential subject — which endpoint, which method and phase, which violation,
the payload, the fields to redact — expressed differently. Three assemblers
would drift, and redaction could end up applied in one path and forgotten in
another.

### Decision

`FindingFacts` names that subject as one frozen value object, and
`build_crash_report(facts, blueprint, result, ...)` is the single assembler of a
`CrashReport`. Every source produces a `FindingFacts` and hands it to the one
builder, where redaction happens and nowhere else.

### Rejected

A `CrashReport` constructor per source. It repeats the ten-field assembly, and
the redaction step is exactly the kind of cross-cutting rule that goes missing
when it is not funnelled through one place.

### Consequences

A stateless report and a stateful one are the same object built the same way;
redaction is guaranteed because there is one door; and a new report source only
has to produce a `FindingFacts`.

---

## ADR-038 — The stateful machine is built in a builder, and a pass ends in a closed set of outcomes { #adr-038 }

**Status:** accepted · `engine/fuzzers/stateful/machine_builder.py`, `engine/fuzzers/stateful/outcome.py`

### Context

Hypothesis's `RuleBasedStateMachine` is a class with rules declared as
decorated methods at class-definition time. The engine does not know the rules
ahead of time — they are one per compiled endpoint, with bundles named by the
endpoints' state links. And a pass over such a machine can end many ways: a new
violation, a broken link, an exhausted generator, a flaky replay, a clean run —
each needing a different reaction from the supervisor, all funnelling through
Hypothesis's single raising surface.

### Decision

`build_state_machine(endpoints, deps)` assembles the machine subclass
dynamically — one bundle per referenced name, one rule per endpoint — so the
run-scoped collaborators live in a `RuleDeps` value object and never leak onto
the machine's `self`. `classify_pass_outcome` maps the pass's result to a
closed union `PassOutcome` (`Reported`, `LinkBroken`, `Exhausted`, `Flaky`,
`Completed`), and the supervisor `match`es on it. The one `try`/`except` is
isolated in that classifier.

### Rejected

A hand-written state machine, or letting the supervisor inspect raw Hypothesis
exceptions inline. Reimplementing sequencing and shrinking is a large surface to
own; scattering `except` clauses across the supervisor loses the exhaustiveness
a closed union gives a `match`.

### Consequences

The machine is data-driven from the endpoints, the collaborators stay off
`self`, and every way a pass can end is a named variant the supervisor handles
exhaustively.

---

## ADR-039 — A `StatefulLinkError` is reconstructed to name its endpoint, never mutated { #adr-039 }

**Status:** accepted · `engine/fuzzers/stateful/rule.py`, `engine/fuzzers/stateful/supervisor.py`

### Context

A state link can fail deep inside a rule — a production field is null, a dotted
path misses — where the code raising the error does not always know which
endpoint's rule is running. The endpoint identity has to be attached as the
error unwinds, and the error may resurface wrapped inside a Hypothesis
`FlakyFailure` after shrinking.

### Decision

`StatefulLinkError` is immutable in the sense that matters: when an endpoint
identity has to be added, a **new** error is raised from the original
(`raise ... from exc`), never a field assigned onto the caught instance. The
classifier reaches inside a `FlakyFailure` to recover a nested
`StatefulLinkError` and treats the pass as `LinkBroken`, carrying the partial
exploration out.

### Rejected

Mutating the caught exception to set its `endpoint_id`. A mutated exception
that is also re-raised elsewhere carries a value that depends on who caught it
last — the class of bug the frozen-by-construction rule exists to prevent.

### Consequences

An error's endpoint attribution is set once, at the point that knows it, by
construction; a flaky replay that hides a real link break is still surfaced as
one; and the partial exploration always rides out with the error.

---

## ADR-040 — Pacing is a strategy chosen by a factory, not a flag { #adr-040 }

**Status:** accepted · `engine/replay/pacing.py`

### Context

A replay either reproduces the recorded send schedule or fires requests as fast
as it can. The runner should not branch on a boolean at each request to decide
whether to wait.

### Decision

`Pacer` is a Protocol with one method, `wait_until(sent_at_ms)`. `TimedPacer`
waits until each request's recorded offset, measured from a fixed `t0` so drift
never compounds and a past slot waits zero; `ImmediatePacer` never waits. A
factory, `pacer_for(options)`, picks one from `preserve_timing`. The runner
calls `wait_until` unconditionally.

### Rejected

An `if preserve_timing:` at each request. It puts the timing policy at the call
site, repeated per request, where the two behaviours cannot be tested in
isolation and a future third pacing mode would grow another branch.

### Consequences

The runner has one code path; the two pacing behaviours are separate, testable
objects with injectable clock and sleep; a new pacing policy is a new `Pacer`,
not a new branch.

---

## ADR-041 — A chaos transport is a Protocol resolved from a registry { #adr-041 }

**Status:** accepted · `engine/runners/resilience/transport.py`, `engine/runners/resilience/attacks.py`

### Context

The level-1 chaos battery expresses anomalies httpx can carry — an oversized
body, a slow partial body, a deeply nested body, a mismatched content type.
Later attacks will need framing-level control httpx cannot express, over a raw
socket. The runner should not learn a new delivery path each time such an attack
is added.

### Decision

`ChaosTransport` is a Protocol — `send(request: ChaosRequest) -> ExecutionResult`
— resolved from a registry by a string key. Every attack names its transport
key; `resolve_transport(key, orchestrator)` returns the live transport, raising
`EngineError` for an unknown key. Adding a transport is `register_transport(key,
factory)`; nothing that dispatches an attack branches on the attack itself.

### Rejected

A single transport with an `if attack.kind == ...` inside it. The runner would
then own every delivery mechanism, and a raw-socket transport would mean editing
the one that already exists rather than registering beside it.

### Consequences

A new delivery mechanism is a registration under a new key; the runner picks a
transport by the attack's declared key; and the level-1 attacks all map to the
one built-in `httpx` transport without the runner knowing how it works.

---

## ADR-043 — The shared endpoint loop is a higher-order function over a three-field spec { #adr-043 }

**Status:** accepted · Supersedes the loop-shape part of [ADR-020](#adr-020) · `engine/runners/loop.py`

### Context

Two runners fuzz endpoints independently and differ only in how they resolve
findings: stateless shrinks each group to a minimal reproducer, performance
materializes the first member without shrinking. Everything around that — fuzz
each endpoint, group the findings, deduplicate, assemble the result and the
trace — is identical. A run also has to stop outright when the target is
confirmed down, not merely when one endpoint's budget runs out, and that verdict
has to outrank any softer cut already seen.

### Decision

`explore_endpoints(endpoints, spec)` is a higher-order function that runs the
whole loop — fuzz, group, resolve, dedupe, build the stats and the trace — and
`EndpointLoopSpec` bundles the three steps that vary: `fuzz_one`, `resolve` and
`build_stats`. Resolution runs once, **after** the loop, over the complete
`RunAggregate`, so a resolver sees every endpoint's results and truncation
before it decides. `is_target_down` reads a `TruncationReason.TARGET_DOWN` cut;
the loop stops the whole run on it and lets it outrank any cut already recorded,
while a softer cut keeps the first one seen. Only stateless and performance share
this loop; stateful, replay and resilience have a genuinely different shape and
each write their own.

### Rejected

Carrying a separate per-endpoint "target confirmed down" callback on the spec.
The target-down verdict is a property of the aggregate, judged where resolution
already runs, so a fourth callable duplicated a decision the resolver can make
from the `RunAggregate` it is handed.

### Consequences

A runner that reuses the loop supplies three callables in one frozen object; the
target-down cut ends the run and wins over any softer cut; and a runner whose
shape does not fit writes its own loop and owes the spec nothing.

---

## ADR-044 — The public findings are a closed union of outcomes; the counters stay measurements { #adr-044 }

**Status:** accepted · `models/engine/findings.py`, `engine/findings/assembler.py`, `models/engine/results.py`

### Context

A run's `RunStats` already reports, per counter, how many findings were
confirmed, went flaky or were never verified. But the only findings a consumer
could actually inspect were the confirmed ones: `EngineRunResult` carried the
shrunk crash reports and nothing else. The flaky and the unverified outcomes
existed as numbers with no object behind them, so a caller could tell *how many*
findings did not reproduce but never *which signature* they belonged to.

### Decision

`EngineRunResult.findings` is a `tuple[Finding, ...]`, where `Finding` is a
discriminated union on `state` (`FindingState`): a `ConfirmedFinding` wraps its
`CrashReport`, while a `FlakyFinding` and an `UnverifiedFinding` each carry a
`FindingSignature` and the raw `occurrences` they stand for — one object per
signature, `occurrences` mirroring `CrashReport.represented_findings`. The six
`RunStats.findings_*` counters are unchanged and remain the measurement of
record; the union reifies them: the confirmed findings are the deduplicated
reproducers (`findings_unique`), the summed flaky occurrences are
`findings_flaky`, the summed unverified occurrences are `findings_unverified`.
`findings_collapsed` stays a counter only.

### Rejected

Replacing the counters with a length over the filtered union — a run's headline
numbers should be one cheap aggregate, not a re-count of a variable-length
structure. Leaving flaky and unverified as counters alone — a consumer that
wants to show what did not reproduce would have a number and nothing to point
at. Reifying `findings_collapsed` too — a collapsed finding is a duplicate a
confirmed reproducer already stands for, not a distinct symptom, so it has no
object of its own.

### Consequences

Every settled finding is a first-class object a reader can inspect; the counters
stay the measurement and the union reifies them, so the two can be reconciled;
and `collapsed` has no object precisely because it names duplicates, not defects.

---

## ADR-045 — Run status is derived by the engine from the truncation reason { #adr-045 }

**Status:** accepted · `models/engine/run_status.py`, `models/engine/results.py`

### Context

A run ends three ways: it ran to completion, a soft cut truncated it (a budget
or deadline reached), or an abort stopped it because continuing was pointless
(the target went down, a state link could not be honored). Which of the three a
run landed in depends on the truncation reason — engine knowledge — yet the
orchestrator that persists the run needs it as a plain value, and ADR-022 had
left `EngineRunResult` with no status field at all.

### Decision

`RunStatus` is a `StrEnum` (`completed` / `truncated` / `aborted`) and
`EngineRunResult.status` carries it. `run_status` maps the truncation reason:
no truncation is `completed`, `TARGET_DOWN` and `STATE_LINK_ABORT` are
`aborted`, every other reason is `truncated`. The engine derives it once, where
the reason is known; the orchestrator persists it as recorded.

### Rejected

Leaving the consumer to classify the `TruncationRecord`. It would mirror the
engine's own rule and drift from it — the same argument that made replay
readiness engine-owned in ADR-022. A run's terminal outcome and a replay's
pre-flight readiness are now distinct questions, each answered by its own value.

### Consequences

A run's terminal outcome is one enum on the result, produced where the
truncation reason is known. The persisted vocabulary reserves an extra `failed`
value for a run that raised before producing a result; the engine never emits
it, because a run that raises has no `EngineRunResult` to carry a status.

---

## ADR-046 — Replay readiness separates missing URL userinfo from a host mismatch, and checks every request's host { #adr-046 }

**Status:** accepted · `models/engine/replay.py`, `engine/trace/rehydrate.py`, `engine/trace/replay_readiness.py`

### Context

A recorded trace strips the `user:pass@` userinfo out of every URL, and a
replay re-supplies it from the live config's `base_url`. Two different things
can go wrong: the `base_url` carries no userinfo to re-supply, or it points at a
different host than the trace recorded. ADR-022's readiness value folded both
into one `host_mismatches` tuple that was only consulted where userinfo was
needed, so a replay aimed at another host whose trace happened to keep its own
userinfo slipped past the pre-flight check and was refused only mid-rehydration,
as an exception rather than a readiness verdict.

### Decision

`ReplayReadiness` gains a fourth tuple. `missing_url_userinfo` lists recorded
hosts whose omitted userinfo the live `base_url` cannot supply; `host_mismatches`
lists recorded hosts that differ from the live host, checked for **every**
request regardless of userinfo. `is_ready` is true only when all four tuples are
empty, so a replay pointed at another host is refused before any request is
sent. The CLI's `replay` maps each tuple to its own error message.

### Rejected

Keeping the single host check gated behind the userinfo path. It left the
retargeting case to fail late, inside rehydration, as an `EngineError` the caller
could only catch — not as the readiness verdict a caller wants in order to show
what is wrong before it commits to a replay.

### Consequences

The two host-level failures a replay can hit are named separately and each maps
to its own message; and a trace can never be replayed against a host it was not
recorded for, because the host check is pre-flight and covers every request.
