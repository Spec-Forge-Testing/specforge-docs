# The strategy compiler

`strategy_compiler/` turns validated per-parameter contracts into Hypothesis
`SearchStrategy`s. It does no HTTP and no re-validation — that already happened
in `policy/`. Its subpackage `fields/` translates a *field* (the schema
description of one parameter) into a strategy.

## The compile, top to bottom

`compile(compiler_input)` walks the input's endpoints and returns a
`CompilationOutcome`: the `EngineInput` of everything it compiled plus one
`EndpointExclusion` per endpoint it rejected — a Result object, not a bare
tuple. A per-endpoint rejection is reified into an exclusion and the compile
continues; one bad endpoint never fails the whole input.

Each endpoint is compiled in this order:

1. **Path-template check.** `_require_path_params_satisfy_template` parses the
   `path_url` placeholders and rejects any the endpoint will not supply at
   request time. The supplied set is the path-zone parameter names plus the
   path fields a state link consumes. A placeholder nobody fills, or a template
   that will not parse, is a `StrategyCompilationError`.
2. **Generation context.** `_build_generation_context` reads the endpoint's
   attack knobs and risk into a `GenerationContext` (below). An endpoint with
   neither attack nor a risk-derived profile gets the shared `EMPTY_CONTEXT`.
3. **`ZoneCompileContext`.** The endpoint-wide knobs constant across its zones —
   the profile's `phases`, the generation context, and the attack focus and
   sensitive field lists — are packed once. It does not carry the `Zone`; that
   varies per zone and is a `compile_zone` argument
   ([ADR-029](adr/compiler.md#adr-029)).
4. **One `compile_zone` per non-empty zone.** `by_zone()` yields each declared
   zone's parameter map; each becomes a `CompiledRequestPart`.
5. **`build_generation_plan`.** The endpoint's budget, risk and aggressiveness
   become a concrete `GenerationPlan`.

The compiled parts and the plan become a `CompiledEndpointStrategies`, wrapped
with the endpoint's risk, attack, budget, responses and state link into a
`CompiledExecutionEndpoint`.

### Where a rejection becomes an exclusion, and where it does not

`_reporting_endpoint_identity` catches a `StrategyCompilationError` raised
while compiling one endpoint, attaches the endpoint's identity, and re-raises it
as an `EndpointCompilationError` — which `compile` turns into an
`EndpointExclusion`. A `PolicyError` is **not** caught: the one the planner
raises for a foreign phase split (below) propagates out of `compile`
unchanged, because it means the input itself is malformed for the mode, not
that this one endpoint is uncompilable ([ADR-031](adr/compiler.md#adr-031)).

## Which contracts and phases apply: the profile

What a compile generates is decided by a `StrategyModeProfile`, resolved from
the `profiles/` registry by the `StrategyMode` on `CompilerInput`.
`strategy_mode` is global on the input, never per-endpoint. A profile is a
frozen value object with five fields:

| Field | Meaning |
|---|---|
| `mode` | the `StrategyMode` it describes |
| `phase_split` | `Mapping[Phase, float]`: the phases to compile and the fraction of the budget each gets; `phases` lists them in allocation order |
| `allowed_fields_by_type` | the allowed-field matrix the policy layer checks against |
| `contract_type` | the `BaseStrategyContract` subclass this mode requires |
| `allow_contract_subclasses` | whether `accepts(contract)` uses `isinstance` (`True`) or an exact type match (`False`) |

`profile_for(mode)` returns the profile for a `StrategyMode` and raises
`PolicyError` when none is registered.

| Profile | Contract type | Phase split | Subclasses |
|---|---|---|---|
| `DEFAULT` | `BaseStrategyContract` | `valid` 0.60 · `boundary` 0.25 · `invalid` 0.15 | exact type only |
| `HACKER` | `HackerStrategyContract` | `valid` 0.60 · `boundary` 0.25 · `invalid` 0.10 · `attack` 0.05 | accepted |

Adding a profile is one registration call — see the
[Extension guide](extension-guide.md#add-a-profile).

## `GenerationContext`: the endpoint's knobs

Every compile threads a `GenerationContext` alongside the contract. It is a
frozen value object a phase builder *may* read, always present so a builder
never guards for `None` ([ADR-024](adr/compiler.md#adr-024)):

| Field | Holds |
|---|---|
| `mutation_depth` | how deep object mutation recurses (hacker) |
| `aggressiveness` | the attack-vs-benign mix weight (hacker) |
| `extra_profiles` | attack profiles the endpoint's risk earns, added to the field's own |

`EMPTY_CONTEXT` is the shared instance for an endpoint with no attack knobs and
no risk-derived profiles.

The risk-to-profile mapping is a table. An endpoint's data sensitivity earns a
profile for every hacker field, and an auth-surface endpoint earns
`AUTH_BYPASS` on top, order-preserving and de-duplicated:

| `Sensitivity` | Profile earned |
|---|---|
| `PII` | `INFORMATION_DISCLOSURE` |
| `FINANCIAL` | `INFORMATION_DISCLOSURE` |
| `AUTH` | `AUTH_BYPASS` |
| *auth surface* (any) | `AUTH_BYPASS` |

## `SchemaView`: the typed reader

The compiler reads a contract's schema through `SchemaView`, a frozen typed
accessor over the contract, instead of picking a dictionary apart by string
keys ([ADR-023](adr/compiler.md#adr-023)). Each JSON Schema constraint is a
property — `value_type`, `enum`, `minimum`, `min_length`, `known_format`,
`property_count`, and so on — returning the closed enums `SchemaType` and
`SchemaFormat`, never a literal. `known_format` returns a `SchemaFormat` only
for a wire spelling the enum recognizes, and `None` otherwise.

One property is the exception: `json_schema` is the single raw
`model_dump(by_alias=True, exclude_none=True)`. It is used in exactly two
places — the zone's documentation schema (`build_zone_schema`) and the
`hypothesis-jsonschema` fallback for constructs the compiler does not build
directly (`anyOf`, `oneOf`, `allOf`, `$ref`).

## The phase registry

A **phase** (`Phase`: `valid` / `boundary` / `invalid` / `attack` /
`transition`) is a family of values a field can generate. Phases form a
registry keyed by `(contract_type, Phase)`. `resolve_phase` walks the
contract's MRO, so a `HackerStrategyContract` — a subclass of
`BaseStrategyContract` — picks up the base phases plus `attack` without a
branch ([ADR-010](adr/models.md#adr-010)).

A `GenerationPhase` binds `name: Phase`, `contract_type` and a `build`
callable. Its `__post_init__` rejects a non-callable `build` with a `TypeError`
at registration, so a mis-registration fails where it is written, not at the
first draw ([ADR-026](adr/compiler.md#adr-026)).

`compile_contract(contract, phase, *, context)` resolves the builder and calls
it. A builder receives the `context` only if its signature accepts it — a
`context` keyword or `**kwargs`, checked once and cached. A builder that does
not care about the endpoint's knobs keeps a one-argument signature.

The built-in phases are registered explicitly by `register_builtin_phases`,
never as a side effect of importing a builder module
([ADR-025](adr/compiler.md#adr-025)):

| Phase | Contract | Builder |
|---|---|---|
| `valid` | base | `build_valid_strategy` |
| `boundary` | base | `build_boundary_strategy` |
| `invalid` | base | `build_invalid_strategy` |
| `attack` | base | `build_valid_strategy` |
| `attack` | hacker | `build_hacker_attack` |

`attack` on the base contract falls back to valid values: a non-hacker contract
in a hacker-mode compile still generates in-spec values for that phase.

Adding a phase is registering a `GenerationPhase` — see the
[Extension guide](extension-guide.md#add-a-phase).

## Dispatch is a table, not a cascade

Every "dispatch on the schema type" is a named table keyed by the enum. The
entries are plain functions; the extension axis is the phase registry, not the
builders ([ADR-016](adr/compiler.md#adr-016)).

| Site | Table |
|---|---|
| `fields/default/valid.py` | `SchemaType → valid builder` |
| `fields/default/boundary.py` | `SchemaType → boundary builder` |
| `fields/default/invalid.py` | `SchemaType → invalid builder` |
| `fields/default/constraints.py` | `SchemaFormat → regex pattern`; the date-range builders `DATE_RANGE_STRATEGIES` |
| `fields/hacker/payloads.py` | `SchemaType → base-payload builder`; the toggle-family table |

Two overrides ride on top of the type dispatch. The boundary phase shrinks any
array to a size-0..1 envelope through `_ARRAY_SIZE_OVERRIDE` instead of
honouring the declared bounds. A string with a chronologically-sortable
`format` (`date`, `date-time`) and a declared bound goes to a range-aware date
builder rather than the format's regex.

### Constant tables

| Constant | Value | Used by |
|---|---|---|
| `INVALID_TEXT_MAX_SIZE` | 10 | wrong-type text in the invalid phase |
| `INVALID_NUMERIC_TEXT_MAX_SIZE` | 20 | non-numeric text for a numeric field |
| `OVER_MAX_MARGIN` | 10 | an over-length string past `maxLength` |
| `LARGE_VALUE_STRING_SIZES` | 100 000 · 1 000 000 | large-value string payloads |
| `LARGE_ARRAY_SIZE` · `SMALL_ARRAY_SIZE` | 1000 · 10 | attack array lengths |
| `MUTATION_OVERFLOW_FIELD_SIZE` | 4096 | the overflow field in a mutated object |
| `DEFAULT_MUTATION_DEPTH` | 1 | mutation depth when no context sets it |

## The hacker side

`build_hacker_attack` is the `attack` builder for a `HackerStrategyContract`.
It reads the contract through a `SchemaView`, defaulting a typeless field to
`string` in the caller so the base-payload table never keys on `None`
([ADR-028](adr/compiler.md#adr-028)), and assembles an `AttackRequest` — the
one value object a base-payload builder or toggle family needs for a field:

| `AttackRequest` field | From |
|---|---|
| `profiles` | the contract's own `attack_profiles` plus the context's `extra_profiles`, deduplicated |
| `toggles` | the `AttackToggles` read off the contract |
| `minimum` · `maximum` | the field's numeric bounds |
| `mutation_depth` | the context's, or `DEFAULT_MUTATION_DEPTH` |

### `AttackToggles`: eight explicit flags

`AttackToggles` names the eight payload-variant flags a hacker contract may
declare: `include_encoded_variants`, `include_nulls`, `include_large_values`,
`include_extra_fields`, `include_empty_values`, `include_unicode_variants`,
`include_control_chars`, `include_nested_objects`. They are explicit fields,
not generated from the contract. A guard test pins the set to the contract's
`include_*` flags (minus `include_duplicate_fields`, which no builder consumes),
so adding a flag to the contract without adding it here fails that test
([ADR-027](adr/compiler.md#adr-027)).

### Base payloads and toggle families

`build_base_payloads` looks up the type's base builder, then extends it with
every toggle family whose flag is set. The base builders:

| Type | Base payloads |
|---|---|
| `string` | the profile pools (or a generic pool when no profile), extended by nulls and large values per toggle |
| `integer` · `number` | attack and boundary edge values, plus `None` when `include_nulls` |
| `boolean` | the type-confusion pool (`True`, `False`, `None`, `0`, `1`, `"true"`, …) |
| `array` | `[None]`, a long `[None]*size`, an injection-probe element |
| `object` | `{}` and prototype-pollution shapes, plus `None` when `include_nulls` |
| *unrecognised* | a shared generic fallback pool, deep-copied per draw |

The toggle-family table adds fixed pools keyed by `(toggle, SchemaType)`:

| Toggle | Type | Adds |
|---|---|---|
| `include_empty_values` | string / array | the empty string / the empty list |
| `include_unicode_variants` | string | emoji, non-Latin scripts, zero-width and case-folding edges |
| `include_control_chars` | string | SOH, BEL, ESC, DEL, FF |
| `include_nested_objects` | object / array | nested-object / nested-array shapes |

`include_extra_fields` on an object appends a mutated object built to the
request's `mutation_depth`. `mutate_object` layers prototype-pollution keys
(`__proto__`, `constructor`), a null field, and a 4096-character overflow field,
recursing into nested dicts down to the depth.

### Dedupe, then mix

`build_attack_payloads` deduplicates in first-seen order before sampling:
scalars key by `(type, value)` so `True` and `1` stay distinct, everything else
keys by identity. The result is an `st.sampled_from`, or `st.none()` when empty.

`_mix_with_benign` weights attack against benign values by aggressiveness. With
no aggressiveness the strategy is pure attack. Otherwise a roll in
`1..MAX_AGGRESSIVENESS` draws an attack value when it lands at or under the
aggressiveness, and a valid value otherwise — a `flatmap`, because `st.one_of`
would dedupe the two branches by identity and could not weight them.

`hacker/` may import `default/`; never the reverse.

## Attack focus and sensitive fields

Two per-parameter rules narrow the attack phase, both spoken in the same
addressing vocabulary. `is_field_addressed(zone, name, entries)` matches a bare
field name, or a zone-qualified `zone.name`:

- **Focus.** When an endpoint declares `focus_fields`, a parameter the list
  does not address is compiled in the `valid` phase instead of `attack`. The
  attack effort concentrates on the named fields.
- **Sensitivity.** A parameter the `sensitive_fields` list addresses has
  `INFORMATION_DISCLOSURE` and `AUTH_BYPASS` added to its context profiles, so
  its attack payloads bias toward disclosure and auth-bypass pools.

## The plan arithmetic

`build_generation_plan` produces a `GenerationPlan` directly — a frozen value
object, built in one place, never mutated afterwards
([ADR-030](adr/compiler.md#adr-030)):

- `max_examples` is the budget's, scaled by the endpoint's risk score through
  `weight_by_risk`.
- `phase_split` is the budget's own split when it declares one, otherwise the
  profile's — grown on the `attack` share by aggressiveness through
  `derive_attack_split` when the mode has an attack phase. A budget that
  declares a phase outside the mode's split is a `PolicyError`, raised by the
  planner and propagated out of `compile`.
- `estimated_combinations` is `estimate_parameter_space` over every zone's
  parameters, capped at `COMBINATION_SPACE_CAP` (10⁹).
- `allowed_combinations` clamps the estimate into `1..max_combinations_per_case`.
- `examples_per_phase` is `allocate_examples(max_examples, phase_split)`.

`estimate_parameter_space` multiplies a per-parameter choice count. The count
is the enum length when the field is an enum, otherwise a table by type:

| Type | Choices |
|---|---|
| `boolean` | 2 |
| `integer` · `number` | 4 |
| `string` | 4 |
| `array` | 3 |
| `null` | 1 |
| `object` | `property_count + 1`, clamped to 2..6 |
| *typeless* | 3 |

## Budget arithmetic

`budget/` is the single home of example-budget arithmetic; the compiler's
planning calls it, and nothing else computes a share.

| Function | What it does |
|---|---|
| `allocate_examples(max_examples, split)` | splits a budget across phases by largest remainder, ties broken by phase name; the result always sums to the budget |
| `derive_attack_split(base_split, aggressiveness)` | grows the `attack` share by 0.05 per aggressiveness point (capped at `MAX_AGGRESSIVENESS` points) and rescales the other phases to fit |
| `weight_by_risk(max_examples, risk_score)` | scales the budget by `EndpointRisk.risk_score`: ×0.75 at 0, neutral at 50, ×1.25 at 100, never below 1; `None` leaves it unchanged |
| `share_budget(total, identities)` | splits a budget evenly across the declared identities into `BudgetShare`s (the remainder goes to the first ones); with no identities, one anonymous share takes it all; an identity the budget cannot reach gets no share |

## Exact arithmetic

`numeric.is_multiple_of` is the one predicate the compiler and the schema
oracle share. It compares in rational arithmetic (`Fraction`), because a
binary-float `%` is unreliable for `multipleOf` on decimals, and returns
`False` for a non-finite value.
