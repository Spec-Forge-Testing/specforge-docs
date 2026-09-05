# Custom Schemathesis — API reference

Everything `custom_schemathesis` exposes, and nothing else. Every name below is
importable from the package root; anything reached through a deeper module
path is internal and may change without notice
([ADR-014](adr/api.md#adr-014)). The tables mirror the package's `__all__`, a
frozen list a test enforces: adding or removing an export fails the suite by
name.

For how the stages work inside, see [Architecture](architecture.md) and
[Data flow](data-flow.md); for why they are shaped that way, the
[decision records](adr/index.md).

```python
from custom_schemathesis import (
    compile_strategies, run,
    CompilerInput, EndpointSpec, RequestZones,
    BaseStrategyContract, HackerStrategyContract,
    ExecutionConfig, Identity, ExecutionMode, StrategyMode,
    CompilationOutcome, EngineRunResult, CrashReport,
)
```

## Entry points

### `compile_strategies(compiler_input) -> CompilationOutcome`

Validated contracts to executable strategies, for every endpoint of the input.
Endpoints that cannot be compiled are reported as `EndpointExclusion`s on the
outcome; the ones that can are the `EngineInput`. Named so that it does not
hide the builtin `compile`.

**Raises** `PolicyError` when the input itself is malformed for the chosen
`StrategyMode`; a per-endpoint compile failure is an exclusion, not an
exception.

### `run(engine_input, config, *, mode=ExecutionMode.STATELESS, options=None) -> EngineRunResult`

Execute an `EngineInput` against the API at `config.base_url` in one
`ExecutionMode` (a member or its string). `options` is validated against the
selected runner's options type; `None` means that mode's defaults, and a mode
whose options carry a required field — replay's trace — raises before any
request is sent.

**Raises** `EngineError` for an unknown mode or a violated execution
invariant, `StatefulLinkError` when a state link cannot be honored.

## Input DTOs (the orchestrator builds these)

| Name | One line |
|---|---|
| `CompilerInput` | the endpoints plus a single global `strategy_mode` |
| `EndpointSpec` | one endpoint: identity, zones, content types, and its endpoint-level controls |
| `RequestZones` | the four request zones of an `EndpointSpec`, one `ParamMap` per `Zone` |
| `BaseStrategyContract` | per-value generation knobs, JSON Schema aliases |
| `HackerStrategyContract` | subclass adding attack profiles and payload-variant toggles |
| `ResponseContract` | expected `content_type` and `body_schema` for a status |
| `EndpointRisk` | kernel semantic DTO: criticality, sensitivity, risk score |
| `EndpointAttack` | kernel semantic DTO: attack profiles, focus and sensitive fields, hints |
| `EndpointBudgetContract` | adaptive example budget; engine-only |
| `StateLinkContract`, `StateProduction`, `StateConsumption`, `TransitionInvariant` | stateful links |

## Output DTOs (the orchestrator consumes and serializes these)

Field names of this family are stable: they are persisted as columns.

| Name | One line |
|---|---|
| `CompilationOutcome` | Result: `engine_input` + `exclusions` |
| `EndpointExclusion` | one rejected endpoint with its `reason` |
| `EngineInput`, `CompiledExecutionEndpoint`, `CompiledEndpointStrategies` | the executable compile output |
| `EngineRunResult` | `crash_reports` + `stats` + `trace` + optional `fidelity` |
| `RunStats`, `EndpointStats`, `LatencyStats` | run, endpoint and latency counters |
| `CrashReport`, `InvariantViolation` | one finding and the invariant it broke |
| `ExecutionTrace`, `TracedRequest`, `TruncationRecord` | the replayable record |
| `ResponseDivergence`, `ReplayFidelity` | the replay comparison |
| `ReplayReadiness` | the outcome of `validate_replayable` |

## Runtime and per-mode options

| Name | One line |
|---|---|
| `ExecutionConfig` | global runtime: `base_url` (required), timeouts, concurrency, headers, identities |
| `Identity` | one caller identity: a `label` and its credential `headers` |
| `StatelessOptions`, `StatefulOptions`, `PerformanceOptions`, `ReplayOptions` | passed to `run(options=...)` per mode |

## Enums (only those a consumer touches)

| Name | One line |
|---|---|
| `ExecutionMode` | `STATELESS` / `STATEFUL` / `REPLAY` / `PERFORMANCE` / `RESILIENCE` |
| `StrategyMode` | `DEFAULT` / `HACKER` (global on `CompilerInput`) |
| `ErrorCategory` | the outcome category of one request |
| `TruncationReason` | why a run, or one endpoint, was cut short |
| `FidelityLevel` | `EXACT` / `REDUCED` |

`Zone`, `Phase`, `SchemaType`, `Sensitivity` and the other vocabularies are
internal or kernel-owned and are not exported by the engine facade; import the
kernel's from `specforge_contracts`.

## Trace helpers

| Name | One line |
|---|---|
| `canonical_json(trace) -> str` | canonical JSON of a trace, for content-addressing |
| `split_userinfo(url) -> tuple[str, str \| None]` | split `user:pass@` out of a URL |
| `validate_replayable(trace, config) -> ReplayReadiness` | whether a trace can be replayed under this config |

## Input validation (the policy boundary)

| Name | One line |
|---|---|
| `validate_endpoint_spec(spec, *, strategy_mode)` | the three per-endpoint checks, in order; the first `PolicyError` wins ([ADR-015](adr/api.md#adr-015)) |
| `validate_property_field_references(semantic_property, *, known_fields)` | raises `PolicyError` when a `SemanticProperty`'s expression references a field outside `known_fields` |

## Domain exceptions

| Name | One line |
|---|---|
| `PolicyError` | boundary validation failed |
| `StrategyCompilationError` | a contract cannot become a strategy |
| `EngineError` | an execution invariant was violated |

All three descend from `CustomSchemathesisError`, never from `ValueError`
([ADR-001](adr/foundations.md#adr-001)). The full taxonomy, including
`EndpointCompilationError` and `StatefulLinkError`, is importable from
`custom_schemathesis.exceptions`.

## Strategy compiler

These names are not on the facade — they live under
`custom_schemathesis.strategy_compiler` and its `fields` subpackage. They are
the surface an extension registers against and the seams the compiler's own
tests exercise, documented for that reason
([Strategy compiler](strategy-compiler.md), [Extension guide](extension-guide.md)).

### `strategy_compiler`

| Name | One line |
|---|---|
| `compile(compiler_input) -> CompilationOutcome` | the whole compile; the facade re-exports it as `compile_strategies` |
| `build_generation_plan(endpoint, strategy_mode) -> GenerationPlan` | the per-endpoint example budget: totals, phase split, combination limits |
| `estimate_parameter_space(parameters) -> int` | the estimated combination count for a parameter map, capped at 10⁹ |
| `compile_zone(zone, params, ctx) -> CompiledRequestPart` | one zone's per-phase strategies plus its documentation schema |
| `build_zone_schema(params, *, force_required) -> dict` | the zone's parameters as a JSON Schema object |
| `is_field_addressed(zone, name, entries) -> bool` | whether a field is named by an attack addressing list, bare or zone-qualified |
| `ZoneCompileContext` | endpoint-wide knobs constant across an endpoint's zones |

### `strategy_compiler.fields`

| Name | One line |
|---|---|
| `compile_contract(contract, phase, *, context)` | resolve and build the strategy for a `(contract type, phase)` |
| `register_phase(phase)` | register a `GenerationPhase` under `(contract_type, name)` |
| `registered_phases()` | the keys currently in the phase table |
| `resolve_phase(contract, phase)` | the phase registered for a contract's type or its nearest ancestor |
| `isolated()` | a context manager giving the block its own phase registry, restored on exit |
| `GenerationPhase` | one `(name, contract_type, build)` mapping; a non-callable `build` is rejected |
| `GenerationContext` | endpoint-wide generation knobs a builder may read |
| `EMPTY_CONTEXT` | the shared context for an endpoint with no attack knobs |
| `SchemaView` | typed, read-only view over a strategy contract (below) |

`SchemaView` properties, each returning a closed enum or a scalar, never a raw
key:

| Property | Returns |
|---|---|
| `value_type` | the `SchemaType` or `None` |
| `enum` | the enum tuple or `None` |
| `is_nullable` · `is_required` · `allow_extra_fields` | booleans |
| `minimum` · `maximum` · `exclusive_minimum` · `exclusive_maximum` · `multiple_of` | numeric bounds |
| `min_length` · `max_length` · `min_items` · `max_items` | length and size bounds |
| `format` | the raw format string or `None` |
| `known_format` | the `SchemaFormat` for a recognized spelling, else `None` |
| `pattern` | the regex pattern or `None` |
| `property_count` | the object's declared property count |
| `json_schema` | the one raw `model_dump` — the zone schema and the jsonschema fallback |

### `strategy_compiler.fields.hacker`

| Name | One line |
|---|---|
| `build_hacker_attack(contract, *, context)` | the attack-phase strategy for a hacker contract |
| `build_attack_payloads(value_type, request)` | the sampled-from strategy over one field's attack payloads |
| `AttackRequest` | everything a base-payload builder or toggle family needs for a field |
| `AttackToggles` | the eight payload-variant flags, pinned to the contract by a guard test |
| `mutate_object(obj, depth)` | layered object mutation for prototype-pollution and overflow probing |

## Suffix conventions

A type's suffix names the role it plays at the boundary
([ADR-003](adr/foundations.md#adr-003)):

- `*Contract` — input filled by the producer or the LLM.
- `*Options` — per-mode knobs passed to `run(options=...)`.
- `*Config` — global runtime (`ExecutionConfig`).
- `*Outcome`, `*Readiness` — a return with alternatives (a Result object).
- `*Result` — the aggregate output DTO (`EngineRunResult`).
- `*Report`, `*Stats`, `*Trace` — output components; persisted, never renamed.
