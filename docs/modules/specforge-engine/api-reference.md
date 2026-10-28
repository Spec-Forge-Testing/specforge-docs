# Spec Forge Engine — API reference

Everything `specforge_engine` exposes, and nothing else. Every name below is
importable from the package root; anything reached through a deeper module
path is internal and may change without notice
([ADR-014](adr/api.md#adr-014)). The tables mirror the package's `__all__`, a
frozen list a test enforces: adding or removing an export fails the suite by
name.

For how the stages work inside, see [Architecture](architecture.md) and
[Data flow](data-flow.md); for why they are shaped that way, the
[decision records](adr/index.md).

```python
from specforge_engine import (
    compile_strategies, run,
    CompilerInput, EndpointSpec, RequestZones, BodySpec,
    BaseStrategyContract, HackerStrategyContract,
    ExecutionConfig, Identity, ExecutionMode, Strategy, StrategyProfile,
    CompilationOutcome, EngineRunResult, RunStatus,
    Finding, ConfirmedFinding, FlakyFinding, UnverifiedFinding, RefutedFinding,
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
`Strategy`, or when that strategy's profile opts into an oracle that is unknown
or not opt-in; a per-endpoint compile failure is an exclusion, not an exception.

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
| `CompilerInput` | the endpoints plus a single global `strategy` (default `Strategy.DEFAULT`), and the `withheld` ones |
| `WithheldEndpoint` | an endpoint its caller keeps out of the run: `method`, `path_url`, `risk`, `reason`; compiled into an exclusion whose risk still vetoes its route |
| `EndpointSpec` | one endpoint: identity, zones, and its endpoint-level controls |
| `RequestZones` | the request zones of an `EndpointSpec`: `path`, `query` and `header` as `ParamMap`s, and `body` as a `BodySpec` or `None` |
| `BodySpec` | the declared body: `media_type`, `required` (default `False`) and the `root` contract; `fields` is the root's properties (empty when the root is not an object) and `drawn_fields` what a body draw fills — its fields, or the root alone under `$`. A required body makes its root required ([Requests](requests.md#the-body)) |
| `BaseStrategyContract` | per-value generation knobs, JSON Schema aliases |
| `HackerStrategyContract` | subclass adding the field's attack families (`attack_profiles`) and payload-variant toggles |
| `ResponseContract` | expected `content_type` and `body_schema` for a status |
| `EndpointRisk` | kernel semantic DTO: criticality, sensitivity, risk score |
| `EndpointAttack` | kernel semantic DTO: focus and sensitive fields, aggressiveness, mutation depth, and per-field hints carrying attack families |
| `EndpointAccess` | kernel semantic DTO: the access `policy`; for `owner_only`, the `owner_bundle` it consumes; for `role_only`, the `required_role` a caller must hold |
| `EndpointBudgetContract` | adaptive example budget; engine-only |
| `StateLinkContract`, `StateProduction`, `StateConsumption`, `TransitionInvariant` | stateful links |

## Output DTOs (the orchestrator consumes and serializes these)

Field names of this family are stable: they are persisted as columns.

| Name | One line |
|---|---|
| `CompilationOutcome` | Result: `engine_input` + `exclusions` |
| `EndpointExclusion` | one rejected or withheld endpoint with its `reason` |
| `EngineInput`, `CompiledExecutionEndpoint`, `CompiledEndpointStrategies` | the executable compile output; `CompiledEndpointStrategies` holds one compiled part per zone (`body` a `CompiledBody`), the `generation_plan`, and the `poisoning_phases` its contract type poisons; `CompiledExecutionEndpoint.optional_oracles` names the opt-in oracles its strategy turns on |
| `EngineRunResult` | `findings` + `status` + `stats` + `trace` + optional `fidelity` |
| `Finding` | the discriminated union of `ConfirmedFinding`, `FlakyFinding`, `UnverifiedFinding`, `RefutedFinding` on `state` |
| `ConfirmedFinding` | a settled reproducer: carries its `report` |
| `FlakyFinding`, `UnverifiedFinding` | a settled group: its `signature` and how many raw `occurrences` it stands for |
| `RefutedFinding` | a group a control request showed is not a defect: its `signature`, `occurrences`, `first_seen` and the `control` that refuted it |
| `RunStats`, `EndpointStats`, `LatencyStats` | run, endpoint and latency counters — `EndpointStats.unprobed_reason` names why a targeted endpoint drew no requests |
| `LoadStepStats` | one concurrency-ladder step on an endpoint's `load_profile`: its `concurrency`, measured `latency`, `degraded` verdict (`None` when unjudged) and, when the step was measured twice to confirm a degradation, the second window as `remeasured` |
| `UnprobedReason` | why the auth mode crossed nothing, or resilience sent nothing, at a targeted endpoint: `declared_public` or `access_undeclared` (by design), `owner_producer_missing`, `owner_chain_cyclic`, `owner_resource_unprovisioned`, `required_role_unheld`, `owner_identity_missing` or `link_target_reserved` (a precondition the run could not meet) — each one in [Execution modes](execution-modes.md#auth) |
| `CrashReport`, `InvariantViolation` | a confirmed finding's reproducer and the invariant it broke — its `response_body` has sensitive field values redacted to `***` by name |
| `ViolatedRule` | the rule a `CrashReport` broke (`id` + `description`) — declared by the contract for a `semantic_property` / `access_control` finding, the accepted field (`<zone>.<path>`, such as `query.limit`, `body.user.email` or `body.$`) for an `input_validation` finding, or intrinsic to the invariant for every other one |
| `keyed_identity(invariant, identity_label) -> str \| None` | the identity that tells two findings of `invariant` apart: the label for `access_control`, `None` for every other invariant ([ADR-106](adr/engine.md#adr-106)) |
| `ExecutionTrace`, `TracedRequest`, `TruncationRecord` | the replayable record; a `TracedRequest` records the request's intent as `phase`, `poisoned_zone`, `poisoned_field` (a nested field by its spelled path) and `poisoned_family` (the one field with a default, `None`), and its body with `media_type` and `file_fields` |
| `ResponseDivergence`, `ReplayFidelity` | the replay comparison |
| `ReplayReadiness` | the outcome of `validate_replayable` |

## Runtime and per-mode options

| Name | One line |
|---|---|
| `ExecutionConfig` | global runtime: `base_url` (required; an `http`/`https` URL naming a host, with a port from 1 to 65535 when it writes one, and no `@` in its fragment), timeouts, concurrency, headers, identities. `valid_identities` and `invalid_identities` are derived views that split `identities` by credential kind; every mode rotates through `valid_identities`, and `first_valid_identity` is the one a mode that sends under a single identity uses |
| `Identity` | one caller identity: a `label`, its credential `headers`, an optional `role` (never empty) that only a `role_only` endpoint reads (`None` never satisfies a required role), and a `credential` (`CredentialKind`, default `VALID`) |
| `StatelessOptions`, `StatefulOptions`, `PerformanceOptions`, `ReplayOptions` | passed to `run(options=...)` per mode |
| `ConcurrencyLadder` | the value of `PerformanceOptions.concurrency_ladder`: strictly increasing `steps` plus the degradation `tolerance` (frozen) |

## Strategies and runner traits

What a strategy decides and what each runner takes from it
([Strategies and runner traits](strategies.md)).

| Name | One line |
|---|---|
| `Strategy` | the strategy a compile runs under: `DEFAULT` / `SECURITY` / `CONFORMANCE` / `SMOKE` / `EXPOSURE`, valued by their wire spellings (global on `CompilerInput`) |
| `StrategyProfile` | what one strategy decides: `phase_split`, `allowed_fields_by_type`, `contract_type`, `allow_contract_subclasses`, `default_max_examples`, `optional_oracles`, `attack_families`, `omits_read_only`, and the derived `promotes_attack_hints` |
| `profile_for(strategy) -> StrategyProfile` | the registered profile, or `PolicyError` when none is |
| `registered_strategies() -> frozenset[Strategy]` | the strategies with a profile registered |
| `RunnerTraits` | what one runner variant takes from a plan: `consumes`, `honors_examples_per_endpoint`, `examples_cap`, `judges_opt_in_oracles` |
| `PlanPhases` | `ALL`: the `consumes` of a runner that takes every phase the strategy plans |
| `runner_traits()` | the `RunnerTraits` of every variant of every registered runner, keyed by `(mode, variant)` |
| `runner_traits_for(mode, options) -> RunnerTraits` | the traits of the variant a run in that mode, with those options resolved, takes |

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
| `FindingObserved` | `finding`: the confirmed `report`, read as `endpoint_id`, `status_code`, `invariant`, `phase` |
| `InfraFailure` | `infra_failure`: `endpoint_id`, `reason`, `streak`, `limit` |
| `TargetDown` | `target_down`: `base_url`, `verdict` (`TargetDownVerdict`) |
| `RunTruncated` | `truncated`: `endpoint_id`, `reason` |
| `RunFinished` | `finished`: the terminal `status` |
| `TargetDownVerdict` | how a run decided the target is down: `LIVENESS_PROBE_FAILED` / `CIRCUIT_BREAKERS_OPEN` |

## Enums (only those a consumer touches)

| Name | One line |
|---|---|
| `ExecutionMode` | `STATELESS` / `STATEFUL` / `REPLAY` / `PERFORMANCE` / `RESILIENCE` / `AUTH` |
| `RunStatus` | a run's terminal outcome: `COMPLETED` / `TRUNCATED` / `ABORTED` / `CANCELLED` |
| `FindingState` | a finding's settled state: `CONFIRMED` / `FLAKY` / `UNVERIFIED` / `REFUTED` |
| `ErrorCategory` | the outcome category of one request |
| `TruncationReason` | why a run, or one endpoint, was cut short (includes `TARGET_DOWN`, `INFRASTRUCTURE_ABORT`, `CANCELLED`, and `ENGINE_FAILURE` for an endpoint the engine itself failed on and isolated) |
| `InvariantViolation` | the invariant a finding broke (includes `INPUT_VALIDATION`: a 2xx accepted the poisoned field outside its declared schema; and the security invariants `INFORMATION_DISCLOSURE`, `SENSITIVE_DATA_EXPOSURE`, `REFLECTED_PAYLOAD`, `MASS_ASSIGNMENT`, `INPUT_INDUCED_TIMEOUT`; and the opt-in `UNDECLARED_RESPONSE_FIELD`) |
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
| `public_base_url(config) -> str` | the run's base URL with any `user:pass@` stripped, for anything shown to a user |
| `validate_replayable(trace, config) -> ReplayReadiness` | whether a trace can be replayed under this config |

## Logging, media types and spec seeds

| Name | One line |
|---|---|
| `ENGINE_LOGGER_NAME` | `"specforge_engine"`, the stdlib logger every engine record goes to — an isolated endpoint's traceback among them. The library adds no handler; the embedding process routes it |
| `is_json_media_type(media_type) -> bool` | whether a media type is JSON: its essence (lowercased, parameters dropped) is `application/json` or ends in `+json`. The compiler picks the body's wire with it, the transport its encoder, and the core's projection its preferred media type |
| `same_seed(left, right) -> bool` | whether two spec samples are one value: equal and of one type, so `1` is not `True`. How the dialect and the core deduplicate `default` and `examples` |

## Input validation (the policy boundary)

| Name | One line |
|---|---|
| `validate_endpoint_spec(spec, *, strategy)` | the ordered per-endpoint checks — types, allowed fields, ranges, phase split, focus fields, and the owner bundle — the first `PolicyError` wins ([ADR-015](adr/api.md#adr-015)). The range check covers numeric bounds and ISO `date` / `date-time` string bounds, which are parsed and compared chronologically so an inverted or incomparable date range is rejected. The owner-bundle check requires an `owner_only` endpoint's `owner_bundle` to be among the bundles it consumes, naming the consumed bundles otherwise. A `role_only` endpoint has no check here: a role cannot be judged against the compiled endpoint, so its coherence lives in the kernel and its holder check in the auth runner's precondition |
| `validate_property_field_references(semantic_property, *, known_fields)` | raises `PolicyError` when a `SemanticProperty`'s expression references a field outside `known_fields` |

## Domain exceptions

| Name | One line |
|---|---|
| `PolicyError` | boundary validation failed |
| `StrategyCompilationError` | a contract cannot become a strategy |
| `EngineError` | an execution invariant was violated |
| `AccessIdentityError` | the auth runner has no valid declared identity to run against; raised before the first request |
| `AccessUncrossableError` | an auth run had access policies to cross and crossed none of them; `unprobed` maps each such endpoint to its `UnprobedReason`. Not raised for a run cut short. The runner and its modules (`chain.py`, `provisioning.py`, `producer_watch.py`, …) are mapped in [Execution modes](execution-modes.md#auth) |
| `ConcurrencyLadderError` | a performance run's concurrency ladder cannot be honored — a step exceeds `max_concurrency`; raised before the first request |

All descend from `SpecforgeEngineError`, never from `ValueError`
([ADR-001](adr/foundations.md#adr-001)). The full taxonomy, including
`EndpointCompilationError`, `StatefulLinkError` and the control signal
`StopExplorationError` (which carries a pass's `Cut` out of Hypothesis and is
never isolated as an engine failure), is importable from
`specforge_engine.exceptions`.

## Requests

These names are not on the facade. They are the vocabulary of how a request is
shaped and what it carries ([Requests](requests.md)), and the seams the runners'
own tests exercise.

| Name | Module | One line |
|---|---|---|
| `ZoneWire` | `models/wire.py` (also `specforge_engine.models`) | how a zone carries a value: `STRUCTURED` (a JSON body), `TEXT` (query, header, a form or multipart body), `SEGMENT` (path); `zone_wire(zone, media_type)` picks one |
| `TextAlphabet` | `models/wire.py` | the characters a compiled string draws from: `OPEN`, `PRINTABLE`, `WIRE_SENDABLE` |
| `RequestIntent` | `models/runtime/intent.py` (also `specforge_engine.models.runtime`) | frozen `(phase, poisoned, attack_family)`: what a request was drawn to test; `poisoned` is a `FieldAddress` or `None`, and a family needs a poisoned field |
| `ZoneDraw` | `models/runtime/draw.py` | what one zone's strategy draws: `values`, the `poisoned_field` (a `FieldPath`), if any, the `attack_family` of its value, if any, the `observed_fields` taken from the run's corpus, and the `varied_field` drawn outside valid values, the poisoned field by default |
| `BODY_ROOT` | `models/runtime/intent.py` | `"$"`, the field name of a body that is not an object |
| `FieldAddress` | `models/runtime/intent.py` | a frozen `(zone, field)` with a derived `path`: a name is one literal top-level key, `FieldAddress.at(zone, path)` a nested field spelled by its path; equality reads the zone and the spelling |
| `FieldPath` | `models/runtime/field_path.py` | a frozen tuple of segments, a key (`str`) or an index (`int`); the empty path is the body root; `spelled`, `parent`, `leaf`, `child`, `is_prefix_of` ([Field addressing](field-addressing.md#a-fields-path)) |
| `nested_path(spelled, values)` | `models/runtime/field_path.py` | the nested path a spelling names in recorded values, the whole key tried first; `None` for a whole key or no match |
| `PhaseBudget` | `models/runtime/stats.py` | a frozen `(planned, carried_in)`: one phase's planned examples at an endpoint, and those an earlier pass of the same identity left it; `+` adds two, `merge_phase_budgets` sums maps of them |
| `NO_BODY_DRAWN` | `models/runtime/draw.py` | the body zone's values when a draw sends no body; `None` is a drawn value, never sent |
| `CompiledBody` | `models/runtime/engine_input.py` | the compiled body: a `CompiledRequestPart` plus the `media_type` and the `file_fields` (properties declared `format: binary`, sent as file parts) |
| `CompiledRequestPart.poisoning_phases` | `models/runtime/engine_input.py` | the phases whose strategy poisons one of the zone's fields per draw; a subset of the compiled phases |
| `SentEvidence` | `models/runtime/results.py` | `(results, findings)`: what an endpoint had sent and found when its exploration stopped short; `requests_sent` counts the results that reached the wire |
| `kept_cut(current, cut)` | `models/runtime/run_status.py` | folds two cuts: one that halts the run outranks any recorded first, otherwise the first recorded stands |
| `BODY_ENCODERS` | `runtime/http/body_encoders.py` | the closed table of body encoders by media type essence: JSON, form-urlencoded, multipart |
| `reserved_for(config_headers, identity)` | `runtime/http/reserved_headers.py` | the lowercased header names the credentials and the transport own |
| `guard_endpoint(endpoint_id, work, *, evidence)` | `runtime/bulkhead.py` | runs one endpoint's work, turning any exception but a control signal into an `EngineFailure` with an `engine_failure` cut |

## Strategy compiler

These names are not on the facade — they live under
`specforge_engine.strategy_compiler` and its `fields` subpackage. They are
the surface an extension registers against and the seams the compiler's own
tests exercise, documented for that reason
([Strategy compiler](strategy-compiler.md), [Extension guide](extension-guide.md)).

### `strategy_compiler`

| Name | One line |
|---|---|
| `compile(compiler_input) -> CompilationOutcome` | the whole compile; the facade re-exports it as `compile_strategies` |
| `build_generation_plan(endpoint, profile) -> GenerationPlan` | the per-endpoint example budget: totals (the budget's `max_examples`, else the profile's `default_max_examples`), phase split (with any applicable phase extension's share reserved), combination limits |
| `estimate_parameter_space(parameters) -> int` | the estimated combination count for a parameter map, capped at 10⁹ |
| `effective_phases(endpoint, base_phases) -> tuple[Phase, ...]` (`effective_phases.py`) | the profile's phases plus every phase extension the endpoint activates |
| `effective_split(endpoint, base_split) -> Mapping[Phase, float]` (`effective_phases.py`) | a phase split with each activated extension's share reserved; unchanged when none applies |
| `compile_zone(zone, params, ctx) -> CompiledRequestPart` | one zone's per-phase strategies plus its documentation schema (`zone.py`) |
| `build_zone_schema(params, *, force_required) -> dict` | the zone's parameters as a JSON Schema object |
| `ZoneCompileContext` | endpoint-wide knobs constant across an endpoint's zones: the `phases`, a `FieldKnobs`, and the body's media type; `wire_for(zone)` and `slot_for(phase, zone)` |
| `compile_body(spec, ctx) -> CompiledBody` | the body's per-phase strategies: its object fields as a zone, or its root as the field `$`; an optional body is left out of some valid draws (`body.py`) |
| `build_body_schema(spec) -> dict` | the body's documentation schema: its fields as an object, or its root as declared |
| `compile_parameter(name, contract, zone, slot)` | one parameter compiled for the slot's phase under its zone's alphabet and wire (`parameter.py`) |
| `poison_parameter(field, contract, zone, slot)` | the phase's `PoisonCandidate`s for the field at a `FieldPath` in the slot's phase, filtered to what its zone can send, or `None` when the phase has no candidate for it or focus keeps it out |
| `ParameterSlot`, `FieldKnobs` | the phase, wire and knobs a parameter compiles in; the endpoint-wide generation context, focus and sensitive fields |

### `strategy_compiler.fields`

| Name | One line |
|---|---|
| `compile_contract(contract, phase, *, context)` | resolve and build the strategy for a `(contract type, phase)` |
| `register_phase(phase)` | register a `GenerationPhase` under `(contract_type, name)` |
| `registered_phases()` | the keys currently in the phase table |
| `resolve_phase(contract, phase)` | the phase registered for a contract's type or its nearest ancestor |
| `isolated()` | a context manager giving the block its own phase registry, restored on exit |
| `GenerationPhase` | one `(name, contract_type, build, candidates, zone_variants, root_variant)` mapping with three trait flags, `leaves_replace_whole`, `plain_fallback` and `spares_reserved_headers` ([Extension guide](extension-guide.md#a-phase-that-poisons-one-field)); a non-callable `build`, `candidates` or variant source is rejected |
| `PoisonCandidate` | frozen `(value, attack_family, poisons)`: a value a field could be poisoned with, its family, if any, and whether it breaks the field's contract (`True` by default) or only varies it |
| `CandidateSource` | the Protocol of a phase's `candidates`: `(contract, *, context) -> SearchStrategy[PoisonCandidate] \| None` |
| `untagged(source)` | a value source adapted to a `CandidateSource` whose candidates carry no family |
| `ZoneVariantSource` | the Protocol of a whole-zone branch: `(ZoneVariantRequest) -> SearchStrategy[ZoneDraw] \| None`; the request carries `params`, `valid`, `always_sent`, `context`, `focus_fields` and `admits_extra_keys` |
| `RootVariantSource` | the Protocol of a branch beside a body drawn whole: `(RootVariantRequest) -> SearchStrategy[ZoneDraw] \| None`; the request carries the `root` contract, `context` and `focus_fields` |
| `root_variants_for(phase, contract_types)` | the distinct root-variant sources the phase resolves for the types |
| `candidates_for(phase, contract_type)` | the candidates of the phase resolved for a contract type, or `None` when it does not poison |
| `poisoning_phases(phases, contract_types)` | the phases that carry candidates for at least one of the types |
| `poisoning_strategy(contract, phase, *, context)` | the phase's candidates for the field, or `None` when the phase cannot poison it |
| `zone_variants_for(phase, zone, contract_types)` | the distinct zone-variant sources the phase resolves for the types on that zone |
| `GenerationContext` | endpoint-wide generation knobs a builder may read, the strategy's `attack_families` among them (`allows(family)`) |
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
| `numeric_minimum` · `numeric_maximum` · `string_minimum` · `string_maximum` | the bounds narrowed to a number or to a date string |
| `format` | the raw format string or `None` |
| `known_format` | the `SchemaFormat` for a recognized string format, else `None` |
| `numeric_format` | the `NumericFormat` (`int32`, `int64`, `float`, `double`) for a recognized numeric format, else `None` |
| `seeds` | the spec's `default` then its `examples`, each value once |
| `pattern` | the regex pattern or `None` |
| `property_count` | the object's declared property count |
| `json_schema` | the one raw `model_dump` — the zone schema and the jsonschema fallback |

### `strategy_compiler.fields.attack`

| Name | One line |
|---|---|
| `base_attack_candidates(contract, *, context)` | the attack candidates of a field no contract names profiles for: its type's default profiles, the default toggles |
| `build_base_attack(contract, *, context)` | the base candidates' values, or the valid strategy when none fits |
| `fitting_candidates(contract, candidates, *, context)` | the candidates, deduplicated first-seen, that fit the field's declared shape, or `None` |
| `tagged_base_payloads(value_type, request)` | the profile pools first, each spelling tagged with its profile, then the type's base payloads and toggle families |
| `sample_attack_payloads(payloads)` | the sampled-from strategy over deduplicated payloads, or `st.none()` when empty |
| `mass_assignment_variant(request)` | the body zone variant: the valid body plus one undeclared privileged key, at its top or inside one of its objects, from a `ZoneVariantRequest` |
| `mass_assignment_root_variant(request)` | the same for a body sent as an array, into the objects of its elements, from a `RootVariantRequest` |
| `AttackRequest` | everything a base-payload builder or toggle family needs for a field |
| `AttackToggles` | the eight payload-variant flags, pinned to the contract by a guard test; `AttackToggles.from_contract(contract)` reads an attack contract's, and `DEFAULT_ATTACK_TOGGLES` (`attack/request.py`) is the untuned set |
| `allowed_profiles(context, *sources)` · `allowed_candidates(candidates, context)` | the families, or the candidates, whose attack family the context allows |

### `strategy_compiler.fields.mutation`

| Name | One line |
|---|---|
| `build_mutation(contract, toggles, *, context)` | the mutation-phase strategy: a non-null valid seed with one operator the toggles enable applied, or the valid strategy when none applies |
| `build_base_mutation(contract, *, context)` | the mutation phase of a field no contract tunes, with `DEFAULT_ATTACK_TOGGLES` |
| `mutation_candidates(contract, toggles, *, context)` · `base_mutation_candidates(contract, *, context)` | one operator on a valid seed, as a `PoisonCandidate` whose `poisons` says whether the mutated value, as it travels, provably breaks the contract |
| `resolve_mutation_depth(context)` | the context's `mutation_depth`, or `DEFAULT_MUTATION_DEPTH` |
| `mutation_operators(value_type, toggles)` | the gate-enabled mutation operators for a schema type |
| `MutationOperator` | a frozen `(name, gate, apply)` mutation transform |
| `mutate_object(obj, depth)` | layered object mutation for prototype-pollution and overflow probing |

### `strategy_compiler.fields.security`

| Name | One line |
|---|---|
| `hacker_attack_candidates(contract, *, context)` | the attack candidates of the contract's declared families and toggles that the context allows and that fit the field's shape |
| `build_hacker_attack(contract, *, context)` | the sampled attack payloads of an attack contract, as bare values |
| `build_hacker_mutation(contract, *, context)` | `build_mutation` with the toggles the contract declares (`AttackToggles.from_contract`) |
| `hacker_mutation_candidates(contract, *, context)` | `mutation_candidates` with the toggles the contract declares |

### `shared`

Stage-neutral helpers, importable from `specforge_engine.shared`. Its
`phase_extensions` module is the registry of phase extensions — an extra generation phase that
activates, funds itself and refines its payloads only on the endpoints it applies
to ([Extension guide](extension-guide.md#add-a-phase-extension)).

| Name | One line |
|---|---|
| `PhaseExtension` | a frozen `(phase, applies, share, refiner)`; a non-callable `applies`/`refiner` raises `TypeError`, a `share` outside `(0, 1)` raises `ValueError` |
| `register_phase_extension(extension)` | register an extension under its own phase, replacing any previous one |
| `registered_phase_extensions()` | the extensions currently registered, in registration order |
| `phase_extension_for(phase)` | the extension registered for a phase, or `None` when it is not an extension phase |
| `isolated()` | a context manager giving the block its own extension registry, restored on exit (`shared.phase_extensions`; not re-exported by `shared`) |
| `is_field_addressed(zone, field, entries) -> bool` | whether an entry of an attack addressing list names the field (a `FieldPath`) or a field holding it, bare or by zone and dotted path |
| `leads_to_addressed_field(zone, field, entries) -> bool` | whether the field is addressed or holds a field an entry names |
| `addresses_declared_field(entry, zone, name, contract) -> bool` | whether an entry names the top-level field or a property or element its contract declares; the policy check of `focus_fields` |
| `value_at(values, path)` · `with_value_at(values, path, value)` | the value at a `FieldPath`, or `ABSENT`; a copy with it set, or removed for `ABSENT` |
| `first_provable_violation(value, contract)` | the first place a value, or `ABSENT`, provably breaks its contract, or `None`; what cannot be decided never violates ([Proving a violation](provable-violation.md)) |
| `DECIDABLE_FORMATS` | the formats whose checker's rejection proves a violation |
| `carried_value(drawn, contract, reading)` · `carried_violation(drawn, contract)` | a `DrawnField` as a server reads it under a `TextReading` (`STRICT`, `LENIENT`, `AS_SENT`), or `ABSENT`, or `UNREADABLE`; where it provably breaks its contract, read leniently |
| `is_omitted_field(value, wire)` | whether a field is left out of the request: a query, header or form field drawn `None` |
| `holder_admits_extra_keys(holder)` | whether an object admits undeclared keys, for the mass-assignment generator and oracle alike |
| `validate_value(value, contract) -> bool` | whether a value fits a strategy contract's type, length, `enum` and range; read by the oracles and by the attack shape filter (`schema_check.py`) |
| `meets_declared_shape(value, contract) -> bool` | whether a value provably meets, at any depth, what `validate_value` leaves out: `pattern` (read as ECMA-262; an undecidable one is never met), `format` (with the 2020-12 checker; a format the checker cannot evaluate is never met; `password` and `binary` restrict nothing), `uniqueItems`, `minProperties`, `maxProperties`; read by the contract-completeness oracle (`schema_check.py`) |
| `is_sensitive_field_name(name) -> bool` | whether a field name holds a credential or a secret, by one normalized form; read by the redaction and the sensitive-data oracle (`sensitive_names.py`) |
| `has_input_constraint(endpoint) -> bool` | whether the endpoint declares at least one input-constraint semantic property |
| `input_constraints(properties) -> tuple[SemanticProperty, ...]` | the properties classed as input constraints, in declaration order |
| `register_builtin_phase_extensions()` | the composition root (`phase_extension_builtins.py`, at the package root) that registers the built-in `semantic` extension; the package `__init__` calls it once |

## Suffix conventions

A type's suffix names the role it plays at the boundary
([ADR-003](adr/foundations.md#adr-003)):

- `*Contract` — input filled by the producer or the LLM.
- `*Options` — per-mode knobs passed to `run(options=...)`.
- `*Config` — global runtime (`ExecutionConfig`).
- `*Outcome`, `*Readiness` — a return with alternatives (a Result object).
- `*Result` — the aggregate output DTO (`EngineRunResult`).
- `*Report`, `*Stats`, `*Trace` — output components; persisted, never renamed.
