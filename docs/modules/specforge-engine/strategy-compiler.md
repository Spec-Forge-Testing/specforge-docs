# The strategy compiler

`strategy_compiler/` turns validated per-parameter contracts into Hypothesis
`SearchStrategy`s. It does no HTTP and no re-validation — that already happened
in `policy/`. Its subpackage `fields/` translates a *field* (the schema
description of one parameter) into a strategy; `parameter.py`, `zone.py` and
`body.py` assemble the fields of a zone into the strategy that draws it. How a
zone's draw becomes a request, and which field a draw poisons, is on
[Requests](requests.md).

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
   the profile's `phases` and a `FieldKnobs` (the generation context, and the
   attack focus and sensitive field lists) — are packed once. It does not carry
   the `Zone`; that varies per zone and is a `compile_zone` argument
   ([ADR-029](adr/compiler.md#adr-029)). `wire_for(zone)` gives the zone's
   `ZoneWire`, and `slot_for(phase, zone)` the `ParameterSlot` a parameter is
   compiled in: the phase, the wire and the knobs.
4. **One `compile_zone` per non-empty parameter zone.** `parameter_zones()`
   yields the path, query and header maps; each becomes a `CompiledRequestPart`.
5. **`compile_body` for the body.** A `BodySpec` becomes a `CompiledBody`: its
   object fields compiled as a zone, or its root as the single field `$`, with the
   body's media type deciding its wire ([Requests](requests.md#the-body)).
6. **`build_generation_plan`.** The endpoint's budget, risk and aggressiveness
   become a concrete `GenerationPlan`.

The compiled parts and the plan become a `CompiledEndpointStrategies`, with the
`poisoning_phases` the mode's contract type poisons, wrapped with the endpoint's
risk, attack, budget, responses and state link into a
`CompiledExecutionEndpoint`.

### One parameter, one zone

`compile_parameter(name, contract, zone, slot)` compiles one parameter for the
slot's phase: it applies the attack focus (a field the focus list does not
address compiles `valid` under `attack`), the sensitive-field profiles, and the
alphabet and wire of its zone, then drops the values a path segment cannot carry.
`poison_parameter` compiles the same parameter to poison it, or returns `None`
when the phase has no candidate for it.

`compile_zone` builds every phase of the zone:

- a **plain phase** is a fixed dictionary over every parameter. In `valid` the
  required parameters are always present and each optional one is optional (every
  path segment is always present); every other plain phase sends every parameter;
- a **poisoning phase** is a `one_of` of variants, one per parameter the phase
  can poison: that parameter from `poison_parameter`, every other one valid. A zone
  with no poisonable parameter has no strategy for the phase.

Every strategy draws a `ZoneDraw(values, poisoned_field)`. `compiled_part` keeps
the phases that compiled and records which of them poison in
`CompiledRequestPart.poisoning_phases`; a part that names a poisoning phase it did
not compile is a `StrategyCompilationError`. `build_zone_schema` is the zone's
documentation schema; a path zone marks every parameter required.

### Where a rejection becomes an exclusion, and where it does not

`_reporting_endpoint_identity` catches a `StrategyCompilationError` raised
while compiling one endpoint, attaches the endpoint's identity, and re-raises it
as an `EndpointCompilationError` — which `compile` turns into an
`EndpointExclusion`. A `PolicyError` is **not** caught, and the compiler raises
none of its own: a foreign phase split (below) is rejected earlier, at the policy
boundary, by `validate_endpoint_spec`, because it means the input itself is
malformed for the mode, not that this one endpoint is uncompilable
([ADR-031](adr/compiler.md#adr-031)).

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
| `HACKER` | `HackerStrategyContract` | `valid` 0.40 · `boundary` 0.20 · `invalid` 0.10 · `attack` 0.25 · `mutation` 0.05 | accepted |

Both splits, and the default budget of 200 examples, are measured: a grid of
budgets and candidate splits on two targets, judged by a decision rule written
before the first run ([ADR-140](adr/measurement.md#adr-140),
[ADR-141](adr/measurement.md#adr-141)). The `HACKER` attack share applies when the
endpoint declares no aggressiveness; with one, `derive_attack_split` sets it.

Adding a profile is one registration call — see the
[Extension guide](extension-guide.md#add-a-profile).

## `GenerationContext`: the endpoint's knobs

Every compile threads a `GenerationContext` alongside the contract. It is a
frozen value object a phase builder *may* read, always present so a builder
never guards for `None` ([ADR-024](adr/compiler.md#adr-024)):

| Field | Holds |
|---|---|
| `mutation_depth` | how deep object mutation recurses (hacker) |
| `extra_profiles` | attack profiles the endpoint's risk earns, added to the field's own |
| `text_alphabet` | the `TextAlphabet` a compiled string draws from — `OPEN`, `PRINTABLE` or `WIRE_SENDABLE` — set per zone and phase by `compile_parameter` |
| `zone_wire` | the `ZoneWire` of the destination zone — `STRUCTURED`, `TEXT` or `SEGMENT` — which decides what the invalid phase can tell apart |

`EMPTY_CONTEXT` is the shared instance for an endpoint with no attack knobs and
no risk-derived profiles. The context carries no aggressiveness: the planner is
its only reader, and it sets the size of the `attack` pass, not what a field
draws in it ([ADR-129](adr/compiler.md#adr-129)).

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
`property_count`, and so on — returning the closed enums `SchemaType`,
`SchemaFormat` and `NumericFormat`, never a literal. `known_format` returns a
`SchemaFormat` only for a string format the enum recognizes, and `numeric_format`
a `NumericFormat` (`int32`, `int64`, `float`, `double`) only for a numeric one;
each returns `None` otherwise. `seeds` is the spec's `default` and then its
`examples`, each value once ([Seeds](#seeds-from-the-spec)).

One property is the exception: `json_schema` is the single raw
`model_dump(by_alias=True, exclude_none=True)`. It is used in exactly two
places — the zone's documentation schema (`build_zone_schema`) and the
`hypothesis-jsonschema` fallback for constructs the compiler does not build
directly (`anyOf`, `oneOf`, `allOf`, `$ref`).

## The phase registry

A **phase** (`Phase`: `valid` / `boundary` / `invalid` / `attack` /
`transition` / `mutation` / `semantic`) is a family of values a field can
generate. Phases form a registry keyed by `(contract_type, Phase)`.
`resolve_phase` walks the
contract's MRO, so a `HackerStrategyContract` — a subclass of
`BaseStrategyContract` — picks up the base phases plus `attack` and `mutation`
without a branch ([ADR-010](adr/models.md#adr-010)).

A `GenerationPhase` binds `name: Phase`, `contract_type`, a `build` callable
and, for a phase that poisons, its `candidates` and, optionally, its
`zone_variants`. Its `__post_init__` rejects a non-callable `build`, `candidates`
or zone variant with a `TypeError` at registration, so a mis-registration fails
where it is written, not at the first draw ([ADR-026](adr/compiler.md#adr-026)).

**A phase with candidates poisons, and its candidate is the poison.**
`candidates` is a `CandidateSource`: given a contract and its context, a strategy
of `PoisonCandidate(value, attack_family)`, or `None` when the field cannot be
poisoned. `poisoning_strategy(contract, phase, context=...)` returns the phase's
candidates, and the zone or body compiler unwraps the drawn candidate into the
field's value and the `ZoneDraw`'s `attack_family`. A phase whose source draws
bare values registers it through `untagged(source)`, which wraps each value as a
candidate of no family. `poisoning_phases(phases, contract_types)` is the subset
of `phases` with candidates for at least one of the types. Both resolve by MRO,
like `build` ([ADR-124](adr/compiler.md#adr-124),
[ADR-126](adr/compiler.md#adr-126)). A phase's `build` still draws bare values:
it is what `compile_parameter` and the recursive builders call.

**A phase may add whole-zone branches.** `zone_variants` maps a `Zone` to a
`ZoneVariantSource`: given the zone's parameters, their valid strategies and the
parameters always sent, a strategy of `ZoneDraw`s, or `None`.
`zone_variants_for(phase, zone, contract_types)` resolves the distinct sources by
MRO, and a poisoning phase adds each one beside its per-field variants. A phase
with variants but no candidates does not poison, so its variants are never drawn
([ADR-134](adr/compiler.md#adr-134)).

`compile_contract(contract, phase, *, context)` resolves the builder and calls
it. A builder receives the `context` only if its signature accepts it — a
`context` keyword or `**kwargs`, checked once and cached. A builder that does
not care about the endpoint's knobs keeps a one-argument signature.

The built-in phases are registered explicitly by `register_builtin_phases`,
never as a side effect of importing a builder module
([ADR-025](adr/compiler.md#adr-025)):

| Phase | Contract | Builder | Candidates | Zone variants |
|---|---|---|---|---|
| `valid` | base | `build_valid_strategy` | — | — |
| `boundary` | base | `build_boundary_strategy` | `untagged(boundary_candidates)` | — |
| `invalid` | base | `build_invalid_strategy` | `untagged(invalid_candidates)` | — |
| `attack` | base | `build_base_attack` | `base_attack_candidates` | body: `mass_assignment_variant` |
| `attack` | hacker | `build_hacker_attack` | `hacker_attack_candidates` | body: `mass_assignment_variant` |
| `mutation` | base | `build_valid_strategy` | — | — |
| `mutation` | hacker | `build_hacker_mutation` | — | — |
| `semantic` | base | `build_valid_strategy` | — | — |

`attack` poisons on every contract: each attack request attacks one field and
draws every other one valid ([The attack side](#the-attack-side)). `mutation` and
`semantic` on the base contract fall back to valid values: a field draws in-spec
values for those phases. `semantic` needs no
hacker builder at all — its work is not per-field. It compiles a valid value
for each parameter, and the engine refines the whole assembled payload once per
endpoint (see [Engine internals](engine-internals.md#how-a-semantic-property-is-evaluated)).

Adding a phase is registering a `GenerationPhase` — see the
[Extension guide](extension-guide.md#add-a-phase).

## The semantic phase

A phase carried in a profile's `phase_split` compiles for **every** endpoint the
mode runs. Some phases only mean something for an endpoint that carries a
particular datum, and adding them to every split would spend budget where there
is nothing to test and pad every endpoint's report with a phase that could not
find anything. A **phase extension** is the answer: a phase compiled and
funded only for the endpoints it applies to.

`semantic` is the built-in one. It applies to an endpoint that declares at least
one `input_constraint` semantic property — a business rule declared for the
request the API accepts, such as `end > start` or `quantity <= limit`.
An endpoint that declares none is compiled exactly as before: no `semantic`
phase, no change to its split, its output byte-for-byte what it was.

A phase extension is a `PhaseExtension` value object — an activation predicate, a
budget share and a payload refiner declared together — held in a registry at the
package root and populated once from a composition root
([Extension guide](extension-guide.md#add-a-phase-extension)). The built-in one
maps `Phase.SEMANTIC` to a predicate that looks for an `input_constraint` among the
endpoint's semantic properties, with `SEMANTIC_SHARE` (0.10) as its share.

Two pure functions in `strategy_compiler/effective_phases.py` read that registry,
and the compiler wires both so an endpoint is never funded for a phase it does not
compile, or the reverse:

- `effective_phases(endpoint, base_phases)` appends every applicable extension's
  phase to the profile's phases, so the applicable endpoint compiles a `semantic`
  strategy per zone.
- `effective_split(endpoint, base_split)` reserves each applicable extension's
  share out of the resolved split. It builds on `reserve_share`
  (`budget/reservation.py`): the base split is normalized, rescaled by
  `(1 - share)`, and the phase added at exactly its share. Reservation runs over
  whatever split was resolved first — the profile's static split, a custom
  `phase_split` (even one summing below 1, or one without a `valid` row), or the
  aggressiveness-derived hacker split — so the semantic phase always lands at 10%
  of the endpoint's budget and the other phases keep their proportions among the
  remaining 90%. As with any phase, a very small budget can round its share to
  zero.

The predicate itself, `has_input_constraint(endpoint)`, lives in the neutral leaf
`specforge_engine/shared/semantic_properties.py`, imported by the composition root that
registers the extension, so the compiler (which decides the phase exists) and the
engine (which decides how it draws) cannot disagree on which properties constrain
an input.

## Dispatch is a table, not a cascade

Every "dispatch on the schema type" is a named table keyed by the enum. The
entries are plain functions; the extension axis is the phase registry, not the
builders ([ADR-016](adr/compiler.md#adr-016)).

| Site | Table |
|---|---|
| `fields/default/valid.py` | `SchemaType → valid builder` |
| `fields/default/boundary.py` | `SchemaType → boundary builder` |
| `fields/default/invalid.py` | `SchemaType → invalid rule`; `ZoneWire → what the wire tells apart` |
| `constants.py` | `FORMAT_PATTERNS`: `SchemaFormat → regex pattern`; `FLOAT_BOUNDARY`: `NumericFormat → float edges`; `TEXT_ALPHABET_BY_PHASE`: `Phase → Zone → TextAlphabet` |
| `fields/default/formats.py` | the date-range builders `DATE_RANGE_STRATEGIES`, and `regex_strategy` over `FORMAT_PATTERNS` |
| `fields/default/alphabet.py` | `TextAlphabet → character strategy` |
| `fields/attack/payloads.py` | `SchemaType → base-payload builder`; the toggle-family table |
| `fields/attack/tables.py` | `PROFILE_STRING_PAYLOADS`: `AttackFamily → string payload pool` |
| `constants.py` | `DEFAULT_ATTACK_PROFILES_BY_TYPE`: `SchemaType → default attack profiles` |

Two overrides ride on top of the type dispatch. The boundary phase shrinks any
array to a size-0..1 envelope through `_ARRAY_SIZE_OVERRIDE` instead of
honouring the declared bounds. A string with a chronologically-sortable
`format` (`date`, `date-time`) and a declared bound goes to a range-aware date
builder rather than the format's regex.

### Numeric ranges

A numeric field has two ranges ([ADR-113](adr/compiler.md#adr-113)):

| Range | What it is | Read by |
|---|---|---|
| declared (`declared_int_range`, `declared_float_range`) | `minimum`/`maximum` and the exclusive bounds, narrowed by the word of a declared `format` (`NUMERIC_WORD_RANGE`: `int32`, `int64`, `float`), never widened; `None` on a side is unbounded | `boundary`, `invalid` |
| generation (`generation_int_range`, `generation_float_range`) | the declared range inside the word of `UNFORMATTED_INTEGER_FORMAT` (`int64`) for an integer that names no integer format | `valid` |

So a valid integer always fits a 64-bit word, while the boundary and invalid phases
of an unformatted integer still probe past it, and those of an `int32` field probe
`2**31 - 1` and `2**31`. The oracles hold a value to a declared format's word only.

### Numeric boundaries

A numeric field's boundary candidates are the fixed edges (`INT_BOUNDARY`, the
signed word sizes; `FLOAT_BOUNDARY`, finite floats only, since JSON cannot carry
`NaN` or an infinity, keyed by format: `float` probes the single-precision edges,
`double` and an unformatted `number` the double's) plus each declared bound and
the values on either side of it. Each candidate is snapped down and up to the
declared `multipleOf` in exact rational arithmetic (an `integer` keeps only whole
results), and kept only when it falls inside the declared range. An exclusive
bound resolves to the adjacent value: the next integer, or the adjacent
representable float (`math.nextafter`), so it stays excluded at any magnitude and
a narrow range keeps its values. A numeric field with no candidate left is not
poisonable in `boundary`; where the boundary builder still draws it (a field nested in a
boundary object or array), it
falls back to its valid-phase draw, or to an open draw (finite, for `number`) when
no sendable value satisfies the field at all.

The `attack` phase reuses the same tables for `integer` and `number`, finite as
well, and builds them without clipping to the range. A poisoned field keeps only
the candidates that fit its declared shape, range included
([ADR-128](adr/compiler.md#adr-128)), so the oversize probe of a bounded field
stays with `boundary` and `invalid`.

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
| `SEED_SHARE_PERCENT` | 20 | the percent of valid draws taken from the spec's seeds |

## String values and the alphabets

A string is generated to be *sendable* to the zone it is bound for, and in the
valid phase to *look valid* there. `TextAlphabet` has three members, and the
compiler picks one per zone and phase while generating, not after
([ADR-067](adr/compiler.md#adr-067), [ADR-114](adr/compiler.md#adr-114)):

| Zone | `valid` | every other phase |
|---|---|---|
| `header` | `WIRE_SENDABLE` | `WIRE_SENDABLE` |
| `query`, `path` | `PRINTABLE` | `OPEN` |
| `body` | `OPEN` | `OPEN` |

`TEXT_ALPHABET_BY_PHASE` maps `valid` to `VALID_TEXT_ALPHABET`; every other phase
takes `NON_VALID_TEXT_ALPHABET`, and a zone absent from a table draws `OPEN`.
`compile_parameter` sets the alphabet on the `GenerationContext` for the phase the
parameter is compiled in, and the string builders draw their characters through
`characters_for(context)`. In a poisoned request only the poisoned field is
compiled for the poisoning phase, so every other field draws under the valid
alphabet.

- **`OPEN`** is every code point but the surrogates. The body keeps it in every
  phase: a control character is legal inside a JSON string.
- **`PRINTABLE`** drops the control (`Cc`), surrogate (`Cs`) and unassigned (`Cn`)
  categories. A valid query or path value is percent-encoded into the URL, and a
  control character there makes a server reject the URL before it routes it.
- **`WIRE_SENDABLE`** is printable ASCII without space, `0x21..0x7E`. The client
  encodes a header value as strict ASCII before framing, and the framing layer
  refuses NUL, CR, LF and whitespace at either edge, so it is the set of characters
  *measured* to survive this transport in any position, not a set read off a spec.
  Space and tab are legal in a header only between tokens; a header parameter is
  nearly always a single token, so that form is coverage knowingly not taken.

### Per branch of the string builder

`string_strategy` reads the field through a `SchemaView` and the alphabet through
the context, and each branch honours the alphabet it is handed:

| The field declares | Under `OPEN` | Under `PRINTABLE` or `WIRE_SENDABLE` |
|---|---|---|
| free text (no `format`, no `pattern`) | text of the declared length over the open alphabet | text of the declared length over the narrower alphabet |
| a special-cased `format` (`email`, `uuid`, `date`, `date-time`, `uri`, `ipv4`, `hostname`, `byte`) | the format's regex | the same regex — every `FORMAT_PATTERNS` entry is ASCII by construction |
| an unspecial-cased `format` | the `hypothesis-jsonschema` fallback | narrower-alphabet text of the declared length, keeping a co-declared `pattern` |
| a `pattern` | the pattern, drawn full-match | the pattern intersected with the narrower alphabet |

The `date`, `date-time` and `ipv4` patterns match ASCII digits `[0-9]` rather than
the Unicode decimal category, so a "date" is a date in every zone.

A **pattern that admits no value in the narrower alphabet keeps its open draw**.
The restricted pattern is validated eagerly at compile time; if it is
alphabet-incompatible it falls back to the unrestricted draw rather than raising.
The generator refuses a character class that contains *any* character outside the
alphabet — `[aé]{2}` is refused even though `aa` is drawable — so excluding such an
endpoint would lose coverage the open draw still provides.

### Why narrow, not filter

The path zone drops a few discrete whole values it cannot send (`""`, `.`, `..`)
with a `.filter` after generation. The alphabet is deliberately a different
mechanism: a filter rejects a handful of finished values, whereas nearly everything
the open alphabet draws is non-ASCII, so a header filter would reject almost every
draw and Hypothesis would give up with `filter_too_much`.

## Seeds from the spec

A field that declares a `default` or `examples` seeds its valid draws
([ADR-121](adr/compiler.md#adr-121)). `SchemaView.seeds` is the `default` first,
then the `examples`, each value once by `same_seed` (equal and of one type, so `1`
is not `True`). The dialect has already folded OpenAPI 3.0's singular `example` and
a parameter's `examples` map into the list ([ADR-112](adr/models.md#adr-112)).

`build_valid_strategy` is a weighted union with no hidden weights: a roll in
`0..99` below `SEED_SHARE_PERCENT` (20) draws a deep copy of one seed, any other
roll draws from the schema (`build_unseeded_valid_strategy`). Seeds are trusted as
written, never filtered through the schema. The phases that reuse the valid builder
— `mutation` and `semantic` on a base contract — inherit the seeds, and so do the
fields a poisoning phase leaves valid; a poisoned field in `boundary`, `invalid`
or `attack` never seeds.

## The attack side

`attack` is a poisoning phase on every contract
([ADR-126](adr/compiler.md#adr-126)). The payload machinery lives in
`fields/attack/`, a package any contract uses; `fields/hacker/` keeps only what
tunes it from a `HackerStrategyContract`. The layers point one way, `hacker` →
`attack` → `default`, pinned by a layering test
([ADR-127](adr/compiler.md#adr-127)).

| Contract | Candidates | Profiles | Toggles |
|---|---|---|---|
| base | `base_attack_candidates` | `DEFAULT_ATTACK_PROFILES_BY_TYPE` for the field's type, then the context's `extra_profiles` | `DEFAULT_ATTACK_TOGGLES` |
| hacker | `hacker_attack_candidates` | the contract's own `attack_profiles`, then the context's `extra_profiles` | `toggles_of(contract)` |

Both assemble an `AttackRequest`, the one value object a base-payload builder or
toggle family needs for a field, and hand the tagged payloads to
`fitting_candidates`:

| `AttackRequest` field | From |
|---|---|
| `profiles` | the profiles of the table above, deduplicated in order |
| `toggles` | the `AttackToggles` of the table above |
| `minimum` · `maximum` | the field's numeric bounds |
| `mutation_depth` | the context's (hacker), or `DEFAULT_MUTATION_DEPTH` |

`DEFAULT_ATTACK_PROFILES_BY_TYPE` gives a string `injection`, `xss`,
`path_traversal`, `input_validation` and `information_disclosure`, an integer or
a number `business_logic` and `resource_abuse`, and every other type none. The
hacker side defaults a typeless field to `string` in the caller, so the
base-payload table never keys on `None` ([ADR-028](adr/compiler.md#adr-028)).

A phase's `build` draws bare values. `build_base_attack` is the base candidates
mapped to their values, or the valid strategy when no candidate fits the field;
`build_hacker_attack` samples the hacker payloads, or draws `None` when there are
none.

### `AttackToggles`: eight explicit flags

`AttackToggles` names the eight payload-variant flags a hacker contract may
declare: `include_encoded_variants`, `include_nulls`, `include_large_values`,
`include_extra_fields`, `include_empty_values`, `include_unicode_variants`,
`include_control_chars`, `include_nested_objects`. They are explicit fields,
not generated from the contract. A guard test pins the set to the contract's
`include_*` flags, so adding a flag to the contract without adding it here fails
that test ([ADR-027](adr/compiler.md#adr-027)). `DEFAULT_ATTACK_TOGGLES` are the
toggles an untuned hacker contract resolves to, and the ones a base contract is
attacked with.

### Base payloads and toggle families

`tagged_base_payloads` puts the profile pools first, each spelling tagged with its
profile as its attack family, then the type's base builder, extended with every
toggle family whose flag is set; those carry no family. Only string payloads come
from profile pools. The base builders:

| Type | Base payloads |
|---|---|
| `string` | the profile pools of `PROFILE_STRING_PAYLOADS` (or a generic pool when no profile), extended by nulls and large values per toggle |
| `integer` · `number` | attack and boundary edge values, all finite and not limited to the declared range, plus `None` when `include_nulls` |
| `boolean` | the type-confusion pool (`True`, `False`, `None`, `0`, `1`, `"true"`, …) |
| `array` | `[None]`, a long `[None]*size`, an injection-probe element |
| `object` | `{}` and prototype-pollution shapes, plus `None` when `include_nulls` |
| *unrecognised* | a shared generic fallback pool, deep-copied per draw |

The toggle-family table adds fixed pools keyed by `(toggle, SchemaType)`:

| Toggle | Type | Adds |
|---|---|---|
| `include_encoded_variants` | string (profile pools) | the percent-encoded and base64 spelling of each payload |
| `include_empty_values` | string / array | the empty string / the empty list |
| `include_unicode_variants` | string | emoji, non-Latin scripts, zero-width and case-folding edges |
| `include_control_chars` | string | SOH, BEL, ESC, DEL, FF |
| `include_nested_objects` | object / array | nested-object / nested-array shapes |

On a hacker contract, `include_extra_fields` on an object appends a mutated
object built to the request's `mutation_depth`. `mutate_object` layers
prototype-pollution keys (`__proto__`, `constructor`), a null field, and a
4096-character overflow field, recursing into nested dicts down to the depth.

### Dedupe, then fit the shape

`fitting_candidates` deduplicates in first-seen order, so a payload two pools
share keeps the first family it came under: scalars key by `(type, value)` so
`True` and `1` stay distinct, everything else keys by identity. It then keeps a
candidate only when `validate_value` accepts it for the field's contract, read on
a text wire as the declared type through the strict literals
([ADR-128](adr/compiler.md#adr-128)). The result is an `st.sampled_from`, or
`None` when nothing fits: the field is then not poisonable in `attack`.

### Mass assignment, a body variant

`mass_assignment_variant` is the zone variant `attack` registers on the body
([ADR-134](adr/compiler.md#adr-134)). It draws the valid body plus one key of
`MASS_ASSIGNMENT_KEYS` the body does not declare, with a sentinel privileged
value, names that key as the poisoned field and `auth_bypass` as its family. The
key is chosen inside the one branch, so the probe is one variant of the body's
`one_of`, never one per key. Only a body whose root is an object carries it, and
a focus list that addresses no field of the body keeps it away.

`hacker/` may import `attack/` and `default/`, and `attack/` may import
`default/`; never the reverse.

## The hacker mutation phase

`build_hacker_mutation` is the `mutation` builder for a `HackerStrategyContract`.
Where the attack phase samples from fixed hostile pools, mutation starts from a
value the endpoint would accept and breaks it in exactly one place. It draws a
**non-null valid seed** (`build_non_null_valid_strategy` — the valid strategy
with `None` filtered out, whatever the field's nullability) and applies **one
operator sampled per draw** from the field's operator table:
`st.builds(seed, st.sampled_from(operators))`. Because the seed is drawn per
example, Hypothesis can shrink the mutated value like any other generated input.

The operator table is keyed by the field's `SchemaType`. Each operator is a
frozen `(name, gate, apply)` value object: a pure `(value, depth) -> value`
transform, enabled only when its gate toggle is set (a `None` gate is always
on). A field whose type has no operators — a null type, or a typeless field —
gets its plain valid strategy instead.

| Type | Operator | Gate | Effect |
|---|---|---|---|
| `string` | `truncate` | — | replace with the empty string |
| `string` | `extend` | `include_large_values` | append a 4096-character filler run |
| `string` | `reencode` | `include_encoded_variants` | percent-encode every character |
| `string` | `nullify` | `include_nulls` | replace with `null` |
| `integer` · `number` | `increment` | — | add 1 |
| `integer` · `number` | `decrement` | — | subtract 1 |
| `integer` · `number` | `overflow` | `include_large_values` | replace with 2⁶³ |
| `integer` · `number` | `nullify` | `include_nulls` | replace with `null` |
| `boolean` | `flip` | — | negate the value |
| `boolean` | `nullify` | `include_nulls` | replace with `null` |
| `array` | `empty` | — | replace with `[]` |
| `array` | `duplicate` | — | concatenate the array with itself |
| `array` | `grow` | `include_large_values` | append ten `null` elements |
| `array` | `nest` | `include_nested_objects` | wrap the array in another array |
| `array` | `nullify` | `include_nulls` | replace with `null` |
| `object` | `drop_key` | — | remove the first key (drops a required field) |
| `object` | `extra_key` | `include_extra_fields` | add an unexpected key |
| `object` | `null_value` | `include_nulls` | null the first key's value |
| `object` | `pollute` | `include_nested_objects` | layer prototype-pollution and overflow keys (`mutate_object`) |

The gates are the same `AttackToggles` flags the attack phase reads, so one set
of contract knobs governs both hacker phases. `mutation_depth` (from
`GenerationContext`, carrying the kernel's `EndpointAttack.mutation_depth`, or
`DEFAULT_MUTATION_DEPTH` when unset) reaches only the structural operators — the
object `pollute` operator recurses through `mutate_object` to that depth. It
never changes the phase's budget: depth is intensity, not allocation.

## Attack focus and sensitive fields

Two per-parameter rules narrow the attack phase, both spoken in the same
addressing vocabulary. `is_field_addressed(zone, name, entries)` matches a bare
field name, or a zone-qualified `zone.name`:

- **Focus.** When an endpoint declares `focus_fields`, a parameter the list
  does not address is compiled in the `valid` phase instead of `attack`. The
  attack effort concentrates on the named fields. A `focus_fields` entry that
  addresses no declared field would silently move every field out of the attack
  phase, so the policy boundary rejects it as a `PolicyError` under an attack
  profile — a producer typo fails loudly instead of disabling the attack.
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
  profile's — with the `attack` share set by the endpoint's declared aggressiveness
  through `derive_attack_split` when the mode has an attack phase and the contract
  declares one. A budget that
  declares a phase outside the mode's split is a `PolicyError` raised by
  `validate_endpoint_spec` at the policy boundary; the planner takes a declared
  split as already validated.
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
| `derive_attack_split(base_split, aggressiveness)` | sets the `attack` share to 0.05 per aggressiveness point, capped at `MAX_AGGRESSIVENESS` points (0.5), in place of the base split's own, and rescales the other phases to fit, keeping their proportions |
| `weight_by_risk(max_examples, risk_score)` | scales the budget by `EndpointRisk.risk_score`: ×0.75 at 0, neutral at 50, ×1.25 at 100, never below 1; `None` leaves it unchanged |
| `share_budget(total, identities)` | splits a budget evenly across the declared identities into `BudgetShare`s (the remainder goes to the first ones); with no identities, one anonymous share takes it all; an identity the budget cannot reach gets no share |

## Exact arithmetic

`numeric.is_multiple_of` is the one predicate the compiler and the schema
oracle share. It compares in rational arithmetic (`Fraction`), because a
binary-float `%` is unreliable for `multipleOf` on decimals, and returns
`False` for a non-finite value.
