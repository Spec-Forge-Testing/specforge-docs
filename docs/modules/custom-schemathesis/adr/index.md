# Custom Schemathesis — Decision records

Decisions taken while building `custom_schemathesis` that are not obvious
from reading the code, and that someone would otherwise be tempted to undo.
Each record states the situation that forced the decision, what was decided,
the alternative that was rejected, and what it costs.

They are append-only and numbered in the order they were written down. A
record is never edited to reflect a later change of mind — a new record
supersedes it.

!!! info "The rule these decisions answer to"
    **Report what was measured, never what was inferred.** Every counter has
    one producer; a flaky finding is counted where it was observed, not
    derived by subtraction; a request that never reached the wire is not
    evidence about the API. When a shortcut would make a number look better
    than what the engine actually saw, the number wins.

## Where a decision lives

The records are split one file per area, in pipeline order, plus one file for
decisions that belong to no single area. Numbers stay global and are never
reused across files — the number tells you when it was written, the file
tells you what it governs.

| File | Area | Covers |
| --- | --- | --- |
| [foundations.md](foundations.md) | package-wide | Exceptions, the root constants, naming |
| [models.md](models.md) | models | Vocabularies, the contract package, the boundary DTOs |
| [api.md](api.md) | facade / policy | What `run` takes, what the facade exports, how input is validated |
| [compiler.md](compiler.md) | strategy_compiler | How a field becomes a strategy |
| [engine.md](engine.md) | engine | Findings, counters, runners, replay |

## Full index

| | Area | Decision |
| --- | --- | --- |
| [ADR-001](foundations.md#adr-001) | package | Every domain exception descends from `CustomSchemathesisError`, none from `ValueError` |
| [ADR-002](foundations.md#adr-002) | package | The root `constants.py` imports nothing, and the phase splits are profile data |
| [ADR-003](foundations.md#adr-003) | package | A type's suffix names the role it plays at the boundary |
| [ADR-004](models.md#adr-004) | models | Closed vocabularies are `StrEnum` members, the shared ones owned by the kernel |
| [ADR-005](models.md#adr-005) | models | Generation knobs stay in the engine; only vocabularies go to the kernel |
| [ADR-006](models.md#adr-006) | models | The contract vocabulary is a sibling of the compiler and engine models |
| [ADR-007](models.md#adr-007) | models | Risk and attack travel as the kernel's own types |
| [ADR-008](models.md#adr-008) | models | The four request zones are one value object |
| [ADR-009](models.md#adr-009) | models | `EndpointSpec` keeps its endpoint-level controls flat |
| [ADR-010](models.md#adr-010) | models | `HackerStrategyContract` is a subclass, dispatched by type |
| [ADR-011](models.md#adr-011) | models | `GenerationPlan` is a frozen engine-side value that scales by replacement |
| [ADR-012](models.md#adr-012) | models | `SchemaKeyword` includes `default` |
| [ADR-013](api.md#adr-013) | facade | `run` takes an `ExecutionMode` and per-mode options, nothing else |
| [ADR-014](api.md#adr-014) | facade | The facade exports what the orchestrator names, and nothing else |
| [ADR-015](api.md#adr-015) | policy | Endpoint validation is three ordered checks behind one verb |
| [ADR-016](compiler.md#adr-016) | strategy_compiler | Field builders are functions in tables, not implementations of a Protocol |
| [ADR-017](engine.md#adr-017) | engine | `ExecutionResult` is the canonical record of a request; stats and trace are projections |
| [ADR-018](engine.md#adr-018) | engine | Flaky findings are counted where they are observed, in the shrinker |
| [ADR-019](engine.md#adr-019) | engine | Stateful runs discard flaky findings |
| [ADR-020](engine.md#adr-020) | engine | Finding resolution is a callable on the loop specification |
| [ADR-021](engine.md#adr-021) | engine | Options are resolved beside the runner registry |
| [ADR-022](engine.md#adr-022) | engine | Replay readiness is a value object the engine computes |
| [ADR-023](compiler.md#adr-023) | strategy_compiler | `SchemaView` wraps the contract, not its dump |
| [ADR-024](compiler.md#adr-024) | strategy_compiler | The generation context is always present |
| [ADR-025](compiler.md#adr-025) | strategy_compiler | Phase builders are registered explicitly |
| [ADR-026](compiler.md#adr-026) | strategy_compiler | `GenerationPhase` rejects a non-callable builder |
| [ADR-027](compiler.md#adr-027) | strategy_compiler | `AttackToggles` are explicit fields, pinned by a test |
| [ADR-028](compiler.md#adr-028) | strategy_compiler | The attack builder takes the type, defaulted by its caller |
| [ADR-029](compiler.md#adr-029) | strategy_compiler | The zone compile context does not carry the zone |
| [ADR-030](compiler.md#adr-030) | strategy_compiler | The generation plan is built directly, never mutated |
| [ADR-031](compiler.md#adr-031) | strategy_compiler | A foreign phase split is a `PolicyError`, kept where it is raised |
| [ADR-032](compiler.md#adr-032) | strategy_compiler | Compiled output carries the kernel attack contract in full |
| [ADR-033](engine.md#adr-033) | engine | A zoned payload is a value object with a body sentinel |
| [ADR-034](engine.md#adr-034) | engine | One stop signal crosses the `@given` boundary |
| [ADR-035](engine.md#adr-035) | engine | Exploration state is run-scoped; the liveness probe is shared across endpoints |
| [ADR-036](engine.md#adr-036) | engine | Oracles run as an ordered pipeline with central precedence, registered explicitly |
| [ADR-037](engine.md#adr-037) | engine | `FindingFacts` is the single subject of every crash report |
| [ADR-038](engine.md#adr-038) | engine | The stateful machine is built in a builder, and a pass ends in a closed set of outcomes |
| [ADR-039](engine.md#adr-039) | engine | A `StatefulLinkError` is reconstructed to name its endpoint, never mutated |
| [ADR-040](engine.md#adr-040) | engine | Pacing is a strategy chosen by a factory, not a flag |
| [ADR-041](engine.md#adr-041) | engine | A chaos transport is a Protocol resolved from a registry |
| [ADR-042](foundations.md#adr-042) | package | Each stage owns its constants; the root holds only what two or more layers share |
| [ADR-043](engine.md#adr-043) | engine | The shared endpoint loop is a higher-order function over a three-field spec |
| [ADR-044](engine.md#adr-044) | engine | The public findings are a closed union of outcomes; the counters stay measurements |
| [ADR-045](engine.md#adr-045) | engine | Run status is derived by the engine from the truncation reason |
| [ADR-046](engine.md#adr-046) | engine | Replay readiness separates missing URL userinfo from a host mismatch, and checks every request's host |
