# Stateful depth { #stateful-depth }

A stateful run drives sequences of linked operations as a state machine. This page
covers how long it keeps going, what each pass draws, the further pass it gives
to what it never reached, how it tells one defect from another, how a transition
probe is judged, and how it checks a delete. The sequence of the mode is on
[Execution modes](execution-modes.md#stateful); the decisions are in the
[runner decision records](adr/runners.md).

## Until passes stop finding anything new { #until-no-progress }

A stateful pass ends at its first violation. The supervisor runs pass after pass,
each looking past the defects already reported, and stops after
`STATEFUL_NO_PROGRESS_PASSES` (2) consecutive passes that change nothing
([ADR-162](adr/runners.md#adr-162), [ADR-191](adr/runners.md#adr-191)). A pass
counts as progress when it:

| Progress | Bounded by |
| --- | --- |
| reports a defect no report holds yet | the ceiling |
| ends flaky on a new signature | the ceiling |
| widens a defect's suppression (below) | once per signature and trigger fields |
| ends flaky with no violation to sign | `STATEFUL_UNEXPLAINED_FLAKY_PASSES` (2) |
| ends `refuted` or `unverified` on a new signature | the ceiling |
| leaves an endpoint out of the next machine, its circuit breaker open | the endpoints |

The run also stops when the distinct confirmed reports, the distinct flaky
signatures or the distinct refuted and unverified ones reach
`StatefulOptions.max_distinct_bugs` (default `STATEFUL_MAX_DISTINCT_BUGS`, 25).
Setting it to `1` reports the first defect only. A cancellation, a dead target, a
machine that can draw no sequence and an engine failure stop it at once.

A run narrowed to endpoints that all consume a value no endpoint of the run
produces, such as one endpoint picked by itself, cannot start from empty pools: it
sends nothing and ends `truncated` with `generation_exhausted`. Include the
endpoints that produce its values.

Passes are also bounded by `STATEFUL_MAX_PASSES` (100), however many count as progress.
A run that reaches it while still progressing ends `truncated` with reason
`pass_limit_reached` ([ADR-188](adr/runners.md#adr-188)).

A run whose last pass ended flaky with no violation to sign, once those passes no
longer count, stopped before a clean pass. It ends `truncated` with reason
`flaky_generation`: no endpoint caused the cut, so its `endpoint_id` is `None`.
Any other cut the run recorded, such as a dead target, wins over it.

## What a pass draws { #stateful-draws }

The machine has one rule per endpoint. What a rule sends does not depend on what
the target answered before, so a replay of a failing sequence draws the same shape:

- **Captured values live in pools.** A production appends the captured value to
  its pool on the machine. A rule draws one index per pool it consumes, read from
  the newest value back, and a step whose pool is empty is skipped unsent. Which
  rules Hypothesis may pick never changes with the target's answers.
- **A harmless read leads.** Hypothesis's simplest case repeats the first rule with
  its minimal payload. The machine's first rule is therefore the first endpoint
  with a safe method that consumes nothing, when there is one; leading with a
  creating write would repeat a duplicate create and never build state.
- **A witness now and then.** An endpoint whose produced contract infers a rule
  the spec leaves out draws, in one step out of ten
  (`VALID_STEPS_PER_WITNESS_STEP`, 9 valid draws to 1), one of its
  [witnesses](witnesses.md#stateful) instead of a valid payload.

## One more pass at what it never reached { #reach-pass }

On a large spec, an endpoint that needs a chain of steps is reached by chance.
When the passes stop with targeted endpoints the run sent nothing to, and it
reached at least one, the supervisor runs **one further pass** on those endpoints
and on every endpoint that produces a value they consume, transitively
(`reach_scope` in `reach_pass.py`).

The pass does not run after a cancellation, a dead target or another halting cut,
an engine failure, a machine that could draw no sequence, the ceiling or the pass
limit. It does not run either when no endpoint of its scope can start from empty
pools. Its findings count as any pass's; a `flaky_generation` cut stands whatever
it does.

## A witness Hypothesis calls flaky

Hypothesis may fail a pass while shrinking, because the target's state changed between
replays, or end it with its flakiness error, with or without the violation inside.
The violation it saw is still in hand. The pass keeps that witness and verifies it
by re-sending its sequence verbatim, as it does with a shrink the budget cut short.
If it reproduces, it is minimized and judged like any other; otherwise the pass is
flaky under its signature.

## Telling defects apart

A defect is its report's `FindingSignature`, body fingerprint included, plus its
**trigger fields** ([ADR-163](adr/runners.md#adr-163)):

- The signature is computed on the **shrunk** step (`step_signature`), so a later
  pass is compared with exactly what was reported.
- The trigger fields are the fields the shrunk step sent off its endpoint's
  simplest draw (`SimplestDraws`, computed once per endpoint, no request sent),
  minus the fields a bundle injected. The report carries them as
  `request.trigger_fields`. A transition probe has none.
- `SuppressedDefects` covers a later violation only when it has a reported
  signature and sent the reported values in each trigger field. Two fields that
  make one endpoint answer the same 500 are two reports.

**Range defects.** A defect that fires on a range of values (any negative
amount) comes back on the next pass with another value. It is folded into its
report (`represented_findings` grows by one), and the suppression is **widened**
once: the signature is covered on any step that sent off the simplest value in
every trigger field and in no other field. A step that also changed another field
escapes the widened entry and is shrunk on its own.

The same widening applies to a signature the run already holds as flaky, refuted
or unverified, the second time a pass ends on it. A defect a creating write cannot
reproduce (its replay hits a duplicate) would otherwise come back with fresh
trigger values on every pass, never count as progress, and end the run before it
built state.

## Transition probes { #transition-probes }

A state link's transition invariant names a follow-up request and what it must
answer after a trigger. The probe is sent only once the trigger **brought it into
force**: the trigger got an answer, broke none of its own invariants, and its
status is one of the transition's `trigger_statuses` (any 2xx when it declares
none).

| Rule | Behaviour |
| --- | --- |
| Reproducing | A re-sent probe reproduces only when the fresh trigger sent before it passes the same gate. A verbatim re-send whose trigger now answers 404 or 500 does not confirm the finding. |
| The trigger | The step right before the probe, which the probe followed. The sequence minimizer always keeps it. |
| A moved resource | On a path transition, when the trigger is a write whose accepted answer holds the path parameter's name at its top level or one object down (a `PUT` that renames a slug), the probe addresses that value instead of the one the trigger consumed. |
| The echo | A value the follow-up must echo counts as echoed when it comes back as sent, when an empty value is left out, or when a string comes back with the whitespace at its ends trimmed. |

## Deleted resources

Two rules of the core's state links give the stateful run what it needs to check a
delete without a model ([ADR-168](../core/adr/core.md#adr-168)):

- **A `DELETE` invalidates the value it consumes.** Once the step draws it, the
  value leaves its bundle, so no later step addresses a deleted resource. A
  nested consumption does not invalidate its parent: deleting a comment keeps the
  article.
- **A deleted-resource transition is derived.** For a `DELETE` whose only
  placeholder is its last path segment, and a `GET` on the same path template that
  declares `404` or `410`, the run probes the `GET` after a successful `DELETE`
  and expects one of those statuses. A soft delete that still answers 200 is a
  `state_transition` finding.

The compiler rejects an endpoint whose transition's follow-up path names a
placeholder its probe cannot fill; the endpoint is listed in `excluded_endpoints`
with that reason.

## When the shrinker itself fails

An error raised inside Hypothesis while it shrinks, when the pass already holds a
witness, ends the pass on that witness: it is re-sent once and reported, or
counted flaky, and the error is logged. An error raised in the engine's own code
still cuts the run `engine_failure` ([ADR-164](adr/runners.md#adr-164)). The engine
requires `hypothesis>=6.170.3,<6.170.10`.

## Where to change it

| To change | Edit |
| --- | --- |
| The stateful ceiling's default | `STATEFUL_MAX_DISTINCT_BUGS` in `constants.py` |
| How many flaky passes without a violation count | `STATEFUL_UNEXPLAINED_FLAKY_PASSES` in `runtime/fuzzers/stateful/constants.py` |
| How many passes without progress stop a stateful run | `STATEFUL_NO_PROGRESS_PASSES` in `runtime/fuzzers/stateful/constants.py` |
| How often a stateful step sends a witness | `VALID_STEPS_PER_WITNESS_STEP` in `runtime/fuzzers/stateful/constants.py` |
| Which rule leads the machine | `_harmless_read_first` in `runtime/fuzzers/stateful/machine_builder.py` |
| What the further pass aims at, and when it runs | `reach_scope`, `run_may_go_on` in `runtime/fuzzers/stateful/reach_pass.py` |
| When a transition probe is in force | `_in_force` and `trigger_gate` in `runtime/fuzzers/stateful/probes.py` |
| When a delete's transition is derived | `INVALIDATING_METHODS`, `DELETED_RESOURCE_STATUSES` in the core's `utils/constants.py` |
