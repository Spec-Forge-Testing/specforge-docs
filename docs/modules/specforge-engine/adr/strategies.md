# Spec Forge Engine — Decision records — Strategies

Part of the [Spec Forge Engine decision records](index.md). Decisions about what a
strategy decides, which checks it can turn on, and how each runner says what it
takes from a strategy.

---

## ADR-156 — Under `security`, the mutation phase breaks every field, not only the hinted ones { #adr-156 }

**Status:** accepted · Supersedes in part [ADR-051](compiler.md#adr-051), [ADR-127](compiler.md#adr-127) · Superseded in part by [ADR-180](compiler.md#adr-180) · `strategy_compiler/fields/mutation/`, `strategy_compiler/fields/security.py`, `strategy_compiler/fields/builtin.py`; `tests/strategy_compiler/fields/test_layering.py`

### Context

`mutation` drew from a valid seed and broke it in one place only on a field whose
contract was a `HackerStrategyContract`, and a field becomes one only when a
producer hints it. On every other field the phase fell back to the valid builder.
A `security` run without an inferred contract therefore spent its `mutation`
share on valid values: the near-miss family existed only when a model had run.

### Decision

**`mutation` registers a real builder on the base contract.**
`(BaseStrategyContract, mutation)` registers `build_base_mutation`: a non-null
valid seed and one operator sampled from the field's operator table, gated by
`DEFAULT_ATTACK_TOGGLES`, with the depth from the generation context, as the
attack phase does for a field without a contract of its own.
`(HackerStrategyContract, mutation)` keeps `build_hacker_mutation`, gated by the
toggles the contract declares. Only `security` plans `mutation`, so no other
strategy changes.

**A mutated request is not poisoned.** `mutation` declares no candidates, so its
requests name no poisoned field: an operator can return a valid value
(`increment` inside the range), and judging it as invalid input would report a
defect that is not one. The oracles that judge every response (`not_a_server_error`,
the conformance oracles, `sensitive_data_exposure`) judge it.

**The phase gets a package of its own.** `fields/mutation/` holds the operators,
their tables, the object mutation and the builders; `fields/security.py` holds
what tunes the attack and mutation builders from an attack contract, above both.
The layers point one way, `security` → `mutation` → `attack` → `default`, pinned
by the layering test.

### Rejected

- **Keeping the valid fallback.** It leaves a funded phase that sends nothing a
  `valid` pass does not.
- **Poisoning the mutated field.** It needs to know whether the mutated value
  still meets its schema, and an operator does not say; a valid result would be
  reported as accepted invalid input.
- **Mutation as a strategy of its own.** It intensifies the adversarial
  strategy; forking a profile for one more phase duplicates everything else.

### Consequences

A `security` run breaks every field one operator at a time, with or without a
producer. The structural operators (`extra_key`, `pollute`) stay in the base
builder: a strict server could answer an extra key with a 422 that reads as
`contract_completeness`, and on the lab and RealWorld targets no such finding
appeared.

---

## ADR-157 — A strategy opts into oracles, and `conformance` turns on the undeclared-field invariant { #adr-157 }

**Status:** accepted · Superseded in part by [ADR-199](#adr-199) · `runtime/oracles/registry.py`, `runtime/oracles/undeclared_fields.py`, `runtime/oracles/response_walk.py`, `strategy_compiler/compiler.py`, `main.py`, `profiles/builtin.py`, `models/runtime/taxonomy.py`; core `services/fuzz/projection/schema.py`

### Context

The oracle registry is global: every registered oracle judges every response, and
nothing at run time knows the strategy. Some checks are worth running only when a
user asks for them. A response field the contract does not declare is the clearest
case: OpenAPI admits extra properties by default, most APIs return some, and
reporting them in every run would bury the defects a general run is for. An
audit of the contract wants exactly those findings.

### Decision

**Opting in is registry metadata.** `register_oracle(oracle, opt_in=True,
requires_contract=True)` records both flags in an `OracleRegistration` beside the
oracle; the `ResponseOracle` Protocol does not change. A profile names its opt-in
oracles in `optional_oracles`; the compiler seals them on every
`CompiledExecutionEndpoint.optional_oracles`, and `check_response` hands them to
`evaluate`, which keeps an opt-in oracle only when its name is there.
`compile_strategies` checks each name with `require_opt_in` and raises
`PolicyError` for an unknown or always-on one. A contract-free judgement runs only
the oracles that are neither opt-in nor `requires_contract`.

**`undeclared_response_field` is the first opt-in invariant** (`contract_hygiene`,
`low`), turned on by `conformance` only. A JSON response breaks it when an object
whose declared schema names its properties, and does not admit extra ones, holds a
key it does not declare; arrays are walked through `items`. A secret-looking key is
left to `sensitive_data_exposure`, so one key is never reported twice. Both oracles
read keys through one walker, `response_keys`, which pairs every key with the
declared schema of the object that holds it.

**The rule names the contract, never a server key.** The rule id is `response` or
`response.<holder>`, the schema path of the shallowest object holding an extra key
(the lexicographically first among equals), built from declared names only and
without array indexes. The observation's `expected` maps each such path to the
property names it declares; `observed` lists up to 20 pointers of extra keys and
counts the rest as `omitted`. Values are never read.

**The projection must not invent closed objects.** The core projects a response
object built with `allOf`, `oneOf` or `anyOf` as open, and honors
`additionalProperties` whatever the object's `type` spelling (missing, `object`, or
a list naming `object`), so a mixin or a map is not judged closed.

### Rejected

- **The flag on the Protocol.** Every oracle and every test double would carry
  it, and an oracle registered twice could disagree with itself.
- **Running the invariant in every strategy.** Its findings are real but low, and
  they would outnumber everything else on most APIs.
- **The first extra key as the rule id.** The server chooses that key: a token
  returned as a key would travel unredacted through the rule, the signature,
  storage and the `finding` event, and dynamic keys would change the signature on
  every request.

### Consequences

`conformance` reports contract drift that no other strategy shows. An opt-in
finding is never seen by a replay, which judges contract-free, so its replay
verdict is `inconclusive`. A new opt-in oracle is one registration and one name in
a profile.

---

## ADR-159 — Runners declare their traits, the effects matrix is derived from them, and `changes` is measured against `default` { #adr-159 }

**Status:** accepted · Superseded in part by [ADR-199](#adr-199) · `models/runtime/runner_traits.py`, `runtime/runners/protocol.py`, `runtime/runners/registry.py`, every runner; `tests/test_runner_traits_gate.py`; core `services/deps/engine_vocabulary.py`, `services/catalog/effects.py`, `services/catalog/fuzz_options.py`

### Context

A runner does not read the strategy's profile; it reads the compiled plan, and
how much of it depends on how it runs. `resilience` sends a fixed chaos battery,
so the strategy changes nothing it sends; the `performance` ladder and `auth` send
only valid values; `stateful` draws valid values and transitions, under a cap of
its own. Which strategy changes what in which mode existed only in prose, and a
client that wanted to say so had to write the matrix by hand, where it would drift
the first time a runner or a strategy changed.

### Decision

**Each runner declares its traits per variant.** The `ExecutionRunner` Protocol
gains `variants()`, a map of variant name to `RunnerTraits(consumes,
honors_examples_per_endpoint, examples_cap, judges_opt_in_oracles)`, and
`variant_for(options)`. `performance` declares `flat` and `ladder`; every other
runner one `default` variant. `runner_traits()` and `runner_traits_for(mode,
options)` are on the facade.

**A gate holds the declaration to the behaviour.** On an endpoint built to draw
every phase, under `security`, each registered variant sends exactly the phases it
declares; every runner's own tests check what it sends stays within them; the
count, the cap and the opt-in oracles are each checked against what the runner
does.

**The core derives the matrix.** Its gateway projects the traits and the profiles
into plain terms, and each row of `fuzz_options.effects` (mode, variant, strategy,
producer) carries `changes`: a list of closed codes (`payloads`, `oracles`,
`examples`, `llm_profile`, `field_hints`), each decided by one pure rule, all
against one baseline, `default`. An empty list is published too: it says the
strategy changes nothing there.

### Rejected

- **A hand-written matrix**, in the core or in a client. It is a second copy of
  what the runners do.
- **One level per row** (`payloads`, `contract_only`, `none`) and a reason. The
  causes combine: `smoke` in `stateful` changes the example count and not the
  payloads, and a single level forces a choice between true statements.
- **A static traits table per mode.** The `performance` variant depends on the
  run's options, so the runner has to name it.
- **Requiring every runner test to send every declared phase.** A planned phase
  can legitimately send nothing on a given endpoint; equality is checked once, on
  an endpoint built for it.

### Consequences

A new runner or strategy appears in the matrix with no table to edit. The core
publishes only the modes its `execution` parameter accepts, so the replay
runner's traits are declared and gated but never listed. A client renders the
codes as it likes; the protocol carries no wording.

---

## ADR-199 — What a run can find is derived from the engine, not listed { #adr-199 }

**Status:** accepted · Supersedes in part [ADR-157](#adr-157) (an oracle's flags are read off its needs) and [ADR-159](#adr-159) (`judges_opt_in_oracles` is read off `supplies`) · `models/runtime/oracle_need.py`, `models/runtime/runner_traits.py`, `runtime/oracles/registry.py`, `runtime/oracles/builtin.py`, `runtime/oracles/reportable.py`, `strategy_compiler/supplied_needs.py`, every runner; `tests/test_invariant_claims_gate.py`, `tests/test_reachability_gate.py`; core `services/catalog/reportable.py`, `services/catalog/fuzz_options.py`

### Context

A run picker has to say what a run will judge: which invariants a mode, a strategy
and a producer can surface, and what a choice would add. With no such fact on the
wire, a client hardcodes a table of its own, invariant by mode, and such a table
drifts from the engine at once: one promised `input_validation`
under `smoke`, which poisons no field; attack-phase checks in `stateful`, which
draws only valid values; `reflected_payload` only under `security`, though
`exposure` plans the attack phase too. A client that promises a check the run
never makes turns an absent finding into a false all-clear, and one that leaves
out a check the run makes hides what a finding can be.

### Decision

**Oracles and runners declare, the engine derives.** Each oracle registration
states the invariants it `reports` and what a response must come with before it
can judge one, as `OracleNeeds`: a set of **alternatives**, each a set of
`OracleNeed`s, any one of which is enough. `input_validation` judges a request
that sent a field outside its schema or a witness of a rule a producer inferred;
`sensitive_data_exposure` judges a response against the contract, or a poisoned
request without it, or a witness. Each runner variant's `RunnerTraits` state
whether the oracles' verdicts on its responses become findings
(`reports_oracle_verdicts`), what it `reports_natively` and which needs it
`supplies`. `NEED_SUPPLIERS` names who meets each need: the runner, the strategy,
the producer or the run's request. `reportable_invariants` folds the two into
`ReportableInvariants`: what the variant reports whatever the run (`always`), and
what it adds once one need is met (`by_need`), an invariant two needs open being
under each. `strategy_supplies` derives the needs a strategy meets from its
profile.

**Each need names one path to a finding.** A need is met by one supplier, so it says
which request makes the finding possible: `poisoned_field` and
`out_of_schema_field` are the strategy's draws, `rule_witness` the producer's
witness, `admitted_caller` a runner that sends as a caller the endpoint admits.
The streak timeout is judged by the stateless fuzzer itself, so every runner built
on it reports `input_induced_timeout` natively.

**The core publishes per variant, with the suppliers and a formula.** Each variant
carries `invariants` and `invariants_when`; each strategy its `supplies`;
`producer_supplies` and `request_supplies` say what a producer and a run parameter
meet. The protocol states how a client combines them, so what a run of any mode,
strategy, producer and parameters can find is computed from data alone.

**Two gates pin the result.** The claims gate holds the declarations: every
invariant is claimed by an oracle or a runner, every need has a supplier, no
alternative waits on two needs a runner cannot meet, and each built-in variant's
derived set is written out, so a change to what a mode can find is a reviewed
change. The reachability gate holds the runs: each published pair runs its variant
through the real runner against a target breaking the invariant and must be
reported, and no run reports an invariant its variant does not publish for the
needs it met.

### Rejected

- **A hand-written table**, in the core or in a client. It is a second copy of
  what the oracles and runners do, and the one that already drifted.
- **One set of needs per oracle.** An oracle reached by two different requests
  cannot say so with one conjunction: registered with fewer needs it over-claims
  where neither request is sent, registered with more it under-claims where one
  is. Alternatives say both paths.
- **A need met by several suppliers.** A strategy and a producer meeting one need
  would hide which choice opens the finding, and a client could not tell a person
  what to change to get it. One supplier per need keeps that answer in the data.
- **A need per attack family on every oracle.** Only two dependencies on the
  family of a payload change a published set, so only those are modelled:
  `reflecting_attack`, met by a strategy that plans `attack` and allows a family in
  `REFLECTING_FAMILIES`, and `out_of_schema_field`, met also by an `attack` that
  allows a family a field is attacked with by its type alone. Every other
  attack-phase oracle needs `attack_phase`.
- **Several unmet needs per alternative.** An alternative that waits on two needs
  a runner cannot meet would need a conjunction on the wire; the gate forbids it
  instead, and one need per entry keeps the client's formula a union.

### Consequences

What a mode can find moves with the engine: a new oracle or runner appears with no
table to edit, and its words come from the engine's own texts. The published sets
match what the runners report in both directions: `resilience` lists neither
`sensitive_data_exposure` nor an opt-in check, since it judges without the
contract and names no optional oracle; `auth` lists neither
`sensitive_data_exposure` nor `semantic_property`, since it never sends an
admitted caller; `exposure` opens no `input_validation` by itself, since its
`auth_bypass` attacks keep every field within its schema; the streak timeout is in
`stateless` and both `performance` variants whatever the strategy; a producer's
witnesses open `input_validation` under any strategy; and `replay` publishes
nothing. The
published set says what a run *can* report, never what it will find
([What a run can find](../reportable-invariants.md)).
