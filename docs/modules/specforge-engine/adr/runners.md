# Spec Forge Engine — Decision records — Runners

Part of the [Spec Forge Engine decision records](index.md). Decisions about how far
each runner gets into an API: when a stateful run stops, how it tells one defect
from another, where stateless takes the values it addresses resources with, how a
whole-request rejection is told from a state conflict, and how resilience aims at
a real resource, tells a crash from an intermittent error, and what a runner does
with a link into a reserved header. The behaviour is
described in [Run depth](../run-depth.md).

---

## ADR-162 — A stateful run continues until a pass finds nothing new, under a ceiling of 25 distinct defects { #adr-162 }

**Status:** accepted · `constants.py`, `models/runtime/options.py`, `runtime/fuzzers/stateful/supervisor.py`, `runtime/fuzzers/stateful/constants.py`

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

**Status:** accepted · `runtime/fuzzers/stateless/corpus.py`, `runtime/fuzzers/stateless/corpus_overlay.py`, `runtime/fuzzers/stateless/constants.py`, `runtime/fuzzers/stateless/folding.py`, `runtime/fuzzers/stateless/shrinking.py`, `runtime/fuzzers/stateless/example_counts.py`, `models/runtime/draw.py`, `runtime/ordering.py`, `runtime/runners/stateless.py`, `constants.py`

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
