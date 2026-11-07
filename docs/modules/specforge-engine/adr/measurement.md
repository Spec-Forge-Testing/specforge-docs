# Spec Forge Engine — Decision records — Measurement

Part of the [Spec Forge Engine decision records](index.md). Decisions about how
the engine's default numbers are set, what was measured to set them, and what the
model-inferred contract adds to a run.

---

## ADR-140 — The engine's default numbers are set by measurement, under a decision rule written before measuring { #adr-140 }

**Status:** accepted · `models/phase.py`, `profiles/builtin.py`, `models/contracts/endpoint_controls.py`, `budget/aggressiveness.py`

### Context

The default example budget (`max_examples`), the phase split of each profile and
the attack share per aggressiveness point decide how many requests a run sends and
which phase sends them. They were chosen by hand. A measurement of the realized
split showed that the declared split is not the one a run performs: a short
`boundary` space runs out long before its quota and the rest of its share is never
spent ([ADR-142](engine.md#adr-142)). A number chosen by looking at one run's
results is also open to picking the point that "looks good".

### Decision

**The defaults are data with names, set from a measurement anyone can repeat.**
The measurement wraps the core from outside the product. It records, per request,
the phase, zone, field, attack family, status and latency, shrink requests
included. It changes a run in one place only: the endpoint budget's `max_examples`
and `phase_split`, or the profile's split when an inferred contract would derive
the attack share. With no override set it changes nothing, so the control run is
the product itself. It adds no knob to the engine.

**The grid.** `max_examples` ∈ {50, 100, 200, 400, 800}, crossed with the
`default` split and four candidate `security` splits, on two targets: a lab API with
a known list of planted bugs, each with a ground-truth check on the recorded
traffic, and the [RealWorld](../../../testing/real-world.md) Go implementation.
The point under test (200) runs three times; one run at ×25 (5 000) checks for a
plateau. Runs are serial, each with its own data directory, and the target is
reset between splits.

**What is counted is a bug signature:** a confirmed finding's `endpoint ×
invariant × rule_id`. Phase, identity and status code are left out, so the same
defect found by two phases counts once. A phase's **own** signatures are those
that appear only in runs that include that phase, in every repetition.

**The decision rule is written down before the first run, then applied as is:**

1. `max_examples` is the smallest N whose signatures reach 95 % of those at 800 on
   both targets, with every planted bug found in 3 of 3 repetitions.
2. The `security` attack share is the smallest candidate that finds the
   mass-assignment bug in 3 of 3 repetitions without losing another phase's own
   signatures beyond the measured variance (±3 signatures on the Go target).
3. A phase with no own signatures on either target drops to 0.05. It stays present
   and measurable. Its share goes to `attack` in `security` and to `invalid` in
   `default`.
4. The attack share per aggressiveness point changes only if the grid is repeated
   with inferred contracts.
5. If going from 200 to 800 adds fewer than 5 % new signatures, `deadline_ms`
   stays a ceiling.

### Rejected

- **Setting the numbers by inspecting the results.** Without a rule fixed in
  advance, the chosen point is the one that confirms what was expected.
- **Exposing the numbers as user knobs.** They are the engine's stability, not a
  user's policy. An endpoint that needs another budget declares it in its
  contract, as it already can.

### Consequences

The numbers and the rule that produced them are in [ADR-141](#adr-141). A change
to a default is a new measurement under the same method, recorded as a new
decision.

---

## ADR-141 — The default budget stays at 200, `security` spends a quarter on attacks, and `deadline_ms` is a ceiling { #adr-141 }

**Status:** accepted · Supersedes in part [ADR-051](compiler.md#adr-051), [ADR-129](compiler.md#adr-129) · `profiles/builtin.py`, `models/phase.py`, `models/contracts/endpoint_controls.py`, `budget/aggressiveness.py`

### Context

[ADR-140](#adr-140) defines the measurement and the rule. The candidate splits,
as `valid · boundary · invalid · attack · mutation`:

| Split | Shares |
| --- | --- |
| S0 (`default`) | 0.60 · 0.25 · 0.15 |
| H0 | 0.50 · 0.25 · 0.10 · 0.05 · 0.10 |
| H1 | 0.40 · 0.20 · 0.10 · 0.20 · 0.10 |
| H2 | 0.35 · 0.15 · 0.10 · 0.30 · 0.10 |
| H3 | 0.45 · 0.25 · 0.10 · 0.20 · 0 |

Confirmed signatures by `max_examples` (three repetitions at 200):

| Target · split | 50 | 100 | 200 | 400 | 800 | 5 000 |
| --- | --- | --- | --- | --- | --- | --- |
| lab · S0 | 20 | 21 | 21 / 20 / 20 | 21 | 21 | 21 |
| lab · H0 | 19 | 21 | 24 / 23 / 22 | 22 | 24 | 24 |
| lab · H1 | 20 | 22 | 23 / 24 / 23 | 24 | 24 | — |
| lab · H2 | 20 | 24 | 23 / 24 / 24 | 23 | 24 | — |
| lab · H3 | 18 | 20 | 24 / 24 / 24 | 24 | 24 | — |
| Go · S0 | 18 | 19 | 19 / 22 / 20 | 21 | 22 | — |
| Go · H0 | 15 | 22 | 22 / 22 / 22 | 21 | 22 | — |
| Go · H1 | 18 | 20 | 22 / 22 / 22 | 23 | 23 | — |
| Go · H2 | 17 | 21 | 21 / 22 / 22 | 22 | 22 | — |
| Go · H3 | 16 | 22 | 22 / 22 / 21 | 22 | 22 | — |

The `default` split finds ten of the planted bugs from 50 examples on.
A `security` split reaches twelve from 200 on, two of them through `attack`: a
quote in a search term that leaks a SQL error, and an undeclared `role` key the
server assigns. H0 finds the mass-assignment bug in 2 of 3 repetitions; H1, H2 and
H3 find all twelve in 3 of 3.

Own signatures at 200 (common to the three repetitions): `invalid` 8 to 10 in
every cell; `boundary` 1 to 3 on the lab and none on the Go target; `attack` 1
with H0 and 3 with H1, H2 and H3 on the lab; **`mutation` none on either
target**. The ×25 run gives 21 (S0) and 24 (H0), the same as 800, for 53 493 and
52 477 requests and 287 s and 283 s, against 82 to 128 s at 200: a plateau.

### Decision

The rule applied clause by clause:

1. **`max_examples` stays 200.** 100 fails the rule (Go S0 19 of 22, lab H0 21 of
   24). At 200 the lab meets 95 % of 800 with S0 and with the new `security` split.
   The Go S0 misses at 200 are `content_type_conformance` findings on paths to
   resources that do not exist, and they rotate between repetitions: one of the
   three equals 800 exactly. That spread is the path value's draw, not the budget,
   and it lies inside the ±3 variance.
2. **`attack` takes 0.20 in `security`.** H1 and H3 (0.20) find the mass-assignment
   bug in 3 of 3 and lose no other phase's own signatures beyond the variance. H2
   (0.30) adds nothing over H1.
3. **`mutation` drops to 0.05**, since it has no own signatures. Its other 0.05
   goes to `attack`. `boundary` has own signatures on the lab and keeps its share.
4. The attack share per aggressiveness point stays at 0.05.
5. **`deadline_ms` stays a ceiling.** From 200 to 800 the new signatures are 0 %
   (lab S0), 4 % (lab H0, mean) and 0 % (Go H0). Go S0 shows 8 % from the same
   rotation as clause 1. The ×25 run confirms the plateau.

The resulting constants:

| Constant | Value |
| --- | --- |
| `DEFAULT_PHASE_SPLIT` | `valid` 0.60 · `boundary` 0.25 · `invalid` 0.15 (no phase drops under clause 3) |
| `SECURITY_PHASE_SPLIT` | `valid` 0.40 · `boundary` 0.20 · `invalid` 0.10 · `attack` 0.25 · `mutation` 0.05 |
| `EndpointBudgetContract.max_examples` default | 200 |
| `deadline_ms` | a ceiling on an endpoint's pass, never a time budget to fill |

**The 0.25 rules where no aggressiveness is declared.** An endpoint whose
contract declares `attack.aggressiveness` gets its attack share from
`derive_attack_split`: 0.05 per point, capped at 0.5 by `MAX_AGGRESSIVENESS`, the
other phases rescaled in the profile's proportions
([ADR-129](compiler.md#adr-129)). The profile's 0.25 applies to a `security` run
without an inferred contract, or with one that declares no aggressiveness.

### Rejected

- **A larger default budget.** 400 and 800 add almost nothing at two to four
  times the requests, and ×25 adds nothing.
- **H2's 0.30 attack share.** It costs `valid` and `boundary` examples and finds
  no more than 0.20 did.
- **Removing `mutation`.** It has no own signatures on two targets, which is a
  reason to shrink it, not proof that no API needs it. At 0.05 it stays
  measurable.
- **A time budget as a floor.** The signature curve is flat past 200, so filling
  a deadline would spend requests without finding more.

### Consequences

Measured again with these constants, with [carry-over](engine.md#adr-142) and
[`contract_completeness`](engine.md#adr-143) active, three repetitions at 200:

| Target · split | Confirmed signatures | Planted bugs |
| --- | --- | --- |
| lab · `default` | 22 / 21 / 22 | 10 of 10 in 3 of 3 |
| lab · `security` | 25 / 25 / 25 | 12 of 12 in 3 of 3 |
| Go · `default` | 32 / 32 / 32 | — |
| Go · `security` | 34 / 32 / 33 | — |

Every phase keeps its own signatures: `invalid` 8 to 10 in every cell, `boundary`
3 on the lab, `attack` 3 on the lab under `security`. Most of the Go target's growth
is `contract_completeness`. The signatures that appear only above 200 come from
three of the lab's 20 endpoints and two of the Go target's 19, mostly those with
free text fields, with a weak rank correlation to the endpoint's input surface
(+0.02 to +0.34). That does not show the best budget depends on the endpoint; it does say a
per-endpoint budget would look at unconstrained text fields rather than at the
field count.

---

## ADR-147 — What the model-inferred contract adds is measured on bugs only the code shows, against a control and a hand-written ceiling { #adr-147 }

**Status:** accepted · `semantic_inference`, `contract_assembly/fusion`; engine `runtime/oracles/`

### Context

An inferred contract costs money per endpoint. Its value is the bugs a run finds
because the model read the handler, and that the specification does not let the
fuzzer reach. A bug that a run without the model already finds measures nothing.

### Decision

**The contribution is measured on bugs designed so that the specification alone
cannot reach them.** Nine bugs are planted in the lab, none declared in its
OpenAPI document, each with a ground-truth check on the recorded traffic. Seven
sit in handlers the static analysis traces; two sit in handlers it does not, as
controls. A bug counts only if the run without the model does not trigger it.

**Four runs**, all `security`:

- **control**: the lab's hand-written fixture contracts, no model;
- **model**: contracts inferred for the six traced handlers;
- **model, no hints**: the same, against a copy of the lab's code with every
  comment, docstring and bug marker removed;
- **ceiling**: contracts written by hand from the exact payload the model receives
  (`get_llm_payload`). It is labelled a ceiling, never a product result: it shows
  how far the same context can go.

| Planted bug | Traced | Control | Model | No hints | Ceiling |
| --- | --- | --- | --- | --- | --- |
| an undeclared `?debug=1` dumps the store, tokens included (`GET /search`) | yes | no | **yes** | **yes** | yes |
| an undeclared `format=xml` reaches a half-handled branch and answers 500 (`POST /parse`) | yes | no | **yes** | **yes** | yes |
| an undeclared `X-Max-Tokens` header answers 500 (`POST /parse`) | yes | no | **yes**¹ | **yes**¹ | yes |
| an undeclared `?fail=1` forces a 500 (`GET /flaky`) | yes | no | **yes** | **yes** | unverified² |
| an undeclared `?factor` multiplies a sleep (`GET /slow`) | yes | no | no³ | no³ | yes |
| a `__proto__` body key answers 500 (`POST /upload`) | yes | no | no | no | yes |
| a route outside the specification (`/internal/dump`, named by `GET /health`) | yes | no | no⁴ | no⁴ | no⁴ |
| a transfer above the balance succeeds (`POST /transfers`) | no | no | no | no | — |
| a predictable report id returns another user's report (`GET /reports/{id}`) | no | no | no | no | — |

¹ The same signature as `format=xml`: two different 500s of one endpoint, under
one rule, are one signature.
² Seen, but the lab's random 500 on the same endpoint mixes into the check and the
finding stays unverified.
³ The model left `factor` unbounded. Large values push the sleep past ten
seconds, and the endpoint ends `infrastructure_abort`: the run is `truncated`,
honestly, rather than reporting a bug.
⁴ `fuzz` only probes declared endpoints. `generate_contract` without the model
finds no route declarations, because the lab dispatches through a dictionary
rather than a framework's route table. The invariant vocabulary has no way to say
"the response must not mention an undeclared route".

| Run | Confirmed signatures | Billed |
| --- | --- | --- |
| control | 24 | USD 0 |
| model | 28 | USD 0.09 (estimated USD 0.22 without prompt caching) |
| model, no hints | the same four bugs, under the same signatures | USD 0.08 |
| ceiling | 35, run `completed` | USD 0 |

**The model finds 4 of the 7 traced bugs the specification hides, for USD 0.09,
and none of the untraced controls.** The run without hints finds the same four,
so the result does not come from the lab's comments. Fusion carries what the
model proposes beyond the specification: `debug`, `fail`, `factor` and
`X-Max-Tokens` all reached the wire.

On the Go target the inferred contracts cost USD 0.28 (estimated USD 0.79 without
prompt caching) and cut `contract_completeness` from 10 signatures to 3
([ADR-143](engine.md#adr-143)): the model declares what the server's validator
enforces.

### Rejected

- **Measuring on the bugs the fuzzer already finds.** They show the model's cost,
  not its contribution.
- **Reporting the ceiling as the model's result.** A hand-written contract is the
  limit of the context, not what a run gets.

### Consequences

The gap to the ceiling is the model and its prompt, not its context: the ceiling
read the same payload. The model does not propose a body's magic key, and does not
bound a numeric parameter by its effect on the handler. Two limits of the engine
show up as well. A valid value of an undeclared parameter that inflates latency
ends in `infrastructure_abort`, not `input_induced_timeout`, since that oracle
judges only a poisoned field. Two distinct 500s of one endpoint collapse into one
signature. A replaced fixture also drops what only the fixture declared: the
inferred run loses a business rule on an untraced handler, and the
`contract_completeness` finding on `GET /search`.

---

## ADR-172 — Targeted generation was measured and is not adopted { #adr-172 }

**Status:** accepted · measurement only; no code ships

### Context

Hypothesis's `target()` steers generation toward inputs that raise a score. The
question was whether steering the `valid` phase toward error responses finds
defects that the run corpus ([ADR-165](runners.md#adr-165)), which already feeds
the phase real identifiers, does not.

### Decision

**The rule, written before measuring:** targeted generation ships only if its arm
finds confirmed signatures no control run finds, in at least 2 of 3 repetitions on
some target.

**What was measured.** A prototype outside the product made the `valid` pass
targeted: batches of one request, Hypothesis's `target` phase enabled, and
`target()` called inside the test with a score that is stable for an input: the
rank of the response's status class, plus one when the response carries keys its
contract does not declare. Two arms, three repetitions per target: the engine with
the run corpus, and the same engine with targeted generation.

| Target | Control arm | Targeted arm |
| --- | --- | --- |
| RealWorld Go | union of 34 signatures over 6 runs | union of 30; one signature of its own (`POST /articles/{slug}/comments` 500), in 1 of 3 runs; the 404 share of `valid` rose to 32 % |
| Lab API | union of 23 signatures; planted bugs found 11, 13, 12 | union of 23, none of its own; planted bugs found 12, 12, 12 |

Wall time was the same in both arms (42 to 49 seconds on the Go target).

**It is not adopted.** With about 60 `valid` examples per endpoint, the optimizer
has too few to climb on; the corpus is the feedback that pays.

### Rejected

- **Shipping it for the one extra signature.** It appeared in 1 of 3 runs, below
  the rule fixed beforehand, and the optimizer pushes requests toward 4xx and 5xx
  at the cost of the 2xx answers the corpus gains.

### Consequences

No code ships. The measurement is worth repeating if the examples per endpoint grow
by an order of magnitude.

---

## ADR-200 — The semantic phase gets one example per input rule { #adr-200 }

**Status:** accepted · Refines [ADR-054](engine.md#adr-054), extends [ADR-055](engine.md#adr-055) · `budget/floors.py`, `shared/phase_extensions.py`, `shared/semantic_properties.py`, `phase_extension_builtins.py`, `strategy_compiler/effective_phases.py`, `strategy_compiler/planning.py`

### Context

The semantic phase reserves `SEMANTIC_SHARE` (0.10) of an applicable endpoint's
budget ([ADR-054](engine.md#adr-054)), and the budget is split across phases by
largest remainder. At 5 examples per endpoint the phase's share is half an example,
which rounds to zero: a short run compiles the phase, funds it with nothing, and
never aims a request at the endpoint's business rules.

The share was measured under the method of [ADR-140](#adr-140): 540 runs crossing
the shares 0.05, 0.10, 0.20, 0.30 and 0.40 with budgets of 5, 10, 20, 40 and 200
examples per endpoint, on a lab API with 18 seeded rule bugs, read once with
hand-written contracts and once with model-inferred ones, plus a second lab with
many bugs that are not rules (at 20 and 200 examples). Rule bugs found, out of 18,
as the mean of the repetitions:

| Examples per endpoint | Hand-written, 0.10 | Hand-written, best share | Inferred, 0.10 | Inferred, best share |
| --- | --- | --- | --- | --- |
| 5 | 6.2 | 12.3 at 0.40 | 4.6 | 11.1 at 0.40 |
| 10 | 15.0 | plateau (±1) | 13.9 | plateau; 0.05 loses 3.1 |
| 20 | 17.4 | plateau | 14.7 | plateau |
| 40 / 200 | 17.9 / 18 | ceiling | 15.7 / 16 | ceiling |

From 10 examples on no share beats 0.10 by a margin that matters, and 0.05 is
fragile: the risk weight can lower an endpoint's budget enough to bring the zero
back. Below 10, the loss is the zero, not the share: 0.20 and 0.30 give the phase
one example and 0.40 gives it two. On the second lab the bugs found by the other
phases were the same under all five shares, at 20 and at 200 examples.

### Decision

**The share stays at 0.10, and an endpoint with `k` input constraints gets at least
`k` semantic examples.** `PhaseExtension` gains an optional `floor`, a callable over
the `EndpointSpec`; the built-in semantic extension declares
`input_constraint_count`. The planner allocates with `allocate_with_floors`: the
split by weight first, then every phase short of its floor raised to it, the
examples taken from the other phases in proportion to their weights. When the share
already reaches `k` the allocation is exactly the split by weight. When the budget
is below `k` the other phases keep one example. Floors are funded deficit first, so
one phase's surplus never outranks another phase's floor. A floor naming a phase
outside the split, or a negative floor, raises `ValueError`.

The floor holds wherever the stateless planner allocates: the stateless mode, the
flat `performance` pass and the shrink of their findings. The latency ladder plans
`valid` only and the stateful mode does not plan by phase, so neither has a semantic
budget to raise.

Measured again with the floor, at 5 examples: 9.9 rule bugs of 18 with hand-written
contracts (from 6.2) and 8.5 with inferred ones (from 4.6). The rules the other
phases could not reach went from none found to all found. At 10 and 20 examples the
floor does not act.

### Rejected

- **Raising the share to 0.40.** It finds the most rule bugs at 5 examples, but it
  takes 40% of every applicable endpoint's budget from the other phases, at every
  budget, and nothing measured that the other bug classes survive that at 5
  examples. The floor fixes the measured cause, the zero, without that bet.
- **A share that grows with the number of rules.** It still rounds: a share sized
  for `k` rules lands on fewer than `k` examples at a small budget, and more than
  needed at a large one, where 0.10 already reaches the plateau. A floor is the
  number the phase needs, stated as a count.

### Consequences

A small budget now tests every declared rule of an endpoint, up to what the budget
reaches. In exchange, the other phases lose up to `k` examples at small budgets: at
5 examples the rule bugs that the other phases find fell by 2.1 with hand-written
contracts and by 1.0 with inferred ones, against the gain above. From 10 examples
on nothing changes.

A run that spends at least one semantic example per endpoint shrinks more
`semantic_property` findings: shrinking goes from about 70 to about 3 000 requests
per run on the lab, and a 5-example run from 12 s to 25 s. That cost belongs to the
shrink of these findings, not to the floor, and is bounded by the shrink's own
limits ([Shrink limits](../shrink-limits.md)).
