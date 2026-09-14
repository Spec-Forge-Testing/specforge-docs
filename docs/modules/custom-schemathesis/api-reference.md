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
    CompilationOutcome, EngineRunResult, RunStatus,
    Finding, ConfirmedFinding, FlakyFinding, UnverifiedFinding,
    CrashReport, ViolatedRule,
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

### `run(engine_input, config, *, mode=ExecutionMode.STATELESS, options=None, cancellation=NULL_TOKEN, observer=NULL_OBSERVER) -> EngineRunResult`

Execute an `EngineInput` against the API at `config.base_url` in one
`ExecutionMode` (a member or its string). `options` is validated against the
selected runner's options type; `None` means that mode's defaults, and a mode
whose options carry a required field — replay's trace — raises before any
request is sent.

`cancellation` is a `CancellationToken` the run polls between units of work to
stop cooperatively; `observer` is a `RunObserver` that receives every progress
event. Both are keyword-only and default to a Null Object, so a run nobody stops
and nobody watches pays nothing for either. What they are and how they behave is
in [Progress and cancellation](progress-and-cancellation.md).

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
| `EndpointAccess` | kernel semantic DTO: the access `policy`; for `owner_only`, the `owner_bundle` it consumes; for `role_only`, the `required_role` a caller must hold |
| `EndpointBudgetContract` | adaptive example budget; engine-only |
| `StateLinkContract`, `StateProduction`, `StateConsumption`, `TransitionInvariant` | stateful links |

## Output DTOs (the orchestrator consumes and serializes these)

Field names of this family are stable: they are persisted as columns.

| Name | One line |
|---|---|
| `CompilationOutcome` | Result: `engine_input` + `exclusions` |
| `EndpointExclusion` | one rejected endpoint with its `reason` |
| `EngineInput`, `CompiledExecutionEndpoint`, `CompiledEndpointStrategies` | the executable compile output |
| `EngineRunResult` | `findings` + `status` + `stats` + `trace` + optional `fidelity` |
| `Finding` | the discriminated union of `ConfirmedFinding`, `FlakyFinding`, `UnverifiedFinding` on `state` |
| `ConfirmedFinding` | a settled reproducer: carries its `report` |
| `FlakyFinding`, `UnverifiedFinding` | a settled group: its `signature` and how many raw `occurrences` it stands for |
| `RunStats`, `EndpointStats`, `LatencyStats` | run, endpoint and latency counters |
| `CrashReport`, `InvariantViolation` | a confirmed finding's reproducer and the invariant it broke — its `response_body` has sensitive field values redacted to `***` by name |
| `ViolatedRule` | the rule a `CrashReport` broke (`id` + `description`) — declared by the contract for a `semantic_property` / `access_control` finding, or intrinsic to the invariant for every other one |
| `ExecutionTrace`, `TracedRequest`, `TruncationRecord` | the replayable record |
| `ResponseDivergence`, `ReplayFidelity` | the replay comparison |
| `ReplayReadiness` | the outcome of `validate_replayable` |

## Runtime and per-mode options

| Name | One line |
|---|---|
| `ExecutionConfig` | global runtime: `base_url` (required), timeouts, concurrency, headers, identities. `valid_identities` and `invalid_identities` are derived views that split `identities` by credential kind; every mode rotates through `valid_identities` |
| `Identity` | one caller identity: a `label`, its credential `headers`, an optional `role` (never empty) that only a `role_only` endpoint reads (`None` never satisfies a required role), and a `credential` (`CredentialKind`, default `VALID`) |
| `StatelessOptions`, `StatefulOptions`, `PerformanceOptions`, `ReplayOptions` | passed to `run(options=...)` per mode |

## Cancellation and progress

The two signals a caller may wire into `run`, and the events an observer receives.
See [Progress and cancellation](progress-and-cancellation.md) for how they behave.

| Name | One line |
|---|---|
| `CancellationSource` | the write side a caller holds: `cancel()` stops the run, `.token` is the read-only view it passes to `run(cancellation=...)` |
| `CancellationToken` | the read side the run polls: a Protocol with one read-only `cancelled` property that never raises |
| `RunObserver` | the observer Protocol: a single `on_event(event)` receiving every `RunEvent` |
| `RunEvent` | the discriminated union of the nine event classes, on `kind` |
| `EventKind` | the `StrEnum` discriminator, one member per event class |
| `RunStarted` | `started`: the run began fuzzing `endpoints` many endpoints |
| `EndpointStarted` | `endpoint_started`: `endpoint_id`, 1-based `index`, `total` |
| `PhaseStarted` | `phase_started`: `endpoint_id`, `phase` |
| `ProgressTick` | `tick`: absolute `elapsed_s`, `sent`, `total`, `findings` |
| `FindingObserved` | `finding`: `endpoint_id`, `status_code`, `invariant`, `phase` |
| `InfraFailure` | `infra_failure`: `endpoint_id`, `reason`, `streak`, `limit` |
| `TargetDown` | `target_down`: `base_url`, `verdict` (`TargetDownVerdict`) |
| `RunTruncated` | `truncated`: `endpoint_id`, `reason` |
| `RunFinished` | `finished`: the terminal `status` |
| `TargetDownVerdict` | how a run decided the target is down: `LIVENESS_PROBE_FAILED` / `CIRCUIT_BREAKERS_OPEN` |

## Enums (only those a consumer touches)

| Name | One line |
|---|---|
| `ExecutionMode` | `STATELESS` / `STATEFUL` / `REPLAY` / `PERFORMANCE` / `RESILIENCE` / `AUTH` |
| `StrategyMode` | `DEFAULT` / `HACKER` (global on `CompilerInput`) |
| `RunStatus` | a run's terminal outcome: `COMPLETED` / `TRUNCATED` / `ABORTED` / `CANCELLED` |
| `FindingState` | a finding's settled state: `CONFIRMED` / `FLAKY` / `UNVERIFIED` |
| `ErrorCategory` | the outcome category of one request |
| `TruncationReason` | why a run, or one endpoint, was cut short (includes `TARGET_DOWN`, `INFRASTRUCTURE_ABORT`, `CANCELLED`) |
| `FidelityLevel` | `EXACT` / `REDUCED` |
| `CredentialKind` | whether an identity's credentials are ones the target should accept: `VALID` / `INVALID` |

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
| `validate_endpoint_spec(spec, *, strategy_mode)` | the ordered per-endpoint checks — types, allowed fields, ranges, phase split, focus fields, and the owner bundle — the first `PolicyError` wins ([ADR-015](adr/api.md#adr-015)). The range check covers numeric bounds and ISO `date` / `date-time` string bounds, which are parsed and compared chronologically so an inverted or incomparable date range is rejected. The owner-bundle check requires an `owner_only` endpoint's `owner_bundle` to be among the bundles it consumes, naming the consumed bundles otherwise. A `role_only` endpoint has no check here: a role cannot be judged against the compiled endpoint, so its coherence lives in the kernel and its holder check in the auth runner's precondition |
| `validate_property_field_references(semantic_property, *, known_fields)` | raises `PolicyError` when a `SemanticProperty`'s expression references a field outside `known_fields` |

## Domain exceptions

| Name | One line |
|---|---|
| `PolicyError` | boundary validation failed |
| `StrategyCompilationError` | a contract cannot become a strategy |
| `EngineError` | an execution invariant was violated |
| `AccessLinkError` | the auth runner cannot honor an `owner_only` endpoint's producer link — its bundle has no producer in the run, or provisioning the owner resource broke the producer's own contract (`endpoint_id`, `bundle`) |
| `AccessRoleError` | the auth runner cannot cross a `role_only` endpoint: no declared identity holds its required role; raised before the first request, its message naming the roles the run did declare (`endpoint_id`, `required_role`) |
| `AccessIdentityError` | the auth runner has no valid declared identity to run against; raised before the first request |

All descend from `CustomSchemathesisError`, never from `ValueError`
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
| `build_generation_plan(endpoint, strategy_mode) -> GenerationPlan` | the per-endpoint example budget: totals, phase split (with any applicable phase extension's share reserved), combination limits |
| `estimate_parameter_space(parameters) -> int` | the estimated combination count for a parameter map, capped at 10⁹ |
| `effective_phases(endpoint, base_phases) -> tuple[Phase, ...]` (`effective_phases.py`) | the profile's phases plus every phase extension the endpoint activates |
| `effective_split(endpoint, base_split) -> Mapping[Phase, float]` (`effective_phases.py`) | a phase split with each activated extension's share reserved; unchanged when none applies |
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
| `build_hacker_mutation(contract, *, context)` | the mutation-phase strategy: a non-null valid seed with one sampled operator applied |
| `build_attack_payloads(value_type, request)` | the sampled-from strategy over one field's attack payloads |
| `mutation_operators(value_type, toggles)` | the gate-enabled mutation operators for a schema type |
| `AttackRequest` | everything a base-payload builder or toggle family needs for a field |
| `AttackToggles` | the eight payload-variant flags, pinned to the contract by a guard test |
| `MutationOperator` | a frozen `(name, gate, apply)` mutation transform |
| `mutate_object(obj, depth)` | layered object mutation for prototype-pollution and overflow probing |

### `phase_extensions`

The package-root registry of phase extensions — an extra generation phase that
activates, funds itself and refines its payloads only on the endpoints it applies
to ([Extension guide](extension-guide.md#add-a-phase-extension)).

| Name | One line |
|---|---|
| `PhaseExtension` | a frozen `(phase, applies, share, refiner)`; a non-callable `applies`/`refiner` raises `TypeError`, a `share` outside `(0, 1)` raises `ValueError` |
| `register_phase_extension(extension)` | register an extension under its own phase, replacing any previous one |
| `registered_phase_extensions()` | the extensions currently registered, in registration order |
| `phase_extension_for(phase)` | the extension registered for a phase, or `None` when it is not an extension phase |
| `isolated()` | a context manager giving the block its own extension registry, restored on exit |
| `register_builtin_phase_extensions()` | the composition root (`phase_extension_builtins.py`) that registers the built-in `semantic` extension; the package `__init__` calls it once |

## Suffix conventions

A type's suffix names the role it plays at the boundary
([ADR-003](adr/foundations.md#adr-003)):

- `*Contract` — input filled by the producer or the LLM.
- `*Options` — per-mode knobs passed to `run(options=...)`.
- `*Config` — global runtime (`ExecutionConfig`).
- `*Outcome`, `*Readiness` — a return with alternatives (a Result object).
- `*Result` — the aggregate output DTO (`EngineRunResult`).
- `*Report`, `*Stats`, `*Trace` — output components; persisted, never renamed.
