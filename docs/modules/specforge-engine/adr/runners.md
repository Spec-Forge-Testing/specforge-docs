# Spec Forge Engine — Decision records — Runners

Part of the [Spec Forge Engine decision records](index.md). Decisions about how far
each runner gets into an API: when a stateful run stops, how it tells one defect
from another, where stateless takes the values it addresses resources with, how a
whole-request rejection is told from a state conflict, and how resilience aims at
a real resource, tells a crash from an intermittent error, and what a runner does
with a link into a reserved header. The behaviour is
described in [Run depth](../run-depth.md) and [Stateful depth](../stateful-depth.md).

---

## ADR-162 — A stateful run continues until a pass finds nothing new, under a ceiling of 25 distinct defects { #adr-162 }

**Status:** accepted · Superseded in part by [ADR-206](#adr-206) · Its stop condition superseded by [ADR-191](#adr-191) · `constants.py`, `models/runtime/options.py`, `runtime/fuzzers/stateful/supervisor.py`, `runtime/fuzzers/stateful/constants.py`

### Context

A stateful pass ends at its first violation, which Hypothesis then shrinks. A run
of one pass therefore reports one defect, and the first broken producer hides
every endpoint behind it: its consumers never get a value to draw. On the lab API,
a stateful run exercised 4 to 6 of its 20 endpoints.

Running more passes is not enough on its own. If any new report counts as
progress, a defect that fires on a range of values (any negative amount) comes
back with another value on every pass, and the run never reaches a pass that
finds nothing.

### Decision

**The run stops at a fixed point.** The supervisor keeps running passes while
each one changes the run's progress, `_RunProgress`, in one of four ways:

| A pass counts as progress when it | Bounded by |
| --- | --- |
| reports a defect whose signature and trigger fields no report holds yet | the ceiling |
| ends flaky on a signature not seen flaky yet | the ceiling |
| widens the suppression of a defect found again on another value ([ADR-163](#adr-163)) | once per signature and trigger fields |
| ends flaky with no violation to sign | `STATEFUL_UNEXPLAINED_FLAKY_PASSES` (2) |

A defect found again with the same signature and trigger fields is folded into
the report that holds it, whose `represented_findings` grows by one; it is not
new. A pass that changes none of the four is dry, and the run ends.

**The ceiling is a safety net.** `StatefulOptions.max_distinct_bugs` defaults to
`STATEFUL_MAX_DISTINCT_BUGS` (25), and the run stops once either the distinct
confirmed reports or the distinct flaky signatures reach it. The flaky count is
bounded too because a flaky signature carries its response's body fingerprint,
which a target could vary without end. The field stays public and persisted: it
is part of a run's recipe, and a caller who wants the first defect only sets it
to `1`.

The pattern is a fixed-point iteration with a circuit breaker.

### Rejected

- **Quarantining the endpoint whose defect was found.** A broken producer would
  leave every consumer of its bundle without values.
- **Recording a violation without raising it, to keep the pass going.** Hypothesis
  shrinks only a raised failure, so the report would lose its minimal payload.
- **Counting every new report as progress.** A range defect never lets the run
  dry.
- **Retrying a flaky pass without a violation without limit.** A target that
  drops connections now and then would keep the run alive forever.

### Consequences

Measured over three repetitions on the lab API against the single-pass engine,
under the same conditions: 20 of 20 endpoints exercised in every repetition
(4 to 6), and 11 to 13 confirmed defects (0 to 1), among them a soft delete
reported as `state_transition` from the specification alone
([ADR-168](../../core/adr/core.md#adr-168)). Every run ended on a dry pass, after
15 to 16 passes, in 36 to 45 seconds (6 to 11). The dry pass itself, a full pass
of examples that finds nothing, is most of that cost, not the ceiling. On the
RealWorld Go target, the stateful run exercised 6 to 13 of 19 endpoints and
confirmed up to 9 defects, where it stopped at its first step.

A pass can still cost its examples' steps plus up to
`STATEFUL_SHRINK_REQUEST_BUDGET` requests to each of its two shrinks
([ADR-089](engine.md#adr-089)); the ceiling bounds how many such passes a run
spends.

---

## ADR-163 — A stateful defect is suppressed by its report's signature and the fields that triggered it, and a range defect widens its suppression once { #adr-163 }

**Status:** accepted · Supersedes in part [ADR-065](engine.md#adr-065) · `runtime/fuzzers/stateful/suppression.py`, `runtime/fuzzers/stateful/step_triggers.py`, `runtime/fuzzers/stateful/violation.py`, `runtime/fuzzers/stateful/supervisor.py`, `runtime/fuzzers/stateful/reporting.py`

### Context

Once a run continues past its first defect ([ADR-162](#adr-162)), each later pass
must look past the defects already reported, and no further. The stateful
machine suppressed a defect on a key coarser than the report's own signature: it
left out the response's body fingerprint, so two defects of one endpoint with
differently shaped bodies were one. A key on the signature alone is still too
coarse: two fields that each make an endpoint answer the same 500 are two causes
with one symptom. A key on the exact payload is too fine: a defect that fires on a
range of values returns with the next value.

### Decision

**The suppression uses the signature the report carries.** `step_signature` builds
the same `FindingSignature` the report is grouped by, body fingerprint included,
on the **shrunk** step. Identity tells two signatures apart only for an access
invariant, as in every report ([ADR-106](engine.md#adr-106)), so the same 500 under
two identities is one defect.

**A defect is a signature and its trigger fields.** The trigger fields of a shrunk
step are the fields it sent off its endpoint's simplest stateful draw, the draw
`SimplestDraws` computes once per endpoint without sending anything. Fields a
bundle injected are left out: they always differ from the simplest draw and are
never the cause. A transition probe has no trigger fields. The report carries them
as `request.trigger_fields`. `SuppressedDefects` is a Specification: a later
violation is covered only when it has a reported signature **and** sent the
reported values in each of that report's trigger fields. Two causes behind one
symptom become two reports.

**A range defect widens its suppression, once.** When a pass's defect folds into a
report that already holds its signature and trigger fields, it came back on
another value. `widen` then adds an entry that covers the signature on any step
that sent off the simplest value in every trigger field, and in no other field
outside those injected. Each signature and trigger-field set widens once, so the
widenings are bounded by the reports, and the pass that widened counts as
progress.

### Rejected

- **Keeping the key without the body fingerprint.** Two defects with different
  bodies stay one. The fingerprint is a shape, not the body's values
  ([ADR-150](findings.md#adr-150)), so it is as stable across re-executions as the
  status code.
- **Computing the trigger fields before the shrink.** Against the simplest draw,
  nearly every field of a random draw differs, so the key would match nothing.
- **Keying on the reproducer's values.** A range defect re-reports itself on every
  pass, up to the ceiling.
- **Widening to every value of the signature.** It hides a second cause with the
  same symptom.
- **Probing members, as the stateless cause walk does.** It spends requests on
  every pass; the progress rule already keeps a re-shrunk defect from extending
  the run.

### Consequences

Two planted defects that share a symptom on the lab API are reported apart. Two
defects that share both the symptom and the trigger field stay folded into one
report, whose `represented_findings` counts both. A widened entry hides only steps
its trigger fields explain: a step that also sent another field off its simplest
value escapes, is shrunk, and keys its own report.

---

## ADR-164 — A shrink that fails inside Hypothesis keeps its witness, and the engine requires the Hypothesis release that shrinks narrow strings safely { #adr-164 }

**Status:** accepted · `runtime/fuzzers/stateful/outcome.py`, `runtime/fuzzers/stateful/collector.py`, `runtime/fuzzers/stateful/supervisor.py`, `pyproject.toml`

This record joins two decisions about the same failure: how the run survives an
error inside the library's shrinker, and which releases of the library it runs on.

### Context

Hypothesis releases before 6.170.3 can raise a `ValueError` inside the shrinker
when a stateful run draws a string from a narrow alphabet, which any `format` or
`pattern` compiled to a regex produces: the shrinker retries a string node with
the earlier value under the new node's constraints. On the RealWorld Go target,
`PUT /user` reached it as soon as its credential fields drew usable values
([ADR-171](compiler.md#adr-171)). The pass ended `MachineFailed`, the run was cut
`engine_failure`, and a violation the pass had already witnessed was lost.

### Decision

**The engine requires `hypothesis>=6.170.3,<6.170.10`.** The floor is the release
that fixes the shrinker. A regression test runs the stateful shrink over every
`FORMAT_PATTERNS` entry. The cap holds because `hypothesis-jsonschema` 0.23.1
relies on `many.more()`, whose behaviour changes in 6.170.10; it moves when that
library does.

**A failure inside the library keeps the witness.** When a pass ends
`MachineFailed`, the collector already holds a shrink witness, and the error was
raised inside the Hypothesis package (by the frame that raised it) without being a
`HypothesisException`, the pass ends as `ShrinkCutShort(witness)`. It is settled on
the wire as a pass the shrink budget cut short: re-sent once, reported if it
reproduces, flaky if not. The error is logged as a warning with its traceback.

**An error of the engine still truncates.** An error raised in the engine's own
code, or a `HypothesisException`, which is the library refusing how the engine
used it, ends the machine with `engine_failure`, the only visible signal of a bug
in the engine.

The pattern is graceful degradation behind a bulkhead: the failing step falls back
to the last good result, and only the library's own failure is absorbed.

### Rejected

- **Absorbing every failure that has a witness.** It would hide the engine's own
  bugs, whose only trace is the truncation.
- **Pinning one exact release.** It blocks every fix.
- **Patching the library's shrinker.** The engine would own a fork of code it does
  not maintain.

### Consequences

On the Go target, the stateful run goes past `PUT /user` without a cut. The protocol has
no field for a diagnostic that does not truncate, so an absorbed failure shows only
in the engine's log.

---

## ADR-165 — Stateless draws path and query values from what the run's successful responses returned, and runs producers first and deletes last { #adr-165 }

**Status:** accepted · Superseded in part by [ADR-214](#adr-214) · `runtime/fuzzers/stateless/corpus.py`, `runtime/fuzzers/stateless/corpus_overlay.py`, `runtime/fuzzers/stateless/constants.py`, `runtime/fuzzers/stateless/folding.py`, `runtime/fuzzers/stateless/shrinking.py`, `runtime/fuzzers/stateless/example_counts.py`, `models/runtime/draw.py`, `runtime/ordering.py`, `runtime/runners/stateless.py`, `constants.py`

### Context

A stateless run explores each endpoint on its own, so it invents the identifiers
in a path. An invented identifier almost never addresses an existing resource: on
the RealWorld Go target, 54 % of the `valid` phase was answered 404, and 14 % on
the lab API. The endpoints behind an identifier were explored on their not-found
path only. The values that would address them are in the run's own responses.

### Decision

**A run keeps a corpus of returned values.** `ObservedValues` is a Blackboard the
stateless fuzzer owns for the whole run. It harvests what an explored request got
back, only on a 2xx:

- the value each declared production captures (`capture_if_present`), kept under
  its bundle's name;
- every JSON leaf named `id`, `slug`, `username`, `*_id` or `*Id` (normalized to
  snake case), kept under that name.

Only a string or an integer that survives as a path segment is kept. The shrink
and the control requests do not harvest. The `performance` runner builds its
fuzzer without a corpus (`keep_observed_values=False`), a Null Object.

**Each value records its provenance.** A value is `created_by_run` when a declared
production captured it from a `POST`, or from any `201`; anything else is `read`.
A created value never falls back to read.

**The valid draw overlays corpus values.** `with_observed_values` wraps the valid
phase's strategy, in the path and query zones only. A path field takes a corpus
value in `PATH_CORPUS_SHARE_PERCENT` (80 %) of the draws, a query field in
`SEED_SHARE_PERCENT` (20 %); the rest keep probing the not-found path. A field
looks up the bundle it consumes first, then its own normalized name. The overlay
never touches the poisoned field and never adds a field. It reads a snapshot taken
once per endpoint, so Hypothesis sees a fixed domain.

**A request that changes data uses only what the run created, unless the run
consents to side effects.** At an endpoint whose method is not safe, every
overlaid field draws only values the run created. A run that allows side effects
(`ExecutionConfig.allow_side_effects`, the same consent that lifts the safety
guard) may also reuse values it only read: whoever consented to the run changing
data has accepted that it may change data it did not create. Either way, such a
request never takes a value a finding pinned. `_lookup` in `corpus_overlay.py`
picks the reader: `values_for` for a safe method, `destructive_values_for`
(created and unpinned) without consent, `unpinned_values_for` (created or read,
unpinned) with it.

**A finding pins its values.** Shrinking runs after every endpoint is explored, so
a later `DELETE` could remove the value a finding needs to reproduce. Folding a
finding pins the corpus values it sent, and a data-changing request never takes a
pinned value. A 2xx `DELETE` forgets the path values it sent.

**The shrink holds corpus values.** The fields a draw took from the corpus
(`ZoneDraw.observed_fields`) are held fixed while the payload shrinks, and they
are never trigger fields.

**Producers run first and deletes last.** `order_by_state_flow` sorts the
endpoints by whether they delete, then by their layer in the state-link graph, a
producer before its consumers. The sort is stable over the risk order, so risk
still breaks ties; endpoints that produce for one another in a cycle share a
layer. It applies to the stateless runner only.

The patterns are a Blackboard with a Snapshot per reader, pinning for the values a
finding holds, and a Null Object for a run without a corpus.

### Rejected

- **A deferred strategy over the live corpus.** The domain would change under
  Hypothesis while it shrinks.
- **Writing corpus values into the request after the draw.** The shrink would not
  see them, so it could not hold them.
- **State links only.** A parameter no link declares (`{username}`) would still be
  invented.
- **The 20 % share in the path zone too.** Measured on the Go target, the 404 share
  only fell to 42.5 %.
- **Letting a data-changing request use any value without consent.** It would
  modify or delete data the run did not create, such as the identity's own user.
- **Created values only, even with consent.** The consent already covers changing
  data the run did not create, and on the Go target the restriction alone costs 13
  points of 404 share.
- **Letting a consented request take a pinned value.** A later change could stop a
  finding from reproducing when it is shrunk.

### Consequences

Measured over three repetitions per target against the engine without the corpus,
under the same conditions. On the lab API, the 404 share of the `valid` phase went
from 14 % to 0.8 %, with no signature lost. On the RealWorld Go target, 2xx answers
in `valid` rose from about 460 to 850–1 090, endpoints with at least one 2xx from 8
to 16–17 of 19. The 404 share of `valid` fell from 54 % to 34 % without consent to
side effects, and to 21 % with it. The gap is the cost of the rule without
consent, taken on purpose: `POST /profiles/{username}/follow` got no 2xx in those
runs, since it may act only on usernames the run created.

A replay is still exact: the trace records each request's URL and path
parameters.

---

## ADR-166 — A whole-request rejection is refuted only by positive proof of a state conflict { #adr-166 }

**Status:** accepted · `runtime/fuzzers/stateless/control_checks.py`, `runtime/fuzzers/stateless/rotated_strings.py`, `runtime/fuzzers/stateless/shrinking.py`, `runtime/findings/grouper.py`

### Context

A `contract_completeness` finding whose rule is `request` is a 400 or 422 to a
conforming request that names no field ([ADR-143](engine.md#adr-143)). Many of them
are conflicts with stored state: a username already taken, a title that must be
unique. The request is valid, the server rightly refuses a duplicate, and the
contract is not incomplete.

The obvious control, sending fresh values once and calling the finding refuted if
they are accepted, also refutes real validations the contract does not declare.
New values can swap an order (an end before a start), avoid a reserved name or fix
a checksum. Each of those would be accepted once and ruled "not a defect": a false
green.

### Decision

**The control check applies to the whole-request rule only.** `CONTROL_CHECKS`
gains an entry for `contract_completeness` whose `applies` is true only when the
rule is `request` (`WHOLE_REQUEST_RULE_ID`).

**Its payload rotates strings within their class.** `rotated_payload` replaces each
ASCII letter or digit with the next one of its class (`a`→`b`, `Z`→`A`, `9`→`0`)
and keeps every other character, so each string keeps its length and its classes.
It rotates only body and query strings, and keeps:

- a string declaring `enum`, `const`, `format` or `pattern`;
- anything under a schema the engine does not model (`allOf`, `oneOf`, `anyOf`,
  `$ref`, `additionalProperties`), files and bytes;
- path and header values, which would address another resource or credential.

An empty string stays empty, so a rejected `username: ""` stays a confirmed
finding. When nothing rotates there is no control, and the finding stands.

**Refutation needs two answers.** The rotated payload is sent; if it is accepted
(2xx), the identical payload is sent again. The finding is refuted only when the
resend repeats the original rejection: the same status and violation, in a body
whose shape matches the original's at every depth (`body_shape`: keys and value
types, never values). Accepted once and then rejected the same way means the first
send left the state the second one conflicts with. Accepted twice means the
rejection depended on the value, and the finding is confirmed with the resend as
its control.

The pattern is a Specification for which findings a control judges, with a
replicated control.

### Rejected

- **One accepted control.** It refutes undeclared validations.
- **Matching words in the body** (`already exists`). It depends on the server's
  language and framework.
- **A `state_conflict` invariant.** A conflict with stored state is not a defect of
  the API.
- **A new shrink verdict.** `refuted` already says it.

### Consequences

On the RealWorld Go target, the uniqueness 422 of `POST /articles` is refuted in 2
of 3 runs, and the rejection of a password shorter than the server's undeclared
minimum stays a confirmed finding. A server that answers every rejection with one
generic body, and enforces both a reserved name and uniqueness on one field, can
still be refuted wrongly; that is why a refuted finding is listed with its control
([ADR-167](findings.md#adr-167)). The stateful mode has no control request.

---

## ADR-169 — Resilience attacks a real resource of the owner with a valid base request, and sends nothing to an owner-only endpoint no valid identity can own { #adr-169 }

**Status:** accepted · Supersedes in part [ADR-108](engine.md#adr-108) · `runtime/runners/provisioning/`, `runtime/runners/resilience/base_request.py`, `runtime/runners/resilience/owner_binding.py`, `runtime/runners/resilience/identity.py`, `runtime/runners/resilience/runner.py`, `models/runtime/stats.py`; `tests/test_layering.py`, `tests/test_runner_traits_gate.py`

### Context

Every attack targets one base request per endpoint. Its path parameters were
placeholders and it carried no body. On the lab API, an `owner_only` endpoint
answered 403 to the whole battery, because the placeholder addressed a resource of
someone else, and every `POST` and `PUT` answered 400, because it had no body. A
base request that fails excuses the battery ([ADR-108](engine.md#adr-108)), so
those endpoints were measured on their authorization and validation layers, never
on how they handle a broken request.

The `auth` runner already provisions an owner's resource, but in its own package,
so `resilience` could not use it without depending on another runner.

### Decision

**Provisioning is a package of its own.** The owner-resource registry, the
producer chain, the provisioning payloads and the producer watch live in
`runtime/runners/provisioning/`, which `auth` and `resilience` both import. A
layering gate forbids `auth` and `resilience` to import each other, and
`provisioning` to import either.

**The base request is the endpoint's minimal valid request.** `base_payload` is the
simplest draw of the endpoint's `valid` strategy, in every zone
(`minimal_provisioning_payload`); a path parameter the draw leaves out keeps a
placeholder.

**An `owner_only` endpoint is attacked on its owner's resource.**
`OwnerResourceBinder` binds the owner's bundles through the shared registry, which
provisions each bundle once per run under the first valid identity and reuses it,
and writes the values into the base request. After the battery of an endpoint
whose method is not safe, the resource is forgotten, since the attacks may have
changed or deleted it, and the next use provisions a new one. When it cannot be
bound, the endpoint is left unprobed with the provisioning's reason
(`owner_producer_missing`, `owner_chain_cyclic`, `owner_resource_unprovisioned`); a
target found down stops the run.

**No owner, no battery.** An `owner_only` endpoint with no valid identity declared
is left unprobed with the new `UnprobedReason.OWNER_IDENTITY_MISSING`, and nothing
is sent to it. It counts under `access_preconditions_unmet`, like the other access
preconditions.

**The runner declares what it now takes from the plan.** `resilience` consumes the
`valid` phase, so the strategy changes its payloads: in the effects matrix,
`security` and `exposure` read `payloads`, and `field_hints` with the `fixture` or
`inference` producer. Provisioning requests are recorded in the trace and counted
in `total_requests`, as in `auth`.

The patterns are Extract Module for the shared provisioning, and a Strategy for
where its results are recorded.

### Rejected

- **Keeping placeholder identifiers.** The battery measures the authorization layer.
- **Attacking an owner-only endpoint anonymously, or under any identity.** The
  same.
- **Copying the provisioning into `resilience`.** Two copies drift.
- **Importing it from `auth`.** It couples one runner to another.

### Consequences

Measured on the lab API, the base request of every `POST`, `PUT` and `DELETE`
endpoint answers 2xx, so the battery is judged on every one of them. An
`owner_only` endpoint costs its provisioning requests, again after each battery of
an unsafe method.

---

## ADR-170 — A resilience server error is confirmed by resending its attack, and is never refuted { #adr-170 }

**Status:** accepted · `runtime/runners/resilience/confirmation.py`, `runtime/runners/resilience/result_routing.py`, `runtime/runners/resilience/runner.py`, `runtime/runners/resilience/constants.py`, `runtime/findings/stats.py`, `runtime/findings/materializer.py`; core `services/finding_summary/sentences/performance.py`

### Context

A 5xx under attack was blamed on the attack the moment it was seen. An endpoint
that fails at random, on the lab API about 15 % of its requests, was reported as
degraded by whichever attack drew the failure. Resending the **clean** base request
to check was already rejected ([ADR-108](engine.md#adr-108)): an attack that leaves
the endpoint broken makes the clean request fail too, and the degradation would be
excused.

### Decision

**The attack is resent, not the clean request.** After an endpoint's battery is
recorded, and only when the run-wide target watch did not find the target down,
each server-error signature blamed on an attack is settled serially. Every distinct
attack behind the signature is resent `RESILIENCE_RESENDS` (2) times, each time on a
fresh base request (provisioned again after an unsafe method).

| What the resends showed | The finding is |
| --- | --- |
| one attack got the signature back on every resend | **confirmed**; the clean base request is then sent once and attached as its `control` |
| every attack missed it on some resend, and every resend was answered | **flaky** |
| a resend got no answer (no status, a target failure, 429, 502, 503 or 504), or could not be sent (the run was cancelled, the resource could not be provisioned) | left **confirmed**: there is nothing to judge it against |

Each signature is settled behind its own bulkhead: one whose confirmation raises is
left confirmed, and the error is logged. The confirmation's requests, its
provisioning included, are counted in `requests_shrink` and kept out of the trace;
the target watch still sees them.

**There is no refuted outcome in resilience.** A signature reaches confirmation
only when the clean base request sent **before** the battery succeeded. A clean
request that fails **after** the resends means the attack left the endpoint broken,
the most serious outcome there is, not a sign that the attack was harmless.
Refuting it would be a false green. The control is evidence: the finding's summary
says either that the attack left the endpoint broken (the control got no status,
or a 5xx) or that the endpoint recovers and only the attack breaks it.

The pattern is a retry with a control group.

### Rejected

- **One reproducing resend is enough.** At a 15 % random failure rate it confirms
  about a quarter of the intermittent errors. Requiring both resends lets a false
  confirmation through 2.25 % of the time.
- **Refuting when the clean control fails too.** A false green, as above.
- **Resending one attack for the whole signature.** Another attack behind the same
  signature may be the one that reproduces.
- **Counting an unanswered resend as not reproduced.** A target that throttles or
  goes down would turn a real crash flaky.

### Consequences

On the lab API, the endpoint that fails at random is reported flaky, and the real
crashes stay confirmed in every repetition. A resilience run now reports flaky
findings and `requests_shrink`. A confirmed resilience finding costs at least two
more requests per signature, plus the control.

---

## ADR-183 — A whole-request rejection gets a second control holding the run's corpus values, sent only to refute { #adr-183 }

**Status:** accepted · Extends [ADR-166](#adr-166) · `runtime/fuzzers/stateless/control_checks.py`, `runtime/fuzzers/stateless/control_payloads.py`, `runtime/fuzzers/stateless/control_verdict.py`, `runtime/findings/causes/triggers.py`

### Context

The whole-request control rotates the strings of a rejected request and resends it
([ADR-166](#adr-166)). When the request addressed a resource through a value it
took from the run's corpus (an id, a slug, a username the run created), the rotated
control addresses another resource, and its answer says nothing about the one the
rejection was about. Holding the corpus values in every control is not safe
either. The corpus also holds values the run created, which are the very values a
uniqueness rule rejects, so a held control repeats a state conflict and confirms
it as a defect. And a control identical to the reproduction resends the cause of a
timeout and refutes a real finding.

### Decision

**A second control, only to add refutations.** `ControlCheck.holds_corpus` is set
for the whole-request check only. The control of [ADR-166](#adr-166) is sent first,
as it is. When it does not refute, and the same payload with the corpus values
held differs from both the reproduction and the first control, that payload is sent
as well, with its own resend. It counts only when it refutes; otherwise the first
control's verdict stands. The held values come from the finding's raw payload, the
fields its draw took from the corpus.

**The other controls do not hold.** For a timeout, the corpus value can be the
cause under suspicion. The mass-assignment control keeps the corpus values in its
one payload, because without them the resource changes and the finding is left
unverified for the wrong reason ([ADR-182](findings.md#adr-182)).

### Rejected

- **Holding the corpus in every control.** A created username repeats a 409 and
  confirms it; a timeout on a heavy resource is resent and refuted.
- **Replacing the first control with the held one.** It loses the discrimination
  the first control has against a state conflict.

### Consequences

A rejection that is a conflict on the very resource the request addressed can be
refuted. A finding costs at most two controls, each with its resend, and the
second only when the first does not refute. A second send can collide with the
state the first one left, which makes it refute less, the safe direction.

---

## ADR-184 — An endpoint whose state link writes into a reserved header is left unprobed by the runners { #adr-184 }

**Status:** accepted · Extends [ADR-119](engine.md#adr-119), [ADR-169](#adr-169) · `runtime/http/reserved_headers.py`, `runtime/runners/provisioning/reserved_links.py`, `runtime/runners/provisioning/chain.py`, `runtime/runners/provisioning/owner_resources.py`, `runtime/runners/provisioning/plan.py`, `runtime/runners/auth/crossing.py`, `runtime/runners/resilience/owner_binding.py`, `models/runtime/stats.py`, `models/runtime/labels.py`; core `services/history/rules.py`

### Context

A state link can bind a produced value into a header (`Authorization` from a
login's token). The credential headers belong to the identities and
`Content-Type` to the transport ([ADR-119](engine.md#adr-119)), so the injector
drops a generated value with a reserved name. A runner that writes the bound value
there, and lets each identity send its own credential, crosses with something
other than what it claims and confirms `access_control` findings that are false.
Provisioning an owner's resource through such a producer loses the value the same
way, and fails under the wrong reason. The stateful mode refuses such a link when
it compiles a rule.

### Decision

**One predicate, two policies.** `is_reserved_link_target(zone, name, reserved)`
is the one rule. The stateful mode keeps raising `StatefulLinkError` at compile
time: a rule that cannot write its value is a broken rule, with no endpoint to
leave out. The runners leave the endpoint `unprobed` with
`UnprobedReason.LINK_TARGET_RESERVED`: one endpoint never takes the run down, and
a half crossing would be a false finding.

**Reserved for the callers that really cross.** The reserved set is the union of
what each caller sends, config and identity headers merged as the request builder
sends them (`reserved_for_sender`); an anonymous caller reserves only the
transport's names. A header only the owner sends does not leave the endpoint
unprobed for another caller.

**Decided before anything is sent.** `OwnerResourceRegistry.bind_for(endpoint,
bundles, callers)` is the one entry for `auth` and `resilience`: it checks the
endpoint's own links, then binds. When the owner's resource is provisioned,
`plan_bundle_chain` skips a producer whose links target a header the owner
reserves and falls back to the next producer of the bundle; only when no producer
is usable is the reason `link_target_reserved`. No producer or dependency request
is sent in vain. A policy reason of the endpoint (declared public, undeclared
access) still wins.

The reason counts under `access_preconditions_unmet`, which makes the run's
signal `degraded`.

### Rejected

- **Checking identity by identity.** The endpoint is crossed by some callers and
  not by others: a half crossing.
- **Failing the compilation.** It takes the run down for one endpoint.
- **A guard in each planner.** Four copies of one rule; the façade holds it once.

### Consequences

On the lab API, an endpoint whose session token is bound into `Authorization` is
left unprobed with `link_target_reserved` and no request sent; sending each
identity's own credential there would confirm three false `access_control`
findings. An `auth` run whose only endpoint with a policy to cross is left
unprobed this way fails with
`EXECUTION_FAILED` and names the reason, the rule of a run that crossed nothing
([ADR-102](engine.md#adr-102)); with any crossable endpoint beside it, the run
completes and lists the endpoint as unprobed.

---

## ADR-187 — An inferred rule is witnessed in the valid pass, by a value derived within a bound { #adr-187 }

**Status:** accepted · Extended to stateful steps by [ADR-191](#adr-191) · `runtime/fuzzers/stateless/witnesses.py`, `runtime/fuzzers/stateless/example_counts.py`, `strategy_compiler/witness_values.py`, `strategy_compiler/constants.py`

### Context

A rule the produced contract declares and the spec leaves out narrows every valid draw,
so a valid pass obeys it. A rejection that the same field gets without that contract no
longer appears, and adding knowledge loses a finding. The `boundary` phase crosses
rules, but `smoke` and `exposure` have no such pass.

### Decision

**Every valid pass sends, after its minimal request, one witness per field that infers
a keyword.** A witness is the minimal payload with that field at a value the spec takes
and only the inferred rule forbids. It sits in the valid pass so that every strategy has
it, and inside the pass's share so that it spends no extra budget.

**A witness's value follows from the keyword.** The nearest value past a rule's edge is
computed. Only keywords that derive nothing are searched, within
`WITNESS_SEARCH_EXAMPLES` candidates and `WITNESS_WALL_BUDGET_S` per endpoint's plan.

**Past a limit, no witness.** 64 elements; 1024 characters in a path, query or header,
65536 in a body; weight 128 for `uniqueItems`. A value is never trimmed to fit.

**A witness is not shrunk.** It is already the simplest value. The request carries
`RequestOrigin.WITNESS`, so the shrink does not have to infer that from its phase.

### Rejected

- **A filter over one strategy holding every field's candidates.** Its cost grows with
  the fields, is paid while planning before any deadline starts, and loses witnesses at
  random.
- **Sending the witnesses only in `boundary`.** Strategies with no such pass would lose
  the finding.
- **Trimming a value to the limit.** A trimmed value no longer breaks the rule.

### Consequences

A witness and the `boundary` draw over the same rule are two findings of one `rule_id`,
as their reproducers differ. A rule whose edge lies past a limit has no witness. A share
smaller than the witnesses sends the first ones. A stateful run sends none, so
field-level `contract_completeness` on an inferred rule comes from stateless runs
([Witnesses](../witnesses.md#stateful)).

---

## ADR-188 — A stateful run keeps a witness Hypothesis calls flaky, and its passes are bounded { #adr-188 }

**Status:** accepted · Superseded in part by [ADR-207](#adr-207) · Extended by [ADR-206](#adr-206) · Extends [ADR-162](#adr-162) · `runtime/fuzzers/stateful/outcome.py`, `runtime/fuzzers/stateful/minimizer.py`, `runtime/fuzzers/stateful/supervisor.py`, `runtime/fuzzers/stateful/constants.py`

### Context

Hypothesis replays a failing sequence to shrink it. Against a live server the replay can
take another path, and Hypothesis then ends the pass with a flakiness error or fails
inside its own shrink. The engine held a real violation at that moment, and discarding
it loses the finding. Some of those errors would have stopped the run.

With `refuted` and `unverified` findings counting as progress, and repeated ones widening
their suppression, the loop until a pass finds nothing new has no natural end on a
target that always gives something new.

### Decision

**The witness is kept and verified by re-sending it.** A pass Hypothesis called flaky,
or failed while shrinking, ends cut short on the violation in hand. Its sequence is
re-sent verbatim: if it reproduces, it is minimized and judged as any other finding; if
not, the pass is flaky. An error over how the engine used Hypothesis is not treated this
way.

**Passes are bounded by `STATEFUL_MAX_PASSES` (100).** A run reaching it ends `truncated`
with reason `pass_limit_reached`, so a reader sees the depth was cut.

### Rejected

- **Trusting Hypothesis's verdict.** Its replay is one more request against moving
  state; the re-send is the test the engine trusts everywhere else.
- **Reporting the witness without verifying it.** The report promises a sequence that
  reproduced on the wire.
- **A bound by time alone.** `deadline_ms` is the caller's choice and may be unset; a
  pass count bounds the loop in every run.

### Consequences

A stateful run costs more requests on a target that makes Hypothesis flaky, and goes on
past it. A run reaching the limit is `truncated`, and does not compare as a complete one.

---

## ADR-191 — A stateful pass draws the same shape whatever the target answers, the run stops after two dry passes, and one more pass aims at what it never reached { #adr-191 }

**Status:** accepted · Superseded in part by [ADR-205](#adr-205), [ADR-206](#adr-206) · Supersedes in part [ADR-162](#adr-162) · `runtime/fuzzers/stateful/rule.py`, `runtime/fuzzers/stateful/machine_builder.py`, `runtime/fuzzers/stateful/step_witnesses.py`, `runtime/fuzzers/stateful/supervisor.py`, `runtime/fuzzers/stateful/reach_pass.py`, `runtime/fuzzers/stateful/probes.py`, `runtime/fuzzers/stateful/minimizer.py`

### Context

Hypothesis bundles fill from the target's answers, so a rule is eligible only once
an earlier step succeeded. A repeated create that fails changes which rules
Hypothesis can pick on its replay, and Hypothesis aborts the pass as inconsistent
generation: most runs against a real API would be cut. Hypothesis's simplest case
repeats the first rule with its minimal payload; when that rule is a creating
write, every repeat is a duplicate and the run never builds state. On a large spec,
endpoints behind a chain of steps are reached by chance or not at all. And a
re-sent transition probe whose fresh trigger failed would judge a state the
trigger never brought about.

### Decision

**Pools, not bundles.** Captured values live in pools on the machine. A rule draws
an index per pool it consumes, read from the newest value back, and a step whose
pool is empty is skipped unsent. What Hypothesis may pick never depends on the
target.

**A harmless read leads.** The first rule is the first endpoint with a safe method
that consumes nothing, so Hypothesis's simplest case repeats a read.

**Witnesses among the draws.** One step in ten sends an inferred-rule witness of
its endpoint in place of a valid draw, until a confirmed defect of that endpoint
sent the witness's value.

**Two dry passes stop the run.** With every pass completing, one dry pass is not a
fixed point yet: the next draws differently. The run stops after
`STATEFUL_NO_PROGRESS_PASSES` (2) consecutive passes without progress. A run whose
last pass ended flaky with no violation, once such passes no longer count, ends
`truncated` with `flaky_generation`.

**One more pass at what was never reached.** When the passes stop with targeted
endpoints unreached and at least one reached, one further pass runs on the
unreached endpoints and their transitive producers, unless the run must stop.

**A probe is judged after a trigger that brought it into force.** A re-sent probe
reproduces only when its fresh trigger passes the same gate the discovery did,
and the probe follows a resource the trigger's accepted write moved.

### Rejected

- **Keeping bundles and tolerating the aborts.** Most real runs would stay cut,
  and the cut says nothing about the API.
- **Leading with the riskiest rule.** It is often a creating write, the one that
  must not lead.
- **More passes over every endpoint instead of a focused one.** The endpoints
  already reached would spend the requests again.

### Consequences

A stateful run goes deeper on a real API and ends after two passes that found
nothing. A sequence with a skipped step is shorter than its step count. A run that
keeps going flaky reads `truncated`, never `completed`.

---

## ADR-205 — A stateful consumer with an empty pool sends its producer chain first, and a read may take what its identity built in an earlier pass, history included { #adr-205 }

**Status:** accepted · Supersedes in part [ADR-191](#adr-191) · `runtime/state_link/chain.py`, `runtime/fuzzers/stateful/chains.py`, `runtime/fuzzers/stateful/provision.py`, `runtime/fuzzers/stateful/link_payloads.py`, `runtime/fuzzers/stateful/run_corpus.py`, `runtime/fuzzers/stateful/corpus_reads.py`, `runtime/fuzzers/stateful/slices.py`, `runtime/fuzzers/stateful/step_witnesses.py`, `runtime/fuzzers/stateful/unsent.py`, `runtime/fuzzers/stateful/constants.py`, `models/runtime/stats.py`

### Context

With pools in place of bundles ([ADR-191](#adr-191)), a step whose pool was empty
was skipped. On a large specification most consumers sit behind a chain: a
comment needs an article, which needs a user. Hypothesis reaches such a consumer
only when it happens to draw the chain in order first, so most draws of a deep
endpoint sent nothing, and a run of many passes still left it unsent. Each
sequence also started from nothing: a read whose producer failed in this
sequence found nothing to read, though an earlier pass of the same caller had
built that resource.

### Decision

**A consumer drawn with an empty pool sends its producer chain first, inside its
step.** The run plans, once, each consumer's chain through the producers among
its endpoints, dependencies first, keeping only producers no caller's
credentials or transport would overwrite a bound value of. Each link is sent as a
step of its own, consuming the newest value of each pool it reads, and the
consumer goes out once every pool it reads holds a value. A link whose producer
returned no value is not sent again in that sequence
(`INLINE_CHAIN_ATTEMPTS_PER_SEQUENCE`, 1). A chain that cannot be planned leaves
the consumer unsent with `link_producer_missing`, `link_chain_cyclic` or
`link_target_reserved`; a producer cut off first, with `link_producer_cut_off`;
producers that answered without a usable value, with `link_value_never_produced`.

**A chain link sends its producer's simplest request as often as a drawn one.**
The simplest valid request carries the specification's examples, the values a
producer most surely accepts, and a finding's chain shrinks toward it. Its
strings are rotated by a drawn step, so two links do not collide on a unique
value.

**A read takes what its identity built earlier, with the steps that built it.**
When a sequence ends, each value it produced that is still in its pool is
published to the run's corpus with its resource's history: the steps of that
sequence that built and changed the resource. The corpus is frozen for each pass
and keeps the newest `RUN_CORPUS_VALUES_PER_BUNDLE` (32) values per identity and
bundle. A read (a safe method that invalidates nothing) whose chain gave nothing
takes a corpus value of its own identity, and that value's history is inserted
into its sequence, so the sequence still reproduces on a fresh server. When only
another identity holds such a value, the read sends nothing,
`link_value_other_identity`: a sequence never borrows another caller's
resources.

**A step now and then sends a declared value.** One draw in ten
(`VALID_STEPS_PER_AIMED_STEP`, 9 to 1) sends an inferred-rule witness or one of
the field's declared `enum` or `boolean` values, so a value that changes the
handler's branch is sent at least sometimes.

### Rejected

- **Letting Hypothesis find the chain.** Its odds fall with every link; on a real
  API deep endpoints went unsent run after run.
- **A run-wide pool shared across sequences.** A value whose history is not in
  the sequence cannot be rebuilt when the sequence is re-sent, so its finding
  would never reproduce on a clean server.
- **Borrowing another identity's values.** A read under one caller of another
  caller's resource is an access question, judged by `auth`, not a state flow.

### Consequences

Deep endpoints are reached in most runs, and a stateful sequence is longer: it
carries its chains and, for a read from the corpus, the history inserted ahead.
`consumer_values` counts, per endpoint, how often its values came from the pool,
from a chain, or did not come and why; `stateful_chains` counts the chains a run
sent.

---

## ADR-206 — A stateful run stops after four passes without progress, never before it has sent its exploration floor, and keeps aiming at what it never reached while that finds something { #adr-206 }

**Status:** accepted · Supersedes in part [ADR-162](#adr-162), [ADR-191](#adr-191) · Extends [ADR-188](#adr-188) · `runtime/fuzzers/stateful/supervisor.py`, `runtime/fuzzers/stateful/exploration_floor.py`, `runtime/fuzzers/stateful/reach_pass.py`, `runtime/fuzzers/stateful/pass_reaction.py`, `runtime/fuzzers/stateful/controlled.py`, `runtime/fuzzers/stateful/suppression.py`, `runtime/fuzzers/stateful/constants.py`

### Context

Two dry passes stopped a run ([ADR-191](#adr-191)). Measured over instrumented
runs against a lab API, most passes ended on a symptom the run had already seen,
almost all of them one a control had left unverified, and none of those ever
turned confirmed. Each such pass counted as progress, spent most of the run's
shrink requests minimizing it again, and ended before it had explored anything
else. That false progress was also what carried a run across long stretches with
nothing new before a real defect: with it gone, two dry passes would cut those
runs short. Once those passes stopped shrinking, the requests they had spent
were no longer spent at all, and a run sent far fewer requests than the caller's
`examples_per_endpoint` suggests. And the single extra pass at the unreached
endpoints stopped there even when it found something.

### Decision

**What counts as progress is named.** A pass makes progress when the run gains a
confirmed defect, a flaky signature, a refuted or unverified finding, a widened
suppression, one of its first `STATEFUL_UNEXPLAINED_FLAKY_PASSES` (2) flaky
passes without a recovered violation, or loses a live endpoint to its breaker.

**A judged signature is covered whole.** Once a control has refuted a stateful
finding or left it unverified, every later step showing that signature is
suppressed, unless the run also confirmed it: a second cause of a confirmed
symptom is still reported. A pass no longer ends on a signature already judged.

**Four dry passes stop the run.** `STATEFUL_NO_PROGRESS_PASSES` is 4. With judged
signatures covered, a dry pass is a whole pass, and four of them span longer than
the longest stretch measured before a confirmed defect.

**Not before the exploration floor.** Dry passes do not stop a run that has sent
fewer than `examples_per_endpoint × STATEFUL_EXPLORATION_REQUESTS_PER_EXAMPLE
(9) × live endpoints` exploration requests on the wire, as long as its last pass
sent at least one. Shrink and control requests do not count toward it.
`STATEFUL_MAX_PASSES` (100) and `max_distinct_bugs` still bound the run.

**The reach passes repeat while they find something.** When the passes stop with
live targeted endpoints never sent and at least one sent, a pass runs on the
unsent ones and their transitive producers; another follows while each one
makes progress.

### Rejected

- **Covering a symptom by endpoint, invariant and status after any first
  finding.** It hides a confirmed defect that shares the symptom.
- **Longer sequences or more sequences per pass.** Either overrides an option the
  caller set, makes every witness longer to minimize, and multiplies the dry tail
  a run ends on.
- **Many more dry passes instead of a floor.** A stopping rule is not a budget:
  what it costs depends on when the dry streak falls, and it adds thousands of
  requests to a two-endpoint API that never had any to recover.
- **A floor in time.** `deadline_ms` may be unset, and a slow target would get
  fewer requests for the same promise.

### Consequences

A stateful run sends about `9 × examples_per_endpoint` exploration requests per
live endpoint before it may stop, then stops after four dry passes; its passes
keep the size the caller asked for. Shrink requests fall, since a judged symptom
is minimized once. The catalog's summary of the `stateful` mode says what the run
sends.

---

## ADR-207 — A re-sent stateful sequence is bound to the values its own producers return, and a stateful finding replays alone through its minimal sequence { #adr-207 }

**Status:** accepted · Supersedes in part [ADR-089](engine.md#adr-089), [ADR-188](#adr-188) · `runtime/fuzzers/stateful/recipe.py`, `runtime/fuzzers/stateful/resend.py`, `runtime/fuzzers/stateful/bindings.py`, `runtime/fuzzers/stateful/slices.py`, `runtime/fuzzers/stateful/minimizer.py`, `runtime/fuzzers/stateful/probes.py`, `runtime/fuzzers/stateful/violation.py`, `runtime/fuzzers/stateful/reporting.py`, `runtime/state_link/rebinding.py`, `runtime/replay/sequence.py`, `runtime/runners/replay.py`, `models/runtime/step_link.py`, `models/runtime/replay.py`; core `services/persistence/reproducer.py`, `services/replay/steps.py`, `services/replay/finding.py`, `services/replay/preparation.py`

### Context

The minimizer verified each candidate sequence by re-sending the recorded
requests verbatim ([ADR-089](engine.md#adr-089)). A create re-sent on a live
server returns a new id, and the steps after it still carried the old one: the
re-sent sequence acted on resources the run had created earlier, not on the ones
it had just rebuilt. A finding then reproduced only because the run's own
leftovers were still on the server, and a reader re-running its sequence on a
fresh server saw nothing. A re-sent create could also be refused because its
unique strings were now taken. A re-sent transition probe compared the follow-up
with the value the original trigger sent, though the fresh trigger may have sent
another. And `replay_finding` refused every stateful finding: its request means
nothing without the state its sequence builds.

### Decision

**Each step records how it is rebuilt.** Its recipe names its endpoint and
identity, and for each value it consumes, the earlier step whose answer produced
it (`LinkConsumption`); a transition probe names the step it followed
(`LinkProbe`); a producer carries the schemas its strings may be rotated within.

**A re-send rebinds.** Every re-send of a sequence, to minimize it, verify it or
send its controls, rebuilds each step with the values the re-sent producers
returned this time. A re-sent producer the target rejects without returning a
value goes once more with its strings rotated (`REBIND_PRODUCER_RETRIES`, 1).

**The minimal sequence keeps what changed the resource.** Beside the steps the
last one needs through the values they moved, it keeps every earlier step that
consumed one of those values, such as a first delete or a payment, so a finding
that depends on the resource's state reproduces.

**A re-sent step is judged against the sequence it was re-sent in.** A
transition's expected echo is what the fresh trigger sent.

**A confirmed stateful finding replays alone.** Its minimal sequence's steps are
stored with it (where the run's trace holds each one, and how it binds) when
every step reached the wire. `replay_finding`, and so `verify_finding_fix`,
sends them in order, each rebound to what the steps before it returned this
time, the finding's own request last. A step that needs a value no step before it
returned stops the replay before the finding's request, `inconclusive` with
`state_not_rebuilt`. The answer lists every step (`steps`: `sequence`, `method`,
`path`, `recorded_status`, `observed_status`, `rebound`, `diverged`) and names
the step that stopped it (`failed_step`). A finding stored without its steps,
and an unconfirmed stateful finding, are still refused `stateful`.

### Rejected

- **Verbatim re-sends with a reset of the target between them.** The engine
  cannot reset a target it does not own, and a reset would also erase what the
  sequence needs.
- **Replaying the whole recorded run for a stateful finding.** It re-sends
  hundreds of requests to rebuild a state a handful of steps build.
- **Re-sending with the recorded unique strings.** A server that refuses a
  duplicate makes every re-send of a create fail for a reason the run caused.

### Consequences

A stateful finding's sequence reproduces on a server that never saw the run, and
a reader can replay it alone. A re-sent sequence costs at most one more request
per rejected producer. A finding's `transition_sequence` may hold steps that do
not feed the last one but changed its resource.

---

## ADR-208 — A declared echo is checked on every later read of the resource, and broken only by what another resource of the same sequence was sent { #adr-208 }

**Status:** accepted · `runtime/fuzzers/stateful/later_echo.py`, `runtime/fuzzers/stateful/echo.py`, `runtime/fuzzers/stateful/rule.py`, `runtime/fuzzers/stateful/transitions.py`, `models/runtime/observation.py`; core `services/finding_summary/`

### Context

A transition that declares echoed fields is checked by the probe sent right after
its trigger: create a payee with an alias, read it back, compare. A server that
keeps the alias in one record shared by every payee passes that probe every
time, since nothing else has written in between, and returns the latest alias to
every later read. The run then reads the first payee hundreds of times as an
ordinary step, judged by that endpoint's own oracles, which know nothing of the
transition. A lost update or shared state is the defect the echo exists to catch,
and it shows only after another write.

### Decision

**A later read is judged against the echo its producer declared.** After each
step, the engine checks whether it is a read that follows a declared echo of the
same sequence, and flags it only when four guards hold:

1. **The echo is in force.** The step that produced the value the read consumes
   was sent in this sequence (not inserted from an earlier pass's history), and
   declares a transition on that value with echoed fields that applies after its
   status.
2. **The read is that transition's follow-up.** Its endpoint is the follow-up's,
   it sends the produced value where the transition says, and it was answered
   with one of the transition's expected statuses. Only ordinary steps are read
   this way; the transition's own probe keeps its own check.
3. **Nothing rewrote it since.** No unsafe step between the producer and the read
   consumed the same value; after an update the echo no longer says what the
   resource should hold.
4. **The value returned is another resource's.** The field holds what the latest
   other producer of the same bundle in the sequence sent at that field. A flag,
   a zero or an empty value is not taken as proof, since any sender may produce
   it.

The finding is a `state_transition` on the read, marked `echo_overwritten`:
`expected` is the value this resource was sent, `observed` the other's, and
`location` the field in the response body. Its summary names both values.

### Rejected

- **A probe that creates a second resource after every trigger.** Two more
  writes per trigger against the target, and it catches only the case of a
  create overwriting a create.
- **A run-wide notebook of the last value sent per id.** It is mutable global
  state, and the minimal sequence would not hold what the notebook remembered, so
  the finding would not reproduce on a clean server.
- **Flagging any difference.** A sibling's legitimate side effect (a default
  flag cleared, a counter, a normalized value) would read as a defect; the
  fourth guard keeps only a value that provably came from elsewhere.

### Consequences

The minimal sequence of such a finding holds the two creations and the read, all
ordinary steps, so it is re-sent and replayed alone like any other
([ADR-207](#adr-207)). No request is added: the check reads steps the run
already sent.

---

## ADR-212 — A resource is provisioned with its producer's simplest request first, and a `role_only` endpoint is crossed against a resource a holder of the role created { #adr-212 }

**Status:** accepted · Supersedes in part [ADR-053](engine.md#adr-053), [ADR-102](engine.md#adr-102) · `runtime/runners/provisioning/payloads.py`, `runtime/runners/provisioning/owner_resources.py`, `runtime/runners/auth/planners.py`, `runtime/runners/auth/registries.py`, `runtime/runners/auth/crossing.py`, `runtime/runners/auth/runner.py`

### Context

`auth` and `resilience` create the resource an endpoint acts on before they cross
or attack it, trying up to `PROVISIONING_ATTEMPTS` (5) payloads with the simplest
one last ([ADR-102](engine.md#adr-102)). The simplest valid request carries the
specification's examples, which usually name things the target holds: a
category that exists, a currency it supports. Drawn payloads name things it does
not, so an API that validates references refused every drawn attempt, and the
endpoint was left `owner_resource_unprovisioned` before the simplest one was
tried, or never tried when the attempts ran out.

A `role_only` endpoint provisioned nothing ([ADR-053](engine.md#adr-053)). One
that names a resource in its path (`DELETE /admin/articles/{id}`) was crossed at
the strategy's minimal id, which the target usually lacks: every caller got a
404, the role check that may run after the lookup never ran, and a missing guard
went unseen.

### Decision

**The simplest request leads.** Each round of attempts sends the producer's
simplest valid request first, counted within the attempt cap; drawn payloads
follow when it is refused.

**A `role_only` endpoint acts on a resource a holder of the role created.** The
resources it consumes that some endpoint of the run produces are provisioned
under the first identity holding the required role, then the endpoint is crossed
as before: under every identity without the role, and anonymously. Each creator
keeps its own registry, since a resource belongs to whoever created it, and a
crossing that yields a finding evicts what it used, as for `owner_only`. A
resource nothing produces is crossed at the simplest value its contract gives; a
resource that cannot be created leaves the endpoint unprobed with the
provisioning's reason.

### Rejected

- **More attempts.** Drawn payloads keep naming what the target lacks; the
  example in the specification is the one most likely to be accepted.
- **Creating a `role_only` endpoint's resource under the identity being crossed.**
  A caller without the role may not be allowed to create it, and a resource it
  owns would test ownership, not the role.

### Consequences

Fewer endpoints end `owner_resource_unprovisioned` on APIs that validate
references. A `role_only` endpoint with a path resource costs its provisioning
requests, and can now be left unprobed for a resource it could not create.

---

## ADR-214 — A stateless run confirms what the other endpoints found before it sends what destroys a resource { #adr-214 }

**Status:** accepted · Supersedes in part [ADR-165](#adr-165) · `runtime/runners/rounds.py`, `runtime/runners/loop.py`, `runtime/runners/stateless.py`, `runtime/runners/shrink_resolution.py`, `runtime/runners/shrink_phase.py`, `runtime/progress/unannounced.py`, `runtime/ordering.py`

### Context

A stateless run explores its `DELETE` endpoints last ([ADR-165](#adr-165)), so the
corpus fills before anything removes from it. But it confirmed every finding only
after exploring every endpoint, the deletes included. A finding on `GET
/articles/{slug}` or `PUT /articles/{slug}` is confirmed by re-sending its request
at the resource it was found on; by then a `DELETE` had removed that resource, the
re-send got a 404, and a real defect ended `flaky` or `unverified`.

### Decision

**Two rounds, when the run has both kinds of endpoint.** The endpoints that do not
delete are explored, and their findings confirmed and shrunk, before the `DELETE`
endpoints are explored; the `DELETE` endpoints' findings are confirmed last. A run
with no `DELETE` endpoint, or with nothing else, runs as one round, as before.

**The first confirmation is silent to the client.** It runs under a progress that
never announces `confirming`: the ticks keep saying `generating` while `sent` rises
with the re-sent requests. `confirming` is announced once, for the `DELETE`
endpoints' signatures alone, and `signatures_total` counts only those. The order of
the events a client sees is unchanged: `generating`, `confirming` once, no
`endpoint_started` after it, and every `finding` together at the end.

### Rejected

- **Confirming every finding as soon as its endpoint is explored.** It spreads the
  confirming stage across the whole run, interleaves `finding` events with
  exploration and breaks the published order of the events.
- **Re-creating the resource before a re-send.** The engine does not know which
  producer made a given resource in a stateless run; a fresh one is another
  resource, and the finding was about the first.
- **Announcing two confirming stages.** Every client reads `confirming` as the last
  stretch of a run; a second one would read as the run going backwards.

### Consequences

Findings on the endpoints a delete would have removed are confirmed against the
resource they were found on. The `confirming` stage of a run with deletes is
shorter than its actual confirmation, and `signatures_total` covers only the
`DELETE` endpoints' signatures.
