# Custom Schemathesis — Architecture

The module has one-way layers. Each consumes the typed output of the previous one;
the compiler does not revalidate its input and the engine does not reinterpret
contracts or strategy modes.

| Layer | Input → output | Responsibility |
|---|---|---|
| `models` | Typed DTOs | Owns contracts, endpoint metadata, budgets and results. |
| `policy` | `CompilerInput` → validated `CompilerInput` | Validates the `CompilerInput`/`EndpointInfo` an external producer builds against the strategy mode's profile. Builds nothing, compiles nothing. |
| `strategy_compiler` | `CompilerInput` → `CompilationOutcome` | Compiles one strategy per HTTP zone and phase. |
| `engine` | `EngineInput` → `EngineRunResult` | Sends requests, validates responses, groups findings by symptom, shrinks one representative per group and deduplicates the reports. |

## The boundary

The engine never touches the LLM's output. The producer — the LLM, or a fixture —
emits the shared kernel's `EndpointContract`; the orchestrator's adapter translates it
into a `CompilerInput`; the `policy` layer validates that input; `compile_strategies`
compiles it and `run` executes it. There is no template the engine hands out and no
round-trip it resolves: the only thing that enters is a `CompilerInput`, and `policy`
is the only place that validates it. Its four validators are exported from the package
root — `validate_endpoint_contract_types`, `validate_endpoint_contract_allowed_fields`,
`validate_endpoint_contract_range_consistency` and
`validate_property_field_references` — and all of them raise `PolicyError`.

The boundary vocabulary shared with the producer is not defined here. `TransitionInvariant`,
`ZoneLocation` and the whole `SemanticProperty` expression tree are imported from
`specforge_contracts` (a declared runtime dependency, `specforge-contracts>=0.2.0`) and
re-exported from `models.compiler.contracts`, so the engine keeps a single import surface
and the same objects travel from the producer to the engine untranslated. The kernel sits
at the leaf of the dependency graph, so importing it inverts nothing. `StateProduction`,
`StateConsumption` and `StateLinkContract` remain engine-owned: they describe how the
fuzzer chains requests, not what the producer asserts.

`EndpointInfo.semantic_properties` carries the producer's `SemanticProperty` list. The
orchestrator copies it from the fused contract and validates every field reference
(`input_constraint` properties against the endpoint's parameters and dotted body paths,
`response_invariant` properties against the dotted paths of every declared response
body). No engine component consumes the slot yet — the semantic oracle is a later phase.

## Contracts and compilation

`BaseStrategyContract` is the standard, closed (`extra="forbid"`) contract.
`HackerStrategyContract` adds offensive knobs but not concrete payloads. Immutable
allowed-field tables enforce the permitted LLM output by JSON Schema type.

Each offensive knob lives at the scope that can consume it: **per-value** knobs
(`attack_profiles`, the `include_*` toggles) stay on the per-parameter
`HackerStrategyContract`; **per-endpoint** knobs (`focus_fields`, `aggressiveness`,
`mutation_depth`, ...) live on `EndpointAttackContract`; **per-request** knobs
(`include_repeated_requests`) are execution-mode options (`StatelessOptions`). The
compiler's signature is `compile_contract(contract, phase)` — one parameter in, one
value generator out — so a knob describing the whole endpoint or the request cannot be
honored from there; giving each its own home is what keeps every field consumable.

Everything a strategy mode decides lives in a **`StrategyModeProfile`**: which phases
compile, how examples split across them, which contract fields are legal, and which
contract type the mode accepts. The default profile compiles `valid`, `boundary` and
`invalid`; the hacker profile adds `attack`. The compiler asks the profile instead of
branching on the mode, so a new mode is a `register_profile` call, not an edit.

The compiler compiles path, query, header and body separately. All phase dispatch
runs through the generation phase registry: `compile_contract(contract, phase)` resolves
`(type(contract), phase)` by walking the contract's MRO, so a new contract type extends
the compiler by registering its phases with `register_phase`, not by adding a compiler.

`compile(CompilerInput) -> CompilationOutcome` compiles each endpoint independently: a
rejection (an unresolvable path parameter, an uncompilable contract) does not abort the
batch, it is caught and turned into an `EndpointExclusion` — the endpoint's identity plus
why — while the rest of the batch keeps compiling. `CompilationOutcome` carries the
endpoints that did compile (`engine_input`) alongside every exclusion, so the caller
decides what an all-or-partial rejection means for the run.

## Execution

A run names its **execution mode**, and the entry point resolves the runner registered
for it rather than choosing between hardcoded paths. A runner owns the whole procedure,
including which fuzzer it drives and how it aggregates statistics — modes differ by more
than their fuzzer, since the stateless one explores and then shrinks in two separate
phases while the stateful one minimizes as it goes. Two modes ship today; adding one is
a `register_runner` call.

That is the second of two independent extensibility axes. The runner registry answers
*how a run executes*; the strategy profile answers *what gets generated*. They never
consult each other — the engine cannot import `StrategyMode` at all.

The async engine shares an `httpx.AsyncClient`, limits concurrency and retries only
transient infrastructure failures. The entry point owns that client's lifetime, so every
mode inherits the same connection reuse and the same guaranteed close. Responses are
checked for server errors, declared status/content types, response schemas and
state-transition invariants; persisted headers are sanitized.

A run also records its **execution trace**: the ordered list of requests it actually
sent, with concrete values and the status each one returned. That is how a run is
reproduced — by re-sending the trace, never by regenerating the data — so the module
has no seed and keeps Hypothesis's example database disabled. Credentials are omitted
from the trace by origin rather than redacted, since a redacted trace could not be
replayed.

## Characterization net

`tests/characterization/` is a Golden Master suite over the compiler and engine
boundary, there to prove that a refactor of that boundary changes no observable
output. It records a deterministic projection of `compile_strategies` over
representative inputs — everything except the strategy objects themselves, which
reduce to their phase keys — and replays a recorded trace against the in-process
fixtures API demanding exact fidelity. Golden files are never rewritten silently:
they regenerate only under `SPECFORGE_UPDATE_GOLDENS=1`, and a golden going red is
either a real behavior change or an intended one that the commit has to explain.

For the full file map, algorithms, error categories and extension points, use the
[complete reference](reference.md). The strategy compiler's internals — every
builder function behind `default/` and `hacker/` — get their own page: see
[Strategy compiler internals](strategy-compiler-internals.md).
