# Spec Forge Engine — Decision records — Models

Part of the [Spec Forge Engine decision records](index.md). Decisions about
the vocabularies, the contract package and the boundary DTOs in `models/`.

---

## ADR-004 — Closed vocabularies are `StrEnum` members, the shared ones owned by the kernel { #adr-004 }

**Status:** accepted · `specforge_contracts`, `models/*.py`

### Context

`Zone`, `Criticality`, `Sensitivity` and `AttackFamily` are produced by the
semantic inference stage, read by the orchestrator and consumed by this
engine. As string literals, every consumer keeps its own copy of the set and a
typo is a runtime surprise. Some of them also travel as keys in serialized
output — `phase_split`, `examples_per_phase`, `by_phase`, `by_category` —
where `str()` of the key is what lands on the wire.

### Decision

The shared vocabularies are `enum.StrEnum` in `specforge_contracts`, next to
the semantic DTOs that use them. The engine's own vocabularies —
`ExecutionMode`, `StrategyMode`, `Phase`, `SchemaType`, `SchemaKeyword`,
`SchemaFormat`, `ErrorCategory`, `InvariantViolation`, `TruncationReason`,
`FidelityLevel` — follow the same rule in `models/`.

`StrEnum`, never `class X(str, Enum)`: `str()` of a `StrEnum` member is its
`.value`, whereas the mixin form stringifies to `Phase.VALID`. An enum-keyed
map therefore dumps to the same JSON as a string-keyed one. A parametrised
test pins the property for every vocabulary.

### Rejected

Engine-local enums compared against the kernel's literals. Two owners of one
vocabulary, drifting independently.

### Consequences

The kernel can gain a member and every consumer sees it. Wire output is
unchanged by the switch from literals to members, which is what lets a
vocabulary grow without touching the persisted shape.

---

## ADR-005 — Generation knobs stay in the engine; only vocabularies go to the kernel { #adr-005 }

**Status:** accepted · `models/contracts/`

### Context

The kernel owns the semantic contract of an endpoint: `EndpointContract`,
`SchemaProperty`, risk, attack, transitions. The engine's per-value generation
contracts — `BaseStrategyContract`, `HackerStrategyContract`,
`EndpointBudgetContract`, `ResponseContract`, the state-link family —
describe how to *generate* and *judge* requests: the compiler's own
vocabulary. Since the kernel is where shared shapes live, it was tempting to
widen `SchemaProperty` with the engine's JSON Schema keywords and toggles.

### Decision

The generation contracts live in `models/contracts/`. Only closed vocabularies
move to the kernel ([ADR-004](#adr-004)).

### Rejected

Widening the kernel `SchemaProperty` to the engine's keywords and knobs. The
kernel is the leaf of the dependency graph; it would then own a boundary that
one consumer defines, and every producer upstream would have to know the
compiler's vocabulary to fill a contract.

### Consequences

`models/contracts/__init__` is one import surface: the kernel re-exports plus
the engine's own contracts. The engine imports the kernel; the kernel never
imports the engine.

---

## ADR-006 — The contract vocabulary is a sibling of the compiler and engine models { #adr-006 }

**Status:** accepted · `models/contracts/`, `models/compiler/`, `models/runtime/`

### Context

`models/compiler/outcome.py` carries the `EngineInput`: the compiler produces
the engine's input, so `models/compiler → models/runtime`. `models/runtime/
engine_input.py` keeps the contract DTOs the engine still needs at run time —
risk, attack, budget, responses, state links. If those contracts lived under
`models/compiler/`, the engine models would import the compiler models and
the two folders would depend on each other.

### Decision

`models/contracts/` sits beside `models/compiler/` and `models/runtime/`. The
direction is `models/compiler → models/runtime → models/contracts →
specforge_contracts`, with the enums and `StrategyModeProfile` at the root of
`models/`. The contracts are the shared boundary vocabulary of both stages,
not the compiler's.

### Rejected

Keeping the contracts under the compiler's models with a deferred import in
`engine_input.py`. It hides the cycle instead of removing it.

### Consequences

The models graph is acyclic and reads bottom-up. `GenerationPlan` follows the
same direction ([ADR-011](#adr-011)).

---

## ADR-007 — Risk and attack travel as the kernel's own types { #adr-007 }

**Status:** accepted · `models/contracts/endpoint_controls.py`

### Context

`EndpointSpec.risk` and `.attack` carry what the semantic inference stage
inferred. The kernel already defines `EndpointRisk` and `EndpointAttack`. An
engine-side twin — identical field by field, or a bare alias — would be a
second name for the same thing, and every field type of an exported DTO must
be nameable by the consumer that builds it.

### Decision

`EndpointSpec` and `CompiledExecutionEndpoint` use the kernel's `EndpointRisk`
and `EndpointAttack`, re-exported through `models/contracts` and the facade.
`EndpointBudgetContract` stays engine-side: it has no kernel twin — it is
runtime policy that only the engine reads.

### Rejected

An engine-side `*Contract` twin for symmetry with `EndpointBudgetContract`.
Two vocabularies for one concept.

### Consequences

`EndpointAttack.field_hints` arrives with the contract. The compiler does not
read it — the orchestrator applies the hints to the per-field contracts before
compiling — so the field is carried, not interpreted, here.

---

## ADR-008 — The four request zones are one value object { #adr-008 }

**Status:** accepted · Superseded in part by [ADR-122](#adr-122) · `models/compiler/endpoint_spec.py`

### Context

An endpoint has four request zones — path, query, header, body — each a map
from field name to contract. Four optional fields plus a hand-built iteration
tuple repeat the zone names as strings in a second place, and give callers
nothing to type against.

### Decision

`RequestZones`: a frozen pydantic model, `extra="forbid"`, one field per
`Zone`, each a `ParamMap` defaulting to empty. `by_zone()` yields the
non-empty zones in `path, query, header, body` order as `(Zone, ParamMap)`
pairs. The engine keys its payloads by the same `Zone`, so one concept has one
shape on both sides of the compile.

### Rejected

`zones: dict[Zone, ParamMap]` — a dict with agreed keys, weakly typed, and
`extra="forbid"` cannot govern dict keys. Also four bare fields with a
`Zone`-typed iterator: it removes the string tuple but adds no structure.

### Consequences

Adding a zone is a `Zone` member plus a field here. Callers iterate a typed
structure and never spell a zone name.

---

## ADR-009 — `EndpointSpec` keeps its endpoint-level controls flat { #adr-009 }

**Status:** accepted · `models/compiler/endpoint_spec.py`

### Context

`EndpointSpec` carries six independently optional endpoint-level controls:
`risk`, `budget`, `attack`, `responses`, `state_link`, `semantic_properties`.
Grouping them into an `EndpointControls` wrapper looks tidy next to
`RequestZones`.

### Decision

They stay as flat optional fields on the spec.

### Rejected

The `EndpointControls` wrapper. The six have different origins — security
inference, the adaptive budget, stateful links, the spec's declared responses,
business rules — and no invariant binds them; a wrapper would be a layer on
the wire without cohesion. Contrast with the zones ([ADR-008](#adr-008)),
which are one concept with an order and an iterator.

### Consequences

`EndpointSpec` is the container; adding a control is a field on it.

---

## ADR-010 — `HackerStrategyContract` is a subclass, dispatched by type { #adr-010 }

**Status:** accepted · `models/contracts/strategies/hacker.py`

### Context

The hacker contract is the base contract plus `attack_profiles` and eight
`include_*` payload-variant toggles; its `properties` and `items` are re-typed
so nested values keep the hacker knobs. Flattening it into the base contract
plus an optional `attack` extension was considered.

### Decision

A pydantic subclass. The phase registry is keyed by `(contract_type, Phase)`
and resolved by MRO, so a hacker contract picks up the base phases plus
`attack` without a branch anywhere. The eight toggles are grouped for the
builders in an `AttackToggles` value object derived from the contract's
aliases, the same way `HACKER_EXTRA_FIELDS` is derived. A profile decides
which contract type it accepts through `contract_type` and
`allow_contract_subclasses`.

### Rejected

Flattening. It would degrade dispatch by type into
`if contract.attack is not None` and merge two vocabularies into one DTO.
Moving the toggles into a nested object would also change the contract the
LLM fills in, which is a boundary of a different module.

### Consequences

`StrategyModeProfile.accepts()` is `isinstance` or an exact type check, never
a field inspection. A third contract type is a subclass and a registration.

---

## ADR-011 — `GenerationPlan` is a frozen engine-side value that scales by replacement { #adr-011 }

**Status:** accepted · `models/runtime/plan.py`

### Context

The plan — `estimated_combinations`, `allowed_combinations`, `max_examples`,
`examples_per_phase` — is produced by the compiler's planning and read by the
engine as a field of `CompiledEndpointStrategies`. Performance mode multiplies
the per-phase budget by a load factor. A plan agreed across files as a plain
dict is easy to mutate and impossible to compare.

### Decision

A `@dataclass(frozen=True, slots=True)` in `models/runtime/plan.py`: it is
part of the shape of `EngineInput`, so it lives on the engine side, in the
direction [ADR-006](#adr-006) fixes. Scaling is `scaled(factor)`, a
`dataclasses.replace` that multiplies `examples_per_phase`; `factor == 1`
returns `self`.

### Rejected

A mutable dict splatted with overrides; a plan under `models/compiler/`,
which would make the compiler models and the engine models import each other.

### Consequences

A plan is a value: comparable, hashable, never mutated in flight. Any mode
that needs a different budget derives a new plan.

---

## ADR-012 — `SchemaKeyword` omits `default` { #adr-012 }

**Status:** accepted · Superseded by [ADR-121](compiler.md#adr-121) · `models/schema.py`, `models/contracts/normalization.py`

### Context

`default` is a real JSON Schema keyword, but no builder generates a value from
it and no strategy contract carries it. The orchestrator's adapter derives the
keywords it forwards from `BaseStrategyContract`'s own fields, so a keyword the
contract does not declare is dropped at the boundary and never reaches the
engine. Carrying `default` in the vocabulary and in the allow-list would name a
keyword the engine has no effect for.

### Decision

`default` is not a `SchemaKeyword` member and is absent from
`ALLOWED_FIELDS_BY_TYPE`. A `default` in an OpenAPI schema is ignored — the
adapter never forwards it, the engine never generates from it. The vocabulary
holds only keywords a builder or the policy layer actually consumes, so
`ALLOWED_FIELDS_BY_TYPE` is a clean `frozenset[SchemaKeyword]` per type. The
hacker table keeps `frozenset[SchemaKeyword | str]`, honestly: `HACKER_EXTRA_FIELDS`
are the hacker contract's own snake_case wire names, not schema keywords.

### Rejected

Keeping `default` as an accepted-but-inert member with a comment explaining why
no builder reads it. It would name a keyword the engine never honours and leak
an unused member into the base allow-list's type. A keyword the engine ignores
is dropped silently at the boundary rather than documented as inert vocabulary.

### Consequences

Twenty-one keywords. The base allow-list has one element type; the hacker
allow-list's union names exactly the two things it holds.

---

## ADR-112 — The dialect folds OpenAPI 3.0's spellings, and a numeric bound is a number or nothing { #adr-112 }

**Status:** accepted · `models/contracts/dialect.py`, `models/contracts/strategies/base.py`; core `services/fuzz/projection/schema.py`

### Context

OpenAPI 3.0 spells an exclusive bound as a boolean modifier of the inclusive one
(`minimum: 0, exclusiveMinimum: true`); 3.1 and JSON Schema spell it as the bound
itself (`exclusiveMinimum: 0`). A lax numeric field reads the boolean as a number:
`exclusiveMinimum: false` becomes an exclusive minimum of `0`, so a field declared
`[0, 30]` never draws `0`, and `exclusiveMinimum: true` becomes an exclusive
minimum of `1` whatever the declared `minimum` is. The same version writes one
`example` per schema where the newer ones write an `examples` list, and a
parameter object names its examples in a map whose entries hold a `value`.

A contract reaches the engine by two paths, projected from the OpenAPI document
or fused with an inferred contract. The engine's contract model is the one point
both cross.

### Decision

**`normalize_dialect` translates every 3.0 spelling, at every depth.** It is the
`before` validator of `BaseStrategyContract`, so it runs on every schema fragment
of both paths. Two rules join the type-array rule:

- A boolean exclusive bound becomes a numeric one. `true` moves the inclusive
  bound into the exclusive keyword; `true` with no inclusive bound, and `false`,
  are dropped.
- `example` and a non-list `examples` fold into one `examples` list. A map
  contributes each entry's `value`; any other non-list contributes nothing; the
  singular `example` is appended unless the list already holds it.

**A bound is strictly typed.** `exclusiveMinimum` and `exclusiveMaximum` are
`StrictInt | StrictFloat`; `minimum` and `maximum` also take a string, for date
bounds. A boolean that reaches the model without the dialect is a validation
error at the boundary, never `0` or `1`.

**Two samples are one value when they are equal and of one type.** `same_seed` is
that rule, so `1` and `True` stay distinct seeds. The facade exports it, and the
core's projection deduplicates a parameter's own examples with it.

### Rejected

- **Normalizing in contract assembly or in the core's projection.** There are two
  entry paths, and a second normalizer would drift from the first. The engine is
  the one place every contract passes through.
- **Withholding an endpoint whose `examples` is not a list.** A spelling
  difference would cost the whole endpoint.

### Consequences

A 3.0 document with `exclusiveMinimum: false` generates on the closed range, and
one with `true` excludes exactly the declared bound. A contract that writes a
boolean bound where the dialect cannot see it fails validation and names the
field.

---

## ADR-122 — The body is one root contract with one media type, encoded by a closed table { #adr-122 }

**Status:** accepted · Supersedes in part [ADR-008](#adr-008) · `models/compiler/endpoint_spec.py`, `models/runtime/engine_input.py`, `models/media_type.py`, `strategy_compiler/body.py`, `runtime/http/body_encoders.py`, `runtime/http/injector.py`, `runtime/trace/`; core `services/fuzz/projection/body.py`

### Context

Modelled as a map of the root object's properties beside a list of the endpoint's
content types, a body whose root is not an object (an array of ids, a bare string,
a number) has no properties and is never sent. Nothing in that shape says whether
the body is required, so an optional body is always sent; nothing ties the content
type sent to the media type whose schema the values were drawn from; and a single
JSON writer sends every body as JSON, whatever its media type says.

### Decision

**`BodySpec` is the declared body as a whole.** `BodySpec(media_type, required,
root)`: the chosen media type, whether the body is required, and the root contract.
`fields` is derived from the root's properties, never stored twice, and is empty
for a root that is not an object. A required body makes its root required, so an
omitted root is judged as missing. `RequestZones.body` is a `BodySpec | None`;
`EndpointSpec.content_types` does not exist.

**The producer picks one media type.** The core's projection prefers
`application/json`, then any JSON media type (`is_json_media_type`: the essence is
`application/json` or ends in `+json`), then the first one declared, and takes that
media type's own schema. A body only an inferred contract declares is JSON.

**A root that is not an object compiles as one field.** It is the field
`BODY_ROOT` (`"$"`): its draw is the value itself, and the poisoning phases poison
it under that name. An optional body is left out of some `valid` draws, as often as
an optional parameter, and never out of a poisoning draw.

**`CompiledBody` carries what the transport needs.** It extends
`CompiledRequestPart` with the `media_type` and the `file_fields`, the root's
properties declared `format: binary`. The blueprint and the trace carry `body`,
`media_type` and `file_fields`, so a replay encodes a recorded body without the
compiled endpoint.

**Encoders are a closed table keyed by media type.** `BODY_ENCODERS` holds three:
JSON (every JSON media type), `application/x-www-form-urlencoded` and
`multipart/form-data`. An encoder names the `Content-Type` to send (`None` lets the
client write it, as multipart needs for its boundary), the client arguments, and
why a body cannot be encoded. A media type without an encoder is an
`unsendable_request`, never JSON in disguise.

**`None` is "not sent", on every wire.** A body drawn as `None` is sent as no body
and without the body's `Content-Type`; a form or multipart field drawn as `None` is left out; a
parameter drawn as `None` is left out of the query and the headers.

### Rejected

- **A `Map` of fields plus a separate list of content types.** It cannot express
  a root that is not an object, and nothing ties the content type sent to the
  schema drawn.
- **Building a multipart body by hand.** The client already frames the parts and
  writes the boundary.
- **An open encoder registry.** An encoder decides what a request carries on the
  wire and how the input-validation oracle reads it back
  ([ADR-117](compiler.md#adr-117)); a media type is a new row in that one file,
  reviewed with the oracle.

### Consequences

An array, string or number body is compiled, sent and judged. A form or multipart
body is sent as such, each field as text (a non-string value as its JSON text), and
a multipart body with no field to send is unsendable. Every body the spec does not
mark required is left out of some valid draws. A root declared `{}` sends
arbitrary JSON.
