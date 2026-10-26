# Spec Forge Engine — Decision records — Strategies

Part of the [Spec Forge Engine decision records](index.md). Decisions about what a
strategy decides, which checks it can turn on, and how each runner says what it
takes from a strategy.

---

## ADR-156 — Under `security`, the mutation phase breaks every field, not only the hinted ones { #adr-156 }

**Status:** accepted · Supersedes in part [ADR-051](compiler.md#adr-051), [ADR-127](compiler.md#adr-127) · `strategy_compiler/fields/mutation/`, `strategy_compiler/fields/security.py`, `strategy_compiler/fields/builtin.py`; `tests/strategy_compiler/fields/test_layering.py`

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

**Status:** accepted · `runtime/oracles/registry.py`, `runtime/oracles/undeclared_fields.py`, `runtime/oracles/response_walk.py`, `strategy_compiler/compiler.py`, `main.py`, `profiles/builtin.py`, `models/runtime/taxonomy.py`; core `services/fuzz/projection/schema.py`

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

**Status:** accepted · `models/runtime/runner_traits.py`, `runtime/runners/protocol.py`, `runtime/runners/registry.py`, every runner; `tests/test_runner_traits_gate.py`; core `services/deps/engine_vocabulary.py`, `services/catalog/effects.py`, `services/catalog/fuzz_options.py`

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
