# Stateful depth { #stateful-depth }

A stateful run drives sequences of linked operations as a state machine. This page
covers how long it keeps going, what each pass draws, where a consumer gets its
values, the further passes it gives to what it never reached, how a sequence is
re-sent, how it tells one defect from another, how a transition and a later echo
are judged, and how it checks a delete. The sequence of the mode is on
[Execution modes](execution-modes.md#stateful); the decisions are in the
[runner decision records](adr/runners.md).

## Until passes stop finding anything new { #until-no-progress }

A stateful pass ends at its first violation. The supervisor runs pass after pass,
each looking past the defects already reported, and stops after
`STATEFUL_NO_PROGRESS_PASSES` (4) consecutive passes that change nothing
([ADR-206](adr/runners.md#adr-206)), but never before its **exploration floor**:
`max_examples × STATEFUL_EXPLORATION_REQUESTS_PER_EXAMPLE` (9) `× live endpoints`
exploration requests on the wire, as long as its last pass sent at least one.
Shrink and control requests do not count toward the floor; the dry streak is still
counted below it, so a run that crosses the floor while dry stops in that pass. A
pass counts as progress when it:

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
  the newest value back. Which rules Hypothesis may pick never changes with the
  target's answers. A step whose pool is empty gets its values as the next
  section says.
- **A harmless read leads.** Hypothesis's simplest case repeats the first rule with
  its minimal payload. The machine's first rule is therefore the first endpoint
  with a safe method that consumes nothing, when there is one; leading with a
  creating write would repeat a duplicate create and never build state.
- **A witness or a declared value now and then.** In one step out of ten
  (`VALID_STEPS_PER_AIMED_STEP`, 9 valid draws to 1), an endpoint draws one of its
  [witnesses](witnesses.md#stateful), when its produced contract infers a rule the
  spec leaves out, or one of a field's declared `enum` or `boolean` values, instead
  of a valid payload.

## Where a consumer gets its values { #consumer-values }

A consumer drawn while a pool it reads is empty does not skip
([ADR-205](adr/runners.md#adr-205)):

1. **Its producer chain goes first, inside its step.** The run plans each
   consumer's chain once, through the producers among its endpoints, dependencies
   first, keeping only producers no caller's credentials or transport would
   overwrite a bound value of. Each link is sent as a step of its own, consuming
   the newest value of each pool it reads, and sends its producer's **simplest
   request** as often as a drawn one (`SIMPLEST_LINKS_PER_DRAWN_LINK`, 1 to 1), its
   strings rotated so two links do not collide. A link whose producer returned no
   value is not sent again in that sequence (`INLINE_CHAIN_ATTEMPTS_PER_SEQUENCE`,
   1). `stateful_chains` counts the chains a run sent.
2. **A read takes what its identity built earlier.** When a sequence ends, each
   value it produced that is still in its pool is published to the run's corpus
   with its resource's history: the steps that built and changed it. The corpus is
   frozen per pass and keeps the newest `RUN_CORPUS_VALUES_PER_BUNDLE` (32) values
   per identity and bundle. A read (a safe method that invalidates nothing) whose
   chain gave nothing takes one of its own identity's values, and the history is
   inserted into its sequence, so the sequence reproduces on a fresh server.
3. **Otherwise it sends nothing, and says why**, by the reason most of its draws
   met: `link_producer_missing` or `link_chain_cyclic` (no chain can be planned),
   `link_target_reserved`, `link_producer_cut_off`, `link_value_never_produced`
   (its producers answered without a usable value), or `link_value_other_identity`
   (only another identity holds such a value; a sequence never borrows one).

Each endpoint's `consumer_values` counts its draws by where the values came from:
`pool`, `chain`, or `unsent` by reason.

## More passes at what it never reached { #reach-pass }

On a large spec, an endpoint that needs a chain of steps may still go unsent.
When the passes stop with targeted endpoints the run sent nothing to, and it
reached at least one, the supervisor runs **a further pass** on those endpoints
and on every endpoint that produces a value they consume, transitively
(`reach_scope` in `reach_pass.py`). While each such pass makes progress and
something is still unreached, the scope is recomputed and another one runs; the
first dry one ends them.

A further pass does not run after a cancellation, a dead target or another halting cut,
an engine failure, a machine that could draw no sequence, the ceiling or the pass
limit. It does not run either when no endpoint of its scope can start from empty
pools. Its findings count as any pass's; a `flaky_generation` cut stands whatever
it does.

## A witness Hypothesis calls flaky

Hypothesis may fail a pass while shrinking, because the target's state changed between
replays, or end it with its flakiness error, with or without the violation inside.
The violation it saw is still in hand. The pass keeps that witness and verifies it
by re-sending its sequence, as it does with a shrink the budget cut short.
If it reproduces, it is minimized and judged like any other; otherwise the pass is
flaky under its signature.

## Re-sending a sequence { #resend }

Every re-send of a sequence, to minimize it, verify it or send its controls,
rebuilds each step from its recorded recipe ([ADR-207](adr/runners.md#adr-207)):

- **Values are rebound.** A step takes the values the re-sent producers returned
  this time, not the recorded ones: the id a create hands out now.
- **A rejected producer goes once more.** A re-sent producer the target rejects
  without returning a value is sent again with its strings rotated
  (`REBIND_PRODUCER_RETRIES`, 1).
- **The minimal sequence keeps what changed the resource.** Beside the steps the
  last one needs through the values they moved, it keeps every earlier step that
  consumed one of those values (an update, a payment, a first delete).
- **A re-sent step is judged against its own sequence.** A transition's expected
  echo is what the fresh trigger sent.

A confirmed finding keeps the steps of its minimal sequence, so the core can
replay it alone ([stateful findings](../core/protocol/finding-replay.md#stateful)).

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

The same widening applies to a signature the run already holds as flaky, the
second time a pass ends on it. **A judged signature is covered whole.** Once a
control has refuted a finding or left it unverified, every later step showing its
signature is suppressed for the rest of the run, unless the run also confirmed
that signature: a second cause of a confirmed symptom is still reported apart. An
unverified finding no control judged (its re-send was blocked) keeps the trigger
rule above.

## Transition probes { #transition-probes }

A state link's transition invariant names a follow-up request and what it must
answer after a trigger. The probe is sent only once the trigger **brought it into
force**: the trigger got an answer, broke none of its own invariants, and its
status is one of the transition's `trigger_statuses` (any 2xx when it declares
none).

| Rule | Behaviour |
| --- | --- |
| Reproducing | A re-sent probe reproduces only when the fresh trigger sent before it passes the same gate. A re-send whose trigger now answers 404 or 500 does not confirm the finding. |
| The trigger | The step right before the probe, which the probe followed. The sequence minimizer always keeps it. |
| A moved resource | On a path transition, when the trigger is a write whose accepted answer holds the path parameter's name at its top level or one object down (a `PUT` that renames a slug), the probe addresses that value instead of the one the trigger consumed. |
| The echo | A value the follow-up must echo counts as echoed when it comes back as sent, when an empty value is left out, or when a string comes back with the whitespace at its ends trimmed. |

**A later read is checked too.** The probe right after its trigger cannot see a
server that keeps one value for every resource, since nothing else has written
yet. An ordinary step that reads the resource later is a `state_transition`
finding marked `echo_overwritten` when four guards hold: the echo's producer was
sent in this sequence and its transition is in force; the read is that
transition's follow-up, sent with the produced value and answered with an expected
status; no unsafe step consumed the value in between; and the echoed field holds
what the latest other producer of the same bundle in the sequence sent there (a
flag, a zero or an empty value is never taken as proof). `expected` is the value
this resource was sent, `observed` the other's
([ADR-208](adr/runners.md#adr-208)).

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
| The exploration floor | `STATEFUL_EXPLORATION_REQUESTS_PER_EXAMPLE` in `runtime/fuzzers/stateful/constants.py`, `ExplorationFloor` in `exploration_floor.py` |
| How often a stateful step sends a witness or a declared value | `VALID_STEPS_PER_AIMED_STEP` in `runtime/fuzzers/stateful/constants.py` |
| How a consumer's producer chain is planned and sent | `plan_consumer_chains` in `chains.py`, `provision.py`, `link_payloads.py`; `SIMPLEST_LINKS_PER_DRAWN_LINK`, `INLINE_CHAIN_ATTEMPTS_PER_SEQUENCE` |
| What the run's corpus keeps and lends a read | `run_corpus.py`, `corpus_reads.py`; `RUN_CORPUS_VALUES_PER_BUNDLE` |
| How a re-sent step is rebuilt | `recipe.py`, `resend.py`, `slices.py`; `REBIND_PRODUCER_RETRIES` |
| The later echo's guards | `later_echo.py` |
| Which rule leads the machine | `_harmless_read_first` in `runtime/fuzzers/stateful/machine_builder.py` |
| What the further pass aims at, and when it runs | `reach_scope`, `run_may_go_on` in `runtime/fuzzers/stateful/reach_pass.py` |
| When a transition probe is in force | `_in_force` and `trigger_gate` in `runtime/fuzzers/stateful/probes.py` |
| When a delete's transition is derived | `INVALIDATING_METHODS`, `DELETED_RESOURCE_STATUSES` in the core's `utils/constants.py` |
