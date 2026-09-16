# Spec Forge Engine — Decision records — Engine

Part of the [Spec Forge Engine decision records](index.md). Decisions about
execution: the per-request record, how findings are counted, how runners are
composed, how a request is sent and checked, and what replay needs.

---

## ADR-017 — `ExecutionResult` is the canonical record of a request; stats and trace are projections { #adr-017 }

**Status:** accepted · `models/runtime/execution.py`, `runtime/findings/stats.py`, `runtime/trace/recorder.py`

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

**Status:** accepted · `runtime/findings/shrinker.py`, `models/runtime/results.py`

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

**Status:** accepted · Superseded by [ADR-047](#adr-047) · `runtime/fuzzers/stateful/outcome.py`

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

**Status:** accepted · Superseded in part by [ADR-043](#adr-043) · `runtime/runners/loop.py`

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

**Status:** accepted · `runtime/runners/registry.py`

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

**Status:** accepted · Superseded in part by [ADR-045](#adr-045), [ADR-046](#adr-046) · `runtime/trace/`, `models/runtime/replay.py`

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

**Status:** accepted · `runtime/payload.py`

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

**Status:** accepted · `runtime/fuzzers/stateless/state.py`, `runtime/fuzzers/stateless/exploration.py`

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

**Status:** accepted · `runtime/fuzzers/stateless/state.py`, `runtime/fuzzers/stateless/folding.py`

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

**Status:** accepted · `runtime/oracles/precedence.py`, `runtime/oracles/registry.py`, `runtime/oracles/builtin.py`

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

**Status:** accepted · `runtime/findings/materializer.py`, `models/runtime/results.py`

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

**Status:** accepted · `runtime/fuzzers/stateful/machine_builder.py`, `runtime/fuzzers/stateful/outcome.py`

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

**Status:** accepted · `runtime/fuzzers/stateful/rule.py`, `runtime/fuzzers/stateful/supervisor.py`

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

**Status:** accepted · `runtime/replay/pacing.py`

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

**Status:** accepted · `runtime/runners/resilience/transport.py`, `runtime/runners/resilience/attacks.py`

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

**Status:** accepted · Supersedes the loop-shape part of [ADR-020](#adr-020) · `runtime/runners/loop.py`

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

**Status:** accepted · `models/runtime/findings.py`, `runtime/findings/assembler.py`, `models/runtime/results.py`

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

**Status:** accepted · `models/runtime/run_status.py`, `models/runtime/results.py`

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

**Status:** accepted · `models/runtime/replay.py`, `runtime/trace/rehydrate.py`, `runtime/trace/replay_readiness.py`

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

---

## ADR-047 — Stateful runs report flaky findings as an occurrence count { #adr-047 }

**Status:** accepted · Supersedes [ADR-019](#adr-019) · `runtime/fuzzers/stateful/flaky.py`, `runtime/findings/stats.py`, `runtime/findings/assembler.py`

### Context

ADR-019 discarded a stateful pass that failed and then did not reproduce, so
`findings_flaky` was always `0` for a stateful run. Once the reader surfaces
unconfirmed findings — flaky and unverified — that silence became a real gap: a
stateful step that misbehaved intermittently left no trace at all, while a
stateless one of the same shape was counted and shown. A flaky signal is
evidence worth reporting, even without a minimal sequence to reproduce.

### Decision

A flaky stateful pass becomes a `FlakyFinding`. The recovered violation is turned
into a `FindingSignature` (endpoint, phase, invariant, status, identity, body),
and identical signatures are accumulated with an occurrence count; a flaky event
that recovered no violation to sign is still tallied. `build_stateful_stats` sums
both into `findings_flaky`, and `reconcile_flaky_with_confirmed` folds away any
flaky finding whose signature a confirmed report already stands for, so a symptom
the run also confirmed is shown once, as a defect. `findings_unverified` stays
`0`: a stateful run confirms or minimizes every step as it goes.

### Rejected

Materializing a flaky pass into a full report. It carries no minimal sequence and
no reproducer, so it cannot be shown as a crash; the signature and its occurrence
count are all the run can honestly describe.

### Consequences

`findings_flaky` is a real measurement for a stateful run, and its flaky findings
reach the report document's `unconfirmed_findings` and the `inspect` views like
any other. A signature's `status_code` of `0` records a step that got no response
at all, a transport failure.

---

## ADR-048 — Semantic properties are checked by an always-on oracle, not an execution mode { #adr-048 }

**Status:** accepted · Superseded in part by [ADR-056](#adr-056) · `runtime/oracles/semantic/`, `runtime/oracles/builtin.py`, `runtime/oracles/context.py`, `models/runtime/crash_report.py`

### Context

The producer can declare business rules for an endpoint — "the created article
keeps a non-empty slug", "the total is the subtotal minus the discount" — as a
`SemanticProperty`, a closed expression tree the kernel already carries all the
way to the compiled endpoint. Nothing judged them: they were validated for field
references and transported, then dropped. Checking them needs the response, so it
belongs in the oracle pipeline that already reads every response; the open
question was whether a new execution mode should own it, and how to evaluate an
LLM-authored expression without executing what the LLM wrote.

### Decision

The check is an ordinary registered oracle, `semantic_property`, at precedence
`SEMANTIC` (55) — between response schema (50) and latency (60). It follows the
family's dormant-until-its-datum shape: it registers unconditionally and returns
`CONTINUE` when the endpoint declares no rules, and it only speaks on a 2xx, since
a rule describes what a successful call promised. The expression is evaluated by a
`functools.singledispatch` over the kernel's six node kinds — never `eval` — so
nothing the LLM authored is executed. Evaluation is total: a missing field, a
type-invalid operation or an aggregation over a non-list yields an `UNDETERMINED`
sentinel, and boolean combinations use strong Kleene (K3) three-valued logic.
`UNDETERMINED` is a value the pipeline carries, **never** a finding — an
undecidable rule stays silent. A rule is a violation only when its root
expression evaluates to exactly `False`; a non-boolean root decides nothing. The
verdict is **non-terminal**, so a broken rule is recorded and later oracles still
run. A `RESPONSE_INVARIANT` is judged against the response body; an
`INPUT_CONSTRAINT` against the flattened request the server accepted — body keys,
query and headers in one namespace.

### Rejected

A dedicated execution mode for semantic checking. It would duplicate the request
loop every mode already runs and force the user to choose between fuzzing and
rule-checking, when the rules are just one more thing to observe about a response
the run already has. An interpreter over free-text or generated predicates was
also rejected: the closed six-node tree is enough to state the rules the producer
authors, and it can be evaluated without ever running foreign code.

### Consequences

A new `InvariantViolation.SEMANTIC_PROPERTY` member joins the vocabulary, and the
finding it raises carries only the invariant, not the rule's id or description —
the same shape every other oracle's finding has. Because the oracle is
non-terminal at precedence 55, a semantic violation and a latency violation can
both be recorded for one response. Path parameters are not reachable to an
`INPUT_CONSTRAINT`: the blueprint carries them only inside the request URL, so a
rule over a path parameter resolves to no value and stays undecided — a current
limitation of the input scope. (Superseded in part by [ADR-056](#adr-056): the
request now carries its typed path parameters, and a rule may name one.) The
oracle only observes: it never steers generation toward inputs that would break
an `input_constraint`, and it cannot
express a rule that relates a request field to a response field, because the
kernel has no namespace spanning both.

## ADR-049 — A finding names the rule it broke through a generic, stable channel { #adr-049 }

**Status:** accepted · Amends [ADR-048](#adr-048) · `models/runtime/crash_report.py`, `models/runtime/results.py`, `runtime/oracles/registry.py`, `runtime/oracles/semantic/oracle.py`, `models/runtime/findings.py`, `runtime/fuzzers/stateless/shrinking.py`

### Context

The semantic oracle ([ADR-048](#adr-048)) reports a business rule broken by a 2xx
as `InvariantViolation.SEMANTIC_PROPERTY`. That invariant is shared by every rule
an endpoint declares, so a finding raised under it was ambiguous the moment an
endpoint declared more than one rule: "the created article keeps a non-empty slug"
and "the total is the subtotal minus the discount" broke the *same* invariant, and
nothing downstream — the signature that decides whether two findings are the same
symptom, the crash report, storage, the report, the views — could tell them apart
or say which rule the API actually broke. A reader saw `semantic_property` and had
to guess. The rule that was violated is known at the oracle, exactly where the
verdict is decided; the question was how to carry it to the surface without
special-casing the semantic oracle into every layer it passes through.

### Decision

A `ViolatedRule` value object — a frozen `id` plus `description` — is the channel,
threaded through the pipeline every oracle already uses. An `OracleVerdict` gains
an optional `rule`; `evaluate` folds it into an `ObservedViolation` (invariant
paired with rule); a `RawFinding` carries the observed violations; the
`FindingSignature` gains a `rule_id`; the `CrashReport` gains a `rule` (with a
`rule_id` shortcut); and the id flows on into the `findings` table
(`rule_id`/`rule_description`), the report document and the views. The semantic
oracle is the first and only current emitter — every other oracle leaves the rule
`None`, and the channel is inert for them.

Two rules keep the channel honest. **Only the id is identity:** `rule_id` is part
of the finding signature, so two different rules broken on one endpoint are two
distinct findings, but the human-readable `description` is *carried, never
compared* — reworded prose never splits or merges a finding. **Reproduction is by
identity:** the shrinker's `_still_violates` accepts a minimized payload only when
it breaks the same invariant *and* the same rule id, so a minimal reproducer can
never end up named for a rule it does not actually break.

### Rejected

- **A semantic-only field on the crash report.** Bolting a `semantic_property_id`
  directly onto `CrashReport` would name the concept after one oracle and force
  every other layer to special-case it, when the shape ("the rule this response
  broke") is generic and belongs on the shared verdict → violation → signature →
  report path any oracle can populate later.
- **One `InvariantViolation` member per rule.** Minting an enum member per declared
  rule would make an open, per-API set masquerade as a closed vocabulary, break the
  invariant severity ordering, and make the signature depend on an enum that changes
  with every spec. The invariant stays the closed category (`semantic_property`);
  the rule id is the open detail carried beside it.
- **A free-text detail string.** A single human-readable sentence would read well
  but could not be compared, queried or ordered, and would tempt callers to parse
  identity back out of prose. Splitting id from description keeps a stable key for
  identity and free text for the human.

### Consequences

A confirmed semantic defect now names its rule end to end: the crash report and
`report.json`'s `defects` carry `rule_id` and `rule_description`, the HTML report
shows a **Business rule** row per defect and a **Rule** column in the unconfirmed
table, and the REPL labels the finding `business rule violated · <rule id>`. A
flaky or unverified finding carries only the `rule_id` — there is no reproducer,
so no description is stored for it. The report document's `schema_version` moves to
**1.5**. Every non-semantic oracle emits no rule for now; the channel is ready when
another oracle has a rule to name.

---

## ADR-050 — Access control is declared by the producer and checked by a dormant oracle woken by the auth runner { #adr-050 }

**Status:** accepted · Extends [ADR-049](#adr-049) · `specforge_contracts/access.py`, `models/runtime/access.py`, `runtime/oracles/access_control.py`, `runtime/oracles/precedence.py`, `runtime/runners/auth/`, `models/execution_mode.py`

### Context

Broken object-level authorization (BOLA/IDOR) and broken authentication are the
highest-impact API defects, and no amount of single-caller fuzzing finds them: to
know that a read *should* have been refused, the engine has to know **who owns the
resource** and send the same request as someone else. Two facts are missing from a
per-request view. The first is ownership — which identity a resource belongs to,
and against which endpoints that ownership is enforced. The second is a second
caller — the run has to establish a resource under one identity and then read it
under another. The engine already carries state-link bundles (a value produced by
one call and consumed by another) and a set of declared identities; the question
was where ownership is stated, and how the check avoids firing on the many
legitimate reads a run makes.

### Decision

Ownership is **declared by the producer**, as a fifth kernel section, `access`:
an `AccessPolicy` (`public` / `authenticated` / `owner_only`) and, for
`owner_only`, an `owner_bundle` naming the state-link bundle the endpoint consumes
whose producing identity is the owner. The policy boundary rejects an `owner_only`
endpoint whose `owner_bundle` it does not actually consume, so the link is
guaranteed before a run starts.

The check is an ordinary registered oracle, `access_control`, at precedence 25 —
between server error (20) and status code (30). It is **dormant**: it reads no
`endpoint.access` and returns `CONTINUE` unless a caller passes an
`AccessExpectation` through `check_response`, so an ordinary run never fires it.
Only the new `auth` runner supplies that expectation, and it does the work a
bypass check needs: it provisions the owner's resource itself under the first
declared identity, captures the bundle value, writes it into the consuming zone,
and re-sends under every other identity and anonymously. A 2xx for a caller the
policy excludes is the finding, carrying the caller's `identity_label` and the
policy as its `ViolatedRule` id through the generic rule channel ADR-049 already
built — the access oracle is its second emitter. The runner **fails fast** when it
cannot honor a link: a run without declared identities is an `EngineError`, and an
`owner_only` bundle with no producer in the run is an `AccessLinkError`, both
raised before the first request rather than running a meaningless pass.

The access oracle sits **before** the body-conformance oracles (content type,
schema) deliberately: it never reads the body, and those are terminal, so placing
it later would let a bypass that also returns a malformed body be masked by the
schema violation raised first. A bypass is the more severe fact and must win the
verdict.

### Rejected

- **Deriving ownership from transitions.** Inferring who owns what from the
  state-link graph would flag legitimate public reads — a resource a `POST`
  produced is not thereby private — and cannot express `authenticated`, which owns
  no bundle at all. Ownership is a producer statement, not a graph inference.
- **A `mode ==` branch in the stateless runner.** Cross-identity probing is a
  different shape (provision, then cross), not a knob on stateless fuzzing;
  bolting it on with a conditional would reintroduce the branch the runner registry
  exists to avoid ([ADR-013](api.md#adr-013)).
- **Judging on the endpoint's `access` section alone.** An always-on oracle that
  read `endpoint.access` would fire on every ordinary run's successful call, which
  says nothing about authorization because that caller *is* allowed. The finding is
  only meaningful against a crossing the runner set up, so the runner's expectation,
  not the section, is what wakes the oracle.
- **Skipping silently when the producer is missing.** An `owner_only` endpoint with
  no producer for its bundle cannot be crossed; treating that as "nothing to test"
  would report a green auth run that checked nothing. It aborts loudly instead.

### Consequences

The kernel moves to **0.3.0** and the engine pins `specforge-contracts>=0.3.0`.
There are now nine built-in oracles (the ninth at precedence 25) and six built-in
runners. `auth` runs take no options and materialize findings **without
shrinking** — a cross-identity read is already its own minimal reproducer. The
scope is deliberately narrow: with a single declared identity the cross is
owner-versus-anonymous only, and role escalation (admin, BFLA) is not yet
expressible — it waits until the `access` vocabulary grows a notion of role.

---

## ADR-052 — Raw-socket chaos transport for framing-level resilience attacks { #adr-052 }

**Status:** accepted · Extends [ADR-041](#adr-041) · `runtime/runners/resilience/raw_socket.py`, `runtime/runners/resilience/raw_message.py`, `runtime/runners/resilience/raw_attacks.py`, `runtime/http/orchestrator.py`, `models/runtime/execution.py`, `runtime/oracles/resilience.py`

### Context

The resilience battery began as anomalies httpx can put on the wire — an
oversized body, a slow partial body, a deeply nested body, a mismatched content
type. The most revealing attacks against an HTTP server, though, are malformed
at the protocol framing itself: a chunk that declares far more bytes than
follow, a `Content-Length` that lies, duplicate `Host` or `Content-Type` lines,
a header past any sane limit, a request cut off mid-flight. httpx is built to
make those impossible — it deduplicates headers, recomputes `Content-Length`,
validates chunking — so a well-behaved client can never emit them. The battery
needed a second delivery path that writes exactly the bytes it is given, without
correcting anything, while still respecting the run's single concurrency cap and
its timeout budget.

### Decision

A second `ChaosTransport`, keyed `raw`, delivers a `RawHttpRequest` — request
line, ordered header lines, body, and an optional truncation offset — byte for
byte over `asyncio.open_connection`, choosing TLS from the URL scheme. It is
selected by the same Strategy seam ADR-041 built: a framing attack names the
`raw` key and the runner resolves the transport for it, never branching on the
attack. The transport takes its slot through the orchestrator's new
`dispatch_raw` method, which occupies the same concurrency semaphore, stamps the
attempt and counts it on the wire as any httpx request would, but opens no httpx
client — so the raw path is one more attempt through the single concurrency
bottleneck, not a parallel one.

A connection the peer accepts and then drops before a complete response is a new
`ErrorCategory`, `connection_dropped`, held deliberately outside the
infrastructure categories so it reaches the resilience oracle and counts as a
degradation on the same footing as a 5xx — a crash mid-response is a crash. A
timeout or a 4xx (429 included) stays graceful. The connection-cut-off attack
half-closes its socket and reads whatever the server sends back, so the verdict
is the server's reaction, not an artefact of the client having closed. TLS cannot
half-close, so over an `https://` target the attack is not applicable and is
skipped as an `unsendable_request` rather than delivered a different way
([ADR-059](#adr-059)).

### Rejected

- **Forcing framing anomalies through httpx.** Every escape hatch (a custom
  transport, hand-built request bytes) still runs through httpx's framing
  normalization, so the anomalies simply never reach the wire. The point is to
  bypass the correction, which only a bare socket does.
- **A dedicated socket pool with its own concurrency control.** A second pool
  would let raw attacks run beyond the configured cap and skew the wire count and
  in-flight stamp. Sharing the orchestrator's one semaphore keeps a single,
  honest concurrency bottleneck for the whole run.
- **Treating a mid-response drop as an infrastructure failure.** Folding
  `connection_dropped` into `availability` would bury it in the stats and keep it
  from the oracle, so a server that crashes under a malformed frame would report
  as merely unreachable. A dropped connection after the peer accepted it is
  evidence about the endpoint, not the network.

### Consequences

The resilience battery is now three registered groups — httpx-borne anomalies,
raw-socket framing anomalies, and repeated-request sequences — all firing on
every endpoint, and adding an attack in any of them is still one data row against
an existing transport key. `ErrorCategory` gains `connection_dropped`, and the
resilience oracle degrades on it as well as on a 5xx. The raw transport speaks
only `http` and `https`; any other scheme yields an unsendable result before a
socket is opened. No new flag or mode appears — the mode is still
`--mode resilience`.

---

## ADR-053 — Role-restricted access is a fourth kernel policy, crossed against the roles the user's identities declare { #adr-053 }

**Status:** accepted · Extends [ADR-050](#adr-050) · `specforge_contracts/access.py`, `models/runtime/execution.py`, `models/runtime/access.py`, `runtime/runners/auth/`, `runtime/oracles/access_control.py`, `exceptions.py`

### Context

ADR-050 made two access defects detectable: a caller reading a resource another
identity owns, and an anonymous request reaching an endpoint that requires
authentication. It left out the third high-impact class, broken function-level
authorization (BFLA): an administrative function that any authenticated user can
call, when only callers holding a role should. There is no owner resource to
establish here, so the owner-then-cross shape does not apply. Two facts are
missing instead. The first is which role the endpoint requires, and that is a
statement about the API, so it belongs in the contract. The second is which role
each caller holds. Only the user knows that, in the same way only the user knows
the credentials.

### Decision

The kernel's `AccessPolicy` gains a fourth member, `role_only`, and
`EndpointAccess` a second qualifier, `required_role`. Its coherence mirrors
`owner_bundle`: required exactly when the policy is `role_only`, rejected under
any other. A role is an exact, case-sensitive string with no hierarchy.

The caller's side is `Identity.role`, an optional non-empty string read from the
user's `--identities` file, never from a contract. An identity that declares no
role never satisfies a required role, so it is crossed like any other non-holder.

A `role_only` endpoint gets its own planner, registered in the auth runner's
per-policy table beside the other three. It provisions nothing: no state-link is
needed, because the function is not anyone's resource. It sends one
deterministic valid request under every declared identity whose role is not the
required one, plus one anonymous request. Holders are never sent. If every
identity holds the role, only the anonymous request goes out, which is still a
valid check. The table has a row for every `AccessPolicy` member and is indexed
directly, so a policy without a planner fails loudly rather than being skipped.

Before the first request, the runner checks that some declared identity holds
each `role_only` endpoint's required role. If none does, the run fails with
`AccessRoleError`, carrying `endpoint_id` and `required_role`, and its message
lists the roles the run did declare. The error is a sibling of `AccessLinkError`,
and the engine façade exports both, because both are configuration the user
fixes: add the producer, or declare the role.

The `access_control` oracle judges `role_only` without conditions. It never sees
roles, which live on the run's config, and the planner only crosses callers who
lack the role, so any 2xx on that expectation is a violation. The rule id is
`role_only`. The description names the caller, or an anonymous request, and the
required role, but never the caller's own role; the `identity_label` already
points back into the user's file.

Validation happens in two layers, not three. The kernel enforces coherence and
the runner precondition enforces that a holder exists. `policy/` gets no
`role_only` rule, because the compiled endpoint has no role vocabulary to check a
role against.

### Rejected

- **Running without a holder.** Unlike a missing producer, a missing holder
  does not make the crossing impossible to build; it makes the crossing wrong.
  Roles compare exactly, so an identities file that spells the role `Admin`
  against a `required_role` of `admin` would put the real administrator among
  the crossed callers. Its legitimate 2xx would then be reported as a bypass of
  an endpoint that is correctly guarded. A typed error is fixed with one line,
  but a false finding, once reported, cannot be taken back. Relaxing the check
  later only means removing it.
- **Treating an identity without a role as a wildcard.** An incomplete identities
  file would then quietly produce zero findings, and a green run would have
  checked nothing.
- **A `role_only` rule in `policy/`.** The compiled `EndpointSpec` has no role
  vocabulary, and roles exist only in runtime configuration, so there is nothing
  to check the required role against at compile time.
- **Provisioning a resource first.** A role-restricted function has no owner.
  Copying the `owner_only` shape without its reason would add a request that
  proves nothing.
- **Widening `AccessLinkError` with an optional role.** The result is a bag of
  optional attributes whose invariants nobody enforces, under a name that no
  longer describes the failure. A missing role is not a broken state-link, so it
  gets its own exception.
- **One access model per policy (a discriminated union).** This would make an
  illegal qualifier unrepresentable without a validator. But the wire JSON stays
  identical while every consumer's Python surface changes. The option comes back
  the day one policy needs two qualifiers.
- **Putting the caller's role, or the set of holders, in the expectation.** Either
  gives the oracle more to say, but it breaks the one-qualifier-per-policy shape
  that both coherence checks share. The decision about who is entitled already
  lives in the planner, the one component that sees the roles.

### Consequences

The kernel moves to **0.4.0** and the engine now requires it (`specforge-contracts>=0.4.0`), since it reads `role_only` and `required_role`; the change to the contract wire is additive. The auth runner now has one
planner per policy, and its package is split by question: `plan.py` holds what a
plan is and the request builders, `planners.py` who builds it for each policy,
`preconditions.py` what must hold before the first request, and `runner.py` the
only module that sends. A `role_only` endpoint costs one request per non-holder
plus one anonymous request. Two identities without the role that both succeed
produce two findings, since `identity_label` is part of the finding signature.

The scope stays narrow on purpose. Each identity holds one role, compared by
equality. Role hierarchies are not modelled, because a hierarchy is specific to
each API and cannot be inferred. A caller with several roles is declared as
several identities, and cross-tenant isolation is still not expressible.

## ADR-054 — The semantic phase steers generation toward a declared input constraint { #adr-054 }

**Status:** accepted · Supersedes the "never steers generation" clause of [ADR-048](#adr-048) · Superseded in part by [ADR-056](#adr-056) · `models/phase.py`, `strategy_compiler/conditional_phases.py`, `strategy_compiler/fields/builtin.py`, `budget/reservation.py`, `runtime/fuzzers/phases.py`, `runtime/fuzzers/semantic/`, `runtime/oracles/semantic/scope.py`, `runtime/oracles/semantic/declared.py`

### Context

The semantic oracle ([ADR-048](#adr-048)) reports a 2xx that breaks a
producer-declared `input_constraint` — a rule such as `end > start` or
`quantity <= limit`. But it only judges the requests generation happens to
produce, and in-spec generation breaks such a rule only as often as the schema
does: measurably about as often as chance for a wide, low-density body, and never
for a rule that excludes a single value from a million-wide range. A defect the
oracle can recognize but generation never provokes is not tested. The rule is
known at compile time, on the endpoint; the question was where to make generation
aim at it without disturbing the endpoints that carry no such rule and without
ever sending a schema-invalid request to fake a violation.

### Decision

A new generation phase, `semantic`, that directs generation at the constraint,
mixed with valid draws that hold it and an unfiltered valid draw that guarantees
candidates.

It is **conditional**, not a static split row. `CONDITIONAL_PHASES` maps
`Phase.SEMANTIC` to a predicate — the endpoint declares at least one
`input_constraint` — and a share, `SEMANTIC_SHARE` = 0.10. `effective_phases`
compiles the phase only for an applicable endpoint, and `effective_split` reserves
its 10% out of whatever split was already resolved (`reserve_share` normalizes the
rest and rescales it by `(1 - share)`), so it works for a profile split, a custom `phase_split`, or
the aggressiveness-derived hacker split alike. An endpoint with no such rule is
compiled exactly as before. At the field level the phase is a valid strategy; the
whole-payload direction lives in the engine, applied once per endpoint through
`refine_for_phase`, because a cross-field relation is a property of the assembled
request, not of any one field.

`build_semantic_payloads` builds, per constraint, a violating arm and a conforming
arm, plus one unfiltered valid arm. A field against a numeric literal, and two
fields sharing a schema, are **constructed** directly — bounds rewritten from the
comparison and intersected with the declared bounds, or the drawn values
rearranged — so the directed draw is cheap and never leaves the field's declared
schema. Every other shape **filters** valid draws by the rule. The valid arm means
a rule no arm can decide never empties the phase, so the run never truncates on it;
such a rule simply degrades to valid draws, the same silence the oracle already
keeps on an undecidable rule.

Generation and evaluation share one scope. `flatten_input_scope` and
`resolve_declared_field` are the single functions both the oracle and the phase
read, so the two cannot disagree on what a rule sees or where a field lives; a value
that contradicts its declared type is dropped from that scope, so a 2xx to a
wrong-typed input is not reported as a business-rule violation: the rule does not
speak about that input. The oracle's verdict is otherwise unchanged. (Superseded in
part by [ADR-056](#adr-056), which adds the path zone to this scope at the lowest
precedence.)

### Rejected

- **A dedicated execution mode.** Same reason ADR-048 gave for the check itself:
  it would duplicate the request loop and force the user to choose between fuzzing
  and rule-directed generation, when directed draws are just one more phase of the
  run the endpoint already has.
- **Filter-only generation.** Keeping only the filter arms is the simplest design
  and was measured: on a wide, low-density body it sends violating requests barely
  above chance, so the phase would not meet its own purpose. A known problem gets
  the mechanism that solves it, not a documented limitation.
- **Bounded rejection sampling.** Drawing the valid body many times per example to
  fish out a violation trips Hypothesis's health checks on wide bodies and can
  exhaust the phase, tipping a clean run to `TRUNCATED`. Constructing the field is
  both safe and directed at a cost independent of body width.
- **A per-endpoint static split row for every endpoint.** Adding `semantic` to
  every profile's split is simpler in the compiler but spends budget on endpoints
  that declare no rule and pads every endpoint's report with a phase that tested
  nothing — a report implying rules were checked where none exist. The conditional
  phase confines both the cost and the claim to the endpoints that carry a rule.

### Consequences

The `Phase` vocabulary gains `semantic`, and `FindingRecord.phase` lists it.
A finding's signature carries its phase, but reports are deduplicated after
shrinking with the phase left out, so a violation the plain valid phase also
reaches is reported under whichever phase found it first. An endpoint that declares no input constraint is
untouched: no phase, no split change, byte-identical output. This supersedes
ADR-048's consequence that the oracle "never steers generation" — the observation
still lives in the oracle, but a conditional phase now aims generation at the same
rule. Directedness is bounded by what an honest generator can build: where the
declared schemas already imply the constraint, no arm can produce a violation
without sending a schema-invalid request, so the phase produces none and stays with
valid draws.

---

## ADR-055 — A phase extension is one registered value object, and every finding names its rule { #adr-055 }

**Status:** accepted · Extends [ADR-054](#adr-054), completes [ADR-049](#adr-049) · `phase_extensions.py`, `phase_extension_builtins.py`, `__init__.py`, `strategy_compiler/effective_phases.py`, `runtime/fuzzers/phases.py`, `runtime/oracles/verdict.py`, `runtime/oracles/rules.py`, `models/runtime/crash_report.py`, `runtime/oracles/builtin.py`, `runtime/oracles/latency.py`, `runtime/oracles/resilience.py`, `runtime/fuzzers/stateful/transitions.py`

### Context

Two facts about the engine's edges had drifted apart from the shape they deserved.

The **semantic phase** ([ADR-054](#adr-054)) is one concept — a phase that turns on
for the endpoints that carry an input constraint, reserves a slice of their budget,
and refines their payloads — but it was declared in private places that never
import each other: a table in the compiler holding its predicate
and share, and a separate refiner table in the engine holding its whole-payload
rewrite. Adding a second such phase, or reading how the semantic one is wired, meant
finding and keeping two tables in two layers consistent by hand, with nothing forcing
them to agree. (The prior shape is described in [ADR-054](#adr-054); this record
replaces it.)

The **rule channel** ([ADR-049](#adr-049)) let a finding name the rule it broke, but
only the semantic and access-control oracles ever named one; every other invariant
left the rule `None`. A reader who opened a 5xx, an undeclared-status or a latency
defect saw an invariant value and no statement of the requirement it broke, and every
renderer showed whatever rule arrived as a business rule, because only contract-declared
rules had ever arrived.

### Decision

**A phase extension is one value object in one registry.** `PhaseExtension` is a
frozen `(phase, applies, share, refiner)`: the phase it adds, the predicate over the
`EndpointSpec` that activates it, the fraction of the budget it reserves, and the
payload refiner it applies. A package-root registry holds them, and both readers —
the compiler's `effective_phases` / `effective_split` and the engine's
`refine_for_phase` — read the same registry, so the endpoints that compile the phase
are exactly the ones that fund it and the one that refines it. Because a phase
extension spans two layers, it is registered from a **composition root**
(`phase_extension_builtins.py`) that the package `__init__` calls once; the built-in
`semantic` extension is its only current entry. A `PhaseExtension` validates itself
at construction — a non-callable `applies` or `refiner` raises `TypeError`, a `share`
outside `(0, 1)` raises `ValueError` — so a half-declared extension fails loudly
rather than skewing a budget silently.

**Every finding names a rule, declared or intrinsic.** A `semantic_property` or
`access_control` finding names the rule the contract *declared* for it. Every other
invariant now carries an *intrinsic* `ViolatedRule` whose id is the invariant's own
value and whose description is the one-sentence requirement the invariant enforces on
its own — a response is never a 5xx, carries a declared status code, matches the
declared schema and Content-Type, answers within the latency SLA, degrades cleanly
under chaos, honours a produced resource's state transition. Which invariants are
contract-declared is a single `frozenset`, `DECLARED_RULE_INVARIANTS`; every other
invariant is intrinsic **by exclusion**. Nothing about the origin is persisted: the
renderer and the report reconstruct declared-versus-intrinsic from the invariant
alone, showing a declared rule as a **Business rule** row (`<id> — <description>`,
with the id appended to the finding's label) and an intrinsic rule as a plain
**Rule** row spelling out the requirement, its id dropped because it would only
repeat the invariant.

### Rejected

- **Documenting the two tables.** Leaving the compiler's predicate/share table and
  the engine's refiner table as they were, with a note that they must be kept in
  step, is the shortcut a known problem does not deserve: two sources of truth for
  one concept, and no mechanism binding them.
- **Building the declaration in either layer.** Putting the whole `PhaseExtension` in
  the compiler would drag the engine's refiner up into `strategy_compiler`; putting
  it in the engine would drag the compiler's predicate and budget share down into
  `runtime/`. Either inverts a dependency. A neutral registry populated from a
  composition root keeps both layers reading, neither owning.
- **Registering from a subpackage `__init__`.** Wiring the built-in extension as an
  import side effect of a subpackage would make the registered set depend on which
  modules a run happened to import — the same trap explicit oracle registration
  ([ADR-036](#adr-036)) exists to avoid. A single composition root the package
  `__init__` calls once keeps the set one readable function.
- **String-equality suppression in the renderer.** Keeping intrinsic rules but having
  each renderer hide a rule whose id happens to equal its invariant's value would tie
  every renderer to a naming convention of the engine, silently, with nothing checking
  it. Naming the contract-declared invariants in one `frozenset`, mirrored by the
  report layer and gated against the engine's, makes the distinction explicit.
- **A persisted origin column.** Storing a per-finding "declared or intrinsic" flag
  would persist something already implied by the invariant, and could contradict it
  after a reword. The `frozenset` is the single source of truth; the origin is derived,
  never stored.

### Consequences

The semantic phase is now one declaration, and a second endpoint-conditional phase is
one more `PhaseExtension` registered from the composition root — no new table in
either layer. `refine_for_phase` reads the registry and applies the extension's
refiner, returning the assembled strategy unchanged for a phase with no extension.

Every finding — not just a semantic one — arrives with a `rule_id` and, on a
confirmed crash, a `rule_description`; the report document's `schema_version` moves to
**1.7** (the JSON fields are unchanged, but they are now populated on every finding).
Dedup and shrink outcomes are unaffected: an intrinsic id is constant per invariant, so
it adds nothing to a finding's identity, and the two status-code branches were already
separated by the status code the signature carries. This completes ADR-049's channel:
the rule is no longer inert for any oracle.

## ADR-056 — A request carries its path parameters, and the shared scope ranks the path zone lowest { #adr-056 }

**Status:** accepted · Extends [ADR-054](#adr-054), supersedes the path-parameter limitation of [ADR-048](#adr-048) · `models/runtime/execution.py`, `models/runtime/trace.py`, `runtime/http/injector.py`, `runtime/trace/recorder.py`, `runtime/trace/rehydrate.py`, `runtime/oracles/semantic/scope.py`, `runtime/oracles/semantic/declared.py`, `runtime/oracles/semantic/oracle.py`, `runtime/payload.py`, `runtime/fuzzers/semantic/zones.py`, `runtime/fuzzers/semantic/field_pairs.py`, `runtime/fuzzers/semantic/filtering.py`

### Context

The producer's vocabulary already lets a business rule name a path parameter — a
rule over `PATCH /users/{id}` may say `id > 0`. The compiled endpoint carries the
path zone, and generation draws it. But the drawn value only ever lived inside the
interpolated URL: `RequestBlueprint` held `headers`, `query_params` and `json_body`
as named fields, and the path segment folded into `url` as a percent-encoded string.
The semantic oracle flattened body, query and headers into one namespace and found
nothing named `id`, so a rule over a path parameter resolved to no value and stayed
undecided ([ADR-048](#adr-048)). The value existed at compile time and was lost at
URL interpolation.

### Decision

**The drawn path values travel with the request as a typed value.**
`RequestBlueprint.path_params` and `TracedRequest.path_params` hold the raw
path-parameter values as drawn — typed as drawn, not stringified — before URL
interpolation. The injector populates the blueprint from the payload's path zone;
the URL still carries the percent-encoded segment, so encoding is an **output
projection** of the same value, not the value itself. The recorder writes the field
into the trace and rehydration reads it back, so a replay rebuilds the same typed
path.

**The shared input scope adds the path zone at the lowest precedence.**
`ZONE_OVERRIDE_ORDER` becomes `(PATH, BODY, QUERY, HEADER)`, and
`flatten_input_scope` overlays the four zones in that order — so a name declared in
more than one zone resolves to the last listed, and PATH, listed first, has the
lowest precedence. The reason PATH ranks lowest rather than highest: a path
parameter is always present and always required, so ranking it highest would let it
silently shadow the data zone (body, query, header) a rule most plausibly
constrains. A path parameter therefore only decides a name that no data zone
declares. Path values enter the scope raw and typed — an `integer` path parameter is
judged as an `int` — while only headers are stringified, because a header is a
string on the wire. `resolve_declared_field` resolves the PATH zone too, so the
phase's numeric and field-pair constructors build violating and conforming path
values from the same scope the oracle reads (only the header zone is excluded from
the numeric constructor, its values being strings). `path_params` is a **required**
trace field: a trace recorded before it existed fails validation on load.

### Rejected

- **Reconstructing path values by matching the template against the URL.** The
  oracle could parse `/users/0` back against `/users/{id}` to recover `id`. This is
  fragile: percent-encoding, slashes inside a value and empty segments make the
  inverse ambiguous, and it would reconstruct a *string* where the rule needs the
  drawn type. Carrying the typed value is exact and free.
- **Ranking the path zone highest.** A path parameter is always present, so giving it
  top precedence would let it decide any shared name — shadowing the body, query or
  header field a rule most likely means. Lowest precedence keeps the path a
  tie-breaker for names no data zone claims.
- **Removing path parameters from the rule vocabulary.** Forbidding a rule over a
  path parameter would keep the scope simple at the cost of a legitimate, common
  constraint (`id > 0`), and would diverge the engine from the contract the producer
  is allowed to author.
- **An optional trace field.** Defaulting `path_params` to empty would let a trace
  recorded before the field load without it, hiding a pre-field trace behind a silent
  empty map instead of an honest validation error. The project is pre-release: traces
  are regenerated, not migrated.

### Consequences

A rule over a path parameter is now decidable: a `0` drawn for `id` on `PATCH
/users/{id}`, accepted with a 2xx, is a `SEMANTIC_PROPERTY` finding that cites the
declared rule, and the phase constructs violating and conforming path values instead
of leaving the rule to chance. Values that URL normalization would drop (`""`, `.`,
`..`) are filtered by the compiler, so an unsendable path never becomes a finding.
The canonical example of a rule the phase can never decide moves from a path
parameter to a **numeric header declared `integer`**: a header is stringified and
then dropped by declared-type conformance, so such a rule stays undetermined and only
the unfiltered valid arm generates. Existing traces regenerate rather than migrate.

## ADR-057 — Undecided business rules are reported as a per-endpoint diagnostic, not as findings { #adr-057 }

**Status:** accepted · Extends [ADR-048](#adr-048), builds on [ADR-044](#adr-044) · `runtime/oracles/verdict.py`, `runtime/oracles/registry.py`, `runtime/oracles/semantic/oracle.py`, `runtime/fuzzers/stateless/state.py`, `runtime/fuzzers/stateless/folding.py`, `runtime/fuzzers/stateless/__init__.py`, `runtime/runners/loop.py`, `runtime/findings/stats.py`, `models/runtime/results.py`, `models/runtime/stats.py`

### Context

The semantic oracle evaluates every declared business rule against each accepted
(2xx) response, and its evaluator is total: a rule that references a field the
request or response did not carry, or a value the declared type rules out, yields
`UNDETERMINED` rather than raising, and an undetermined root is deliberately never
a finding — an undecidable rule must not accuse the API ([ADR-048](#adr-048)). The
common case is a rule that reads a header numerically while the header is declared
`integer`: a header is a string on the wire and a wrong-typed value is dropped from
the scope, so the comparison can never see a number.

The cost was silent. An undetermined rule and a satisfied rule looked identical from
outside the oracle, so a rule that was *never* decidable — its field never came
back, or its type made it undecidable in principle — degraded silently: the run
reported a clean endpoint and no one learned that a declared rule had never once
been checked. That is exactly the kind of unmeasured gap the package's counters
exist to make visible.

### Decision

**The oracle observes; a run reports the rules it could never decide, per
endpoint.** As it walks an endpoint's rules the `semantic_property` oracle
classifies each: decided when its root evaluates to a boolean either way, undecided
when it evaluates to `UNDETERMINED`. The split rides the verdict as a
`RuleDecisions(decided, undecided)` and the ordered pipeline merges every oracle's
split into the one `OracleReport(violations, rule_decisions)` that `check_response`
returns — a single pipeline result object rather than a second return channel. Both
declared rule classes are covered by the same mechanism: an input constraint judged
against the flattened request and a response invariant judged against the body.

Stateless exploration folds each response's decisions into a per-endpoint
`RuleDecisions`, and at the end of the endpoint reports `never_decided` — the rules
undecided on some response and decided on **none** (`undecided - decided`). A rule
decided on even one response is cleared retroactively; a rule the oracle never
evaluated (an endpoint with no 2xx) is not counted, because it was never observed.

The result is a **diagnostic, not a finding**: the run's status and its findings are
unchanged. It travels the same path a starved identity does — `ExplorationOutcome`,
the run loop's per-endpoint merge, `EndpointStats.undecided_rules` (sorted rule ids),
the `undecided_rules` storage column, report schema **1.8**, and the run detail and
live fuzz views — and it is populated only by the modes that run the stateless
fuzzer's full accounting, **stateless** and **performance**. Stateful, replay, auth
and resilience leave it empty, and shrink re-sends never contribute.

### Rejected

- **Counting undecidable rules in the generation phase.** The compiler knows a rule's
  declared types and could flag "this rule can never hold on the wire" before a run.
  But the generation phase never sees a response, so it cannot tell a rule that is
  undecidable *in principle* (a numeric header) from one that is merely undecided *so
  far* because the field has not yet appeared. The distinction the diagnostic reports
  — undecided on some response, decided on none — only exists after execution.
- **One finding per undecidable rule.** Emitting a finding would put an undecidable
  rule in the crash tables and count it against the run's status. But it is not a
  defect in the target: the API did nothing wrong, and the rule may be undecidable
  because of the contract, not the service. A finding would inflate the funnel with
  something no reproducer can shrink.
- **A bare counter without names.** "3 rules undecided" tells a reader something is
  wrong but not which rule to review. The rule id is the actionable part — it points
  at the exact declared rule and the field it names — so the diagnostic carries the
  sorted ids, not a count.
- **Listing every rule an endpoint never evaluated.** Reporting rules on an endpoint
  that returned no 2xx would drown the signal: those rules were not undecidable, they
  were simply never reached, and their absence is already visible as the endpoint's
  missing successful responses. Only rules the oracle actually tried and could not
  decide are reported.

### Consequences

A rule that can never be checked is now visible instead of silent: the numeric-header
rule, and any rule whose field never comes back, is listed under the endpoint that
declared it, in the fuzz summary, `inspect`/`history` and `report.json` at schema
1.8. The signal is honest by construction — a rule decided even once drops off, and a
rule never evaluated never appears — so a non-empty list always means "declared,
tried, undecidable here". The counter costs one merged frozenset per endpoint and one
nullable JSON column; a run that declares no rules, or runs in a mode that does not
account for them, carries an empty list and pays nothing.

---

## ADR-058 — Endpoints with declared side effects are held back by a safety guard, not fuzzed { #adr-058 }

**Status:** accepted · `runtime/safety_guard.py`, `runtime/__init__.py`, `models/runtime/execution.py`, `models/runtime/stats.py`

### Context

A producer's `EndpointRisk` already declares whether an endpoint writes
(`write_operation`) or reaches past the API with an effect that cannot be undone
(`external_side_effects`). Until now the engine fuzzed every compiled endpoint
the same way, so a run against a live API could send a real payment, delete a
real record or fire a real webhook, and there was no in-engine way to say
"explore everything except the endpoints that hurt to touch". Sending fewer
requests is not the answer: one destructive request is one too many.

### Decision

**A safety guard partitions the run's endpoints before dispatch.**
`partition_by_safety` runs once in `engine.run()` — after the risk ordering,
before the shared HTTP client opens — and splits the ordered endpoints into a
`probed` set and a `held` set. A `RiskFlag` holds an endpoint out of the modes
where its harm is real: `external_side_effects` out of **every**
request-generating mode (`stateless`, `performance`, `resilience`, `auth`,
`stateful`), `write_operation` out of `performance` and `resilience` only.
`replay` is exempt from both, because it re-sends a recorded trace rather than
generating requests. `RiskFlag`'s declaration order is precedence, so an
endpoint carrying both flags is held for the stronger, less reversible reason.

The runners are untouched — they only ever receive the probed set, so no runner
carries safety logic and no mode can forget it. A held endpoint is not dropped
from the accounting: `record_held_endpoints` folds each one into
`RunStats.by_endpoint` as a zero-request `EndpointStats` whose `held_back_by`
names the flag, so it stays visible in the report, the storage column and the
live summary. The guard is a **policy**, not an engine-stability setting:
`ExecutionConfig.allow_side_effects` (the `--allow-side-effects` flag, default
off) lifts it, and it is persisted with the run's recipe so a re-run inherits
the operator's decision.

### Rejected

- **Documenting the risk flags as accepted-but-inert.** Carrying
  `write_operation`/`external_side_effects` on the contract while the engine
  fuzzed the endpoint anyway would leave the most dangerous run behaviour to a
  note no operator reads. A declared risk the engine can act on must change what
  the engine does.
- **Holding only the load families back for an external side effect.** Dropping
  just the `performance`/`resilience` batteries would still let `stateless`,
  `auth` and `stateful` send a real, irreversible request. An external side
  effect is unsafe in every mode, so it is held out of all of them.
- **Two separate permissions, one per flag.** A second knob doubles the surface
  for a distinction an operator rarely wants: someone who accepts real writes
  almost always accepts them for the whole run. One permission that lifts the
  whole guard is the proportionate control — the two flags already differ in
  *which* modes hold them, which is where the real distinction lives.
- **A run-level list of endpoints to skip.** A hand-maintained exclusion list
  would drift from the contract and duplicate what `EndpointRisk` already
  declares per endpoint. The producer that knows an endpoint writes is the right
  place to say so, once, in the contract — a per-endpoint flag, not a separate
  list to keep in sync.

### Consequences

A run against a live service no longer fires a producer-flagged destructive
request unless the operator opts in. The guard is one partition at the engine's
entry point, costing one flag check per endpoint and a zero-request row per held
endpoint. One edge is explicit: in `auth` mode a held endpoint that another
endpoint's owner-only check depends on breaks that link, and the run fails with a
typed `AccessLinkError` naming the missing producer rather than silently skipping
the check — the operator lifts the guard with `--allow-side-effects` to run it.
`replay` stays faithful: it reproduces exactly what a prior run sent, so a trace
recorded with the guard on carries the held endpoints' absence unchanged.

## ADR-059 — Invalid credentials are declared not fabricated, a replay stops on a dead target, and a TLS half-close is not applicable { #adr-059 }

**Status:** accepted · `models/runtime/execution.py`, `models/runtime/access.py`, `runtime/runners/auth/`, `runtime/oracles/access_control.py`, `runtime/http/liveness.py`, `runtime/replay/fidelity.py`, `runtime/runners/replay.py`, `runtime/runners/resilience/raw_socket.py`

### Context

Three execution gaps surfaced once the engine ran against live services, each a
place where the engine assumed more than the world guaranteed.

An `authenticated` endpoint was probed with a single anonymous request. That
proves the endpoint refuses *no* credential, but not that it refuses a *bad* one
— an expired, revoked or garbage token a real client would present. The engine
had no honest way to obtain such a token: fabricating one (mangling a valid
header, inventing a signature) tests the target against a credential the operator
never authorized and reports a "bypass" that may just be a malformed request the
server rightly 400s.

A replay always ended `completed`. It re-sent every recorded request in order
even when the target had stopped answering, so a service that fell over mid-replay
produced a wall of timeout results, a fidelity verdict computed against a target
that was no longer there, and no signal that the run itself was untrustworthy.

The mid-request-close resilience attack performs a TCP half-close (`write_eof`)
so the server's real reaction to a truncated request is observed. TLS cannot
half-close. The transport used to catch the resulting `NotImplementedError` and
fall back to a full close, which produced `connection_dropped` findings that were
artefacts of the client closing the socket, not of the server degrading — a false
positive over every `https://` target.

### Decision

**Invalid credentials are declared in config, and one derived view of valid
identities feeds every consumer.** `Identity` carries a `credential`
(`CredentialKind`, default `valid`); an `--identities` entry sets
`credential = "invalid"` with the headers of a token the operator knows the target
must reject. `ExecutionConfig` exposes `valid_identities` and `invalid_identities`
as derived views over `identities`, and every identity consumer — owner selection,
role holders, the stateless/performance budget split, stateful rotation — reads
`valid_identities` rather than filtering at each site. Only the auth runner sends
under an invalid identity: the `authenticated` planner crosses the anonymous
request *and* each invalid identity, records their labels on the
`AccessExpectation` (`invalid_labels`, accepted only under that policy), and a 2xx
under one is an `access_control` finding on the same `authenticated` rule naming
that identity. `owner_only` and `role_only` cross invalid identities as ordinary
non-privileged callers, flagged by their existing rules. The runner's precondition
now requires at least one valid identity, raising a typed `AccessIdentityError`
otherwise.

**A replay stops when a confirmed target failure means the target is down, and
its trace is a prefix.** A `TargetLivenessMonitor` watches the result stream: a
streak of target failures (`timeout`/`availability`) reaching `MAX_INFRA_FAILURES`
fires one liveness probe (`HEAD` to the base URL). A dead target ends the replay
`aborted` (`target_down`); a live one ends it `truncated` (`infrastructure_abort`);
either stops re-sending. A request never sent is no evidence and neither advances
nor clears the streak. The produced trace is then a prefix of the recording, so
`assess_fidelity` compares only the prefix and its level describes the prefix
alone, the truncation record travels in the trace, and the CLI rules every
recorded defect past the prefix `inconclusive`.

**A TLS half-close is decided statically as not applicable.** Over an `https://`
base URL the raw-socket transport checks, before it takes a slot or opens a
socket, that the attack requires a half-close and returns an `unsendable_request`
result with the detail "mid-request close is not applicable over TLS: the
transport cannot half-close" — the same shape as an unsupported scheme. No finding
is produced, the request counts as infrastructure in the endpoint's stats, and the
former full-close fallback is gone. Over `http://` nothing changes.

### Rejected

- **Fabricating an invalid credential in the engine.** Mutating a valid token or
  synthesizing a bad one tests the target against a credential the operator never
  authorized and cannot distinguish a real bypass from a server rejecting a
  malformed request. The operator declares the token they know is invalid; the
  engine only crosses it.
- **Filtering identities by credential kind at each call site.** Re-deriving "the
  valid ones" in owner selection, role holders, the budget split and stateful
  rotation would scatter the same rule across the runner and let one site forget
  it. One derived view on `ExecutionConfig` is the single source every consumer
  reads.
- **A replay that always completes, or a post-hoc detection.** Re-sending a dead
  target's whole trace yields meaningless results and hammers a service already
  down; deciding "was it down?" only after the fact keeps sending in the
  meantime. Stopping on a confirmed failure, with an explicit prefix and
  inconclusive verdicts past it, reports what actually happened.
- **A full-close fallback or a new diagnostic field for TLS.** Falling back to a
  full close manufactures `connection_dropped` findings that are the client's
  doing, not the server's; adding a field to mark them would ask every downstream
  reader to special-case a case that should never have produced a finding. An
  attack that cannot be delivered over the connection is `unsendable_request`,
  the shape the transport already uses for a request it will not send.

### Consequences

The auth mode now proves an authenticated endpoint rejects a bad credential, not
only that it refuses anonymity, and the finding names the offending identity with
the credential redacted. A run whose identities are all invalid has no valid pool
and fails fast with `AccessIdentityError`. A replay is trustworthy when the target
dies under it: its status says `aborted` or `truncated`, its header shows the
count of requests not re-sent, and the defects it could not re-observe are
`inconclusive` rather than silently dropped or falsely cleared. The JSON report
schema is unchanged — status and truncation already flowed through it. Resilience
runs over `https://` no longer report a false `connection_dropped`; the
mid-request-close attack contributes an infrastructure count instead of a finding
there, and runs unchanged over `http://`.

## ADR-060 — A crash report's response body is redacted by field name, and a confirmed finding's identity is fixed where it is confirmed { #adr-060 }

**Status:** accepted · `runtime/findings/redaction.py`, `runtime/findings/constants.py`, `runtime/findings/materializer.py`, `runtime/fuzzers/stateful/supervisor.py`, `runtime/findings/assembler.py`, `models/runtime/results.py`

### Context

A `CrashReport` is a shareable artifact: it is persisted, rendered into the JSON
and HTML reports, and shown by the crash inspector. Its `response_body` is
captured verbatim from the target, and a target hands back credentials — a login
endpoint returns a `token`, a 5xx echoes the request that carried a `password`, a
session endpoint mirrors a `cookie`. Request headers and the request payload were
already redacted at the single point where a report is assembled; the response
body was not, so a secret the API returned reached the database, the report file
and the inspector in the clear.

Fixing this ran into a second, subtler problem. A finding's identity is a
`FindingSignature`, and part of that signature is a *fingerprint of the response
body's shape* — each field mapped to its JSON type. A confirmed finding's
signature used to be re-derived from the report's response body. Redacting that
body first would change the fingerprint: a non-string secret (a numeric
`session_id`, say) replaced by the string `***` flips a field's type, and the
flaky-reconciliation step — which drops a flaky finding once a confirmed report
already stands for it — would no longer recognize its own confirmed twin.

### Decision

**Redact the response body by field name, in the materializer, and nowhere else.**
`sanitize_response_body` walks a parsed JSON body and replaces the value of any
sensitive field with `***`, at any nesting depth, through objects and arrays of
objects alike. Two sources supply the names: a built-in table,
`SENSITIVE_BODY_FIELDS` (`password`, `token`, `access_token`, `refresh_token`,
`id_token`, `secret`, `client_secret`, `api_key`, `authorization`, `cookie`,
`session`, `session_id`, `private_key`), and the endpoint's own declared
`sensitive_fields` — of which only the last path segment is used, because a
response has no request zones to qualify. Matching is **exact after
normalization**: a name is case-folded and stripped of `_` and `-`, so
`accessToken`, `access-token` and `access_token` all match `access_token`. There
is no suffix, substring or shape matching. The walk builds a new body and never
mutates its input.

**Fix the confirmed finding's identity where the finding is confirmed, not from
its report.** The stateful supervisor records a `confirmed_signatures` list at the
moment it confirms a defect, carried on `StatefulExplorationOutcome`, and
flaky reconciliation compares those signatures directly rather than re-deriving a
signature from the (now redacted) report body. Redaction can therefore never move
a finding's identity.

### Rejected

- **Redacting when persisting, or when rendering the report.** Either would let
  the raw secret reach a store the redaction does not cover: redacting only on the
  way to the database still leaves it in an in-memory report the inspector prints,
  and redacting only at render time leaves it in the database row. Redacting once,
  where the report is assembled, covers every downstream consumer by construction.
- **Shape heuristics such as JWT detection.** Recognizing a secret by what its
  value looks like is non-deterministic at the edges: it both misses secrets in an
  unexpected format and false-positives on an unrelated field that happens to look
  like a token, and the same run could redact a field one time and not the next.
- **Suffix or substring matching.** Matching `*_token` or `*key` would swallow
  `next_page_token`, `sort_key` and other innocuous fields whose values are exactly
  the debugging detail a crash report exists to show.
- **Redacting the trace.** The trace is the replay recipe: it must re-send what
  the run actually put on the wire, byte for byte. Rewriting a value in it would
  break verbatim replay, and its request bodies are generated data while its
  credential headers are already omitted by name.
- **A type-preserving placeholder, or a stored fingerprint on the report, to
  protect identity.** A placeholder that mimicked each value's type to keep the
  fingerprint stable would leak the value's shape and complicate the redactor for
  a problem that the identity fix already removes; storing a pre-computed
  fingerprint on the report to read back later would add a redundant field whose
  only job is to paper over deriving identity from a mutated body. Taking the
  signature where the finding is confirmed needs neither.

### Consequences

A secret the target returns no longer leaves the engine in the clear: the stored
finding, the JSON and HTML reports, and `inspect --crash` all show `***` for a
sensitive field, at any depth. The report schema is unchanged — only values
change, not the shape — so nothing downstream needs to migrate. Because a
confirmed finding's signature is now taken where it is confirmed, before report
deduplication, the flaky twin of a report that dedup folded into another is
reconciled too, where before it could slip through. One residual exposure remains
by design and is documented as such: a value captured from a response through a
state link is re-sent verbatim on replay, so a producer that captures a secret
into a bundle carries it in the trace.

## ADR-061 — Latency degradation under load is a concurrency ladder on the performance options, anchored on a real request { #adr-061 }

**Status:** accepted · `models/runtime/options.py`, `models/runtime/stats.py`, `runtime/runners/performance/ladder.py`, `runtime/runners/performance/degradation.py`, `runtime/runners/performance/runner.py`, `runtime/runners/performance/constants.py`, `models/runtime/crash_report.py`, `runtime/oracles/rules.py`

### Context

The performance mode scaled request **volume** against a single, fixed latency
SLA: it asked *"is every response under this threshold?"* and nothing more.
Nothing in the engine compared latency **across load levels** — the failure mode
where an endpoint is fine when idle and collapses under concurrency was invisible.
An SLA cannot express it: a threshold that passes at one request in flight passes
at fifty, and one that fails at fifty fails at one; neither says *latency grew
because the load grew*. Answering that needs at least two measurements at
different concurrencies and a comparison between them — a shape the per-response
SLA oracle structurally cannot produce.

### Decision

**Model the load progression as a value object on the performance options.**
`ConcurrencyLadder` — a frozen `steps` tuple validated strictly increasing with at
least two entries, plus a `tolerance` ratio — hangs off
`PerformanceOptions.concurrency_ladder`. Absent, the mode is unchanged; present,
it drives a ladder run.

**Run each endpoint's valid phase once per step, at exactly N requests in flight,
through the run's own connection pool.** A step temporarily caps the shared
orchestrator's concurrency at that step's level, so "N in flight" is enforced by
the same pool that governs every other mode rather than a parallel executor. Each
step's budget is a stable floor rounded up to whole batches of `N × identities`,
so every identity's share is a whole number of full-concurrency batches and the
p95 is measured on enough samples to be meaningful.

**Judge each step against the first, and anchor the finding on a real request.**
The first step is the baseline; a later step degrades when its p95 exceeds the
baseline p95 by more than the tolerance. Percentiles are **nearest-rank**, so the
step's p95 is an observed sample — the runner keeps the actual `ExecutionResult`
at that index and anchors the `LATENCY_DEGRADATION` finding on it, with a synthetic
`{"concurrency_step": N}` reproducer naming the step. The invariant carries an
intrinsic rule (`runtime/oracles/rules.py`): *"a clean response's latency must not
grow with concurrency beyond the run's tolerance."*

**Record the full measurement as per-endpoint stats.** Every completed step lands
on `EndpointStats.load_profile` as a `LoadStepStats` (its concurrency, its latency
distribution, its degraded verdict). The profile is the record of what happened;
the finding only points into it.

### Rejected

- **A per-response oracle, like the latency SLA.** An oracle sees one response at
  a time and cannot see an aggregate across a step, let alone across steps. The
  degradation verdict is a comparison of two distributions — it has no meaning at
  the granularity an oracle judges.
- **A new finding shape for aggregate results.** Introducing a distinct
  aggregate-finding type would fork the findings pipeline — its own dedup,
  materialization, persistence and reporting — for a single case. Anchoring the
  degradation on the real request at the step's p95 lets it flow through the
  existing `RawFinding` → report path unchanged.
- **A field on the crash report naming the degraded step.** The `load_profile`
  already names every step and its verdict; a redundant field on the report would
  duplicate what the per-endpoint stats hold and drift from it.
- **Measuring drift over time or hunting resource leaks.** Latency creep across a
  long soak, or leaked connections and memory, need long runs and their own
  statistical machinery; they are a different question from *does concurrency slow
  this endpoint down*, and out of scope here.

### Consequences

The run report schema moves to **1.10**: each `endpoints[]` entry gains an additive
`load_profile`. Storage gains a `run_endpoint_stats.load_profile` JSON column, and
the analyses table's `stateful_config` becomes `execution_options` — the effective
options of **any** execution mode, not just stateful — so a performance run's
ladder is persisted with its recipe. The engine facade exports `ConcurrencyLadder`,
`LoadStepStats` and the typed `ConcurrencyLadderError`, raised before any request
when a step exceeds the run's `max_concurrency` or an endpoint funds no valid
baseline. Leaving the ladder unset changes nothing: the flat load run, an empty
profile, no degradation findings.

---

## ADR-062 — The engine exposes its own typed observer and cancellation token; a listener adapts them to the protocol { #adr-062 }

**Status:** accepted · `models/runtime/cancellation.py`, `models/runtime/observer.py`, `models/runtime/events.py`, `models/runtime/run_signals.py`, `models/runtime/run_status.py`, `models/runtime/trace.py`, `runtime/progress/constants.py`, `runtime/progress/emitter.py`, `runtime/progress/facts.py`, `runtime/__init__.py`

### Context

A long run gives a caller no way to stop it and no way to see inside it. Both are
needed: an interactive frontend must let a user abort a fuzz that is taking too
long, and it must paint progress while it runs. Yet the engine is a black box the
frontend never imports — the wire between them is a separate protocol — so the
engine cannot depend on that protocol's event shapes, its cancellation mechanism
or its transport. Whatever the engine exposes has to be self-contained and stay
meaningful to an in-process caller that speaks no protocol at all.

### Decision

**Two signals, each a Protocol the engine owns, each defaulting to a Null Object.**
Cancellation is a `CancellationToken` — one read-only `cancelled` property that
never raises — and watching is a `RunObserver` — one `on_event(event)`. The caller
holds a `CancellationSource` (the write side, `cancel()`), and hands the run only
its `token` (the read side); the run can never cancel itself. Absent either
signal, `run` wires `NULL_TOKEN` (never cancelled) or `NULL_OBSERVER` (swallows
every event), so no downstream path needs an `if observer is not None`, and a run
nobody watches builds no emitter and computes no counters.

**Events are frozen value objects discriminated by `kind`.** Each of the nine is a
slotted frozen dataclass carrying a `ClassVar` `EventKind`, and `RunEvent` is their
union. A listener switches on `kind` — a `StrEnum` — and never guesses a type;
adding an event is a new class in the union, not a new parameter anywhere.

**Cancellation is a value, never an exception.** A polled token that has tripped
becomes a `TruncationRecord` with reason `cancelled`, carried back on the trace
exactly like a budget or target-down cut. Inside stateless exploration the cut is
**sticky**: `mark_cancelled` sets it only when no earlier cut is present, and the
shrinker gates on the token immediately before its next send, so a cancelled
minimization abandons the finding rather than confirming it. Nothing is thrown to
unwind the run.

**A cancelled run is an honest result.** It returns a full `EngineRunResult` whose
`status` is a distinct `RunStatus.CANCELLED`, its findings not yet confirmed
counted `unverified`, no request sent after the mark, and the shared HTTP client
closed. The status says the caller stopped the run; it makes no claim about the
API. Cancellation **outranks** a soft budget or deadline cut but **not** a
confirmed dead target: a liveness probe or an all-breakers-open verdict is a fact
about the world and stands over a cancellation that arrived beside it.

**The waits are chunked.** The HTTP backoff and the replay pacer sleep through
`wait_chunks`, steps of at most `CANCELLATION_POLL_INTERVAL_S`, so a cancel is
noticed within that window instead of at the end of a full delay.

**Both signals travel as one `RunSignals` carrier**, built once by `run` and passed
down the `RunRequest`, so a runner takes a single value rather than two parameters
threaded everywhere. Behind `progress` sits a `ProgressEmitter` that forwards a
fact untouched and throttles a `tick` to `MIN_TICK_INTERVAL_S`, holding the run's
clock and its `sent`/`total`/`findings` counters.

### Rejected

- **Killing the run's thread.** A hard kill leaves the HTTP client, the trace and
  the counters in an arbitrary state — no honest result, no clean close. Reading a
  flag between units of work stops the run at a point where its record is
  consistent.
- **A callback per HTTP request.** At thousands of requests a second it would flood
  the listener with events carrying nothing the throttled counter does not already
  hold. Events fire at folding boundaries; the counter is a state snapshot, not a
  log.
- **Importing the protocol's event and cancellation types.** It would couple the
  engine to the wire and invert the dependency the black-box boundary exists to
  keep out. The engine owns plain in-process types; the listener maps them.
- **Signalling a cancelled run with `None` or an exception.** `None` erases the
  partial trace and counters the caller may still want; an exception forces every
  caller into a `try` for an outcome that is normal, not a failure. A cancelled run
  is a first-class terminal status.
- **An `asyncio.Event` tied to the engine's event loop.** Cancellation must be set
  from any thread — a signal handler, a UI thread — without reaching into the
  bridge loop the engine runs HTTP on. A `threading.Event` behind the source is
  loop-agnostic and safe to set from anywhere.

### Consequences

The facade exports the cancellation and observer surface — `CancellationSource`,
`CancellationToken`, `RunObserver`, `RunEvent`, `EventKind`, `TargetDownVerdict`
and the nine event classes — and `run` gains keyword-only `cancellation` and
`observer` parameters, both defaulting to their Null Object. `RunStatus` gains a
`cancelled` member and `TruncationReason` a `cancelled` reason. A caller that wants
neither is unaffected: the defaults make watching and stopping free. The CLI's
listener maps each event to a `progress` notification and derives what the engine
does not know — an endpoint's short number, a finding's stable id and severity, and
the narrowed wire status — so a new event never touches the protocol's routing.

---

## ADR-065 — The stateful suppression key carries the response status code, and progress ticks every executed step { #adr-065 }

**Status:** accepted · `runtime/fuzzers/stateful/violation.py`, `runtime/fuzzers/stateful/rule.py`, `runtime/fuzzers/stateful/probes.py`, `runtime/findings/deduplicator.py`, `models/runtime/findings.py`

### Context

A stateful run re-executes each candidate sequence many times as Hypothesis
shrinks it, so the same defect surfaces over and over. The machine suppresses a
defect it has already reported by keying it on a coarse `Signature`: where the
step broke (method and path), the invariant, the identity it was sent as, and the
rule the oracle named. Two things about that key were wrong.

The `Signature` left out the **response status code**, yet the findings layer
downstream already treats the status as part of a defect's identity: both
`ReportKey` (the crash-report dedup key) and `FindingSignature` (the grouping key
for flaky and unverified findings) carry `status_code`. The suppression key was
therefore *coarser* than the finding key it feeds — an endpoint breaking the same
invariant under the same rule and identity but answering `401` on one pass and
`500` on another is two distinct defects to the findings layer, but the stateful
machine suppressed the second as a duplicate of the first. A real second defect
went unreported.

Separately, the progress counter moved only **once per completed pass**. A pass
that chains many requests left the counter frozen for its whole duration, so an
observer watching a long sequence could not tell a slow run from a stuck one.

### Decision

**The suppression `Signature` carries the status code, so it agrees with the
findings layer on what makes a defect distinct.** Its fields are the method, the
path, the invariant, the response status code, the identity label and the rule id
— the same axes `FindingSignature` uses. The same endpoint, invariant, rule and
identity failing with two different status codes now yields two findings, one per
status, instead of one swallowing the other.

**The response body is deliberately not part of the key.** A body varies between
re-executions of the same logical defect — timestamps, generated ids, echoed
input — so keying on it would treat one defect as many and defeat suppression
entirely. The status code is stable across re-executions of the same defect and
distinguishes genuinely different ones; the body does neither.

**Progress ticks on every executed step and every transition probe**, on top of
the existing per-pass tick. Each request the machine sends — a rule step and a
transition probe alike — records its result and advances the counter, so the
counter tracks work within a pass rather than only at its boundary. The
`ProgressEmitter` still throttles what an observer receives to one tick per
`MIN_TICK_INTERVAL_S`, so the extra ticks keep the run's own count truthful
without flooding a listener.

### Rejected

- **Keying suppression on the response body.** The body is the least stable thing
  about a re-executed defect; a key that includes it never matches its own earlier
  occurrence, so nothing is ever suppressed and the shrinker re-reports the same
  defect on every pass.
- **Leaving the suppression key coarser than the finding key.** If the two keys
  disagree on what "distinct" means, a defect the findings layer would count as new
  is silently dropped upstream before it reaches that layer. The two must define
  identity the same way; the status code is where they differed.
- **Ticking once per pass only.** The counter freezes for the length of a long
  sequence, and an observer cannot distinguish progress from a hang. A per-step
  tick keeps the count moving with the work.
- **Emitting one event per request with no throttle.** At the rate a sequence
  sends, a raw per-request event carries nothing the throttled counter does not
  already hold. The emitter collapses ticks inside the throttle window, so a
  per-step tick is safe.

### Consequences

A stateful run now reports one finding per distinct status code for the same
endpoint, invariant, rule and identity, consistent with the crash-report and
finding-group keys. Progress advances within a pass, not only at its end, while an
observer still sees at most one tick per throttle window. Nothing about the coarse
key beyond the added status field changes, and the body remains outside it.
