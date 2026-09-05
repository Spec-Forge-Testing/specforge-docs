# Custom Schemathesis — Decision records — Models

Part of the [Custom Schemathesis decision records](index.md). Decisions about
the vocabularies, the contract package and the boundary DTOs in `models/`.

---

## ADR-004 — Closed vocabularies are `StrEnum` members, the shared ones owned by the kernel { #adr-004 }

**Status:** accepted · `specforge_contracts`, `models/*.py`

### Context

`Zone`, `Criticality`, `Sensitivity` and `AttackProfile` are produced by the
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

**Status:** accepted · `models/contracts/`, `models/compiler/`, `models/engine/`

### Context

`models/compiler/outcome.py` carries the `EngineInput`: the compiler produces
the engine's input, so `models/compiler → models/engine`. `models/engine/
engine_input.py` keeps the contract DTOs the engine still needs at run time —
risk, attack, budget, responses, state links. If those contracts lived under
`models/compiler/`, the engine models would import the compiler models and
the two folders would depend on each other.

### Decision

`models/contracts/` sits beside `models/compiler/` and `models/engine/`. The
direction is `models/compiler → models/engine → models/contracts →
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

**Status:** accepted · `models/compiler/endpoint_spec.py`

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

The hacker contract is the base contract plus `attack_profiles` and nine
`include_*` payload-variant toggles; its `properties` and `items` are re-typed
so nested values keep the hacker knobs. Flattening it into the base contract
plus an optional `attack` extension was considered.

### Decision

A pydantic subclass. The phase registry is keyed by `(contract_type, Phase)`
and resolved by MRO, so a hacker contract picks up the base phases plus
`attack` without a branch anywhere. The nine toggles are grouped for the
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

**Status:** accepted · `models/engine/plan.py`

### Context

The plan — `estimated_combinations`, `allowed_combinations`, `max_examples`,
`examples_per_phase` — is produced by the compiler's planning and read by the
engine as a field of `CompiledEndpointStrategies`. Performance mode multiplies
the per-phase budget by a load factor. A plan agreed across files as a plain
dict is easy to mutate and impossible to compare.

### Decision

A `@dataclass(frozen=True, slots=True)` in `models/engine/plan.py`: it is
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

## ADR-012 — `SchemaKeyword` includes `default` { #adr-012 }

**Status:** accepted · `models/schema.py`, `models/contracts/normalization.py`

### Context

No builder consumes `default`, so it was tempting to leave it out of the
vocabulary and keep it as a loose string beside the enum. But it is a real
JSON Schema keyword, a field of `BaseStrategyContract`, and the policy layer
reads it when checking which fields a type may carry.

### Decision

`default` is a member. `ALLOWED_FIELDS_BY_TYPE` is a clean
`frozenset[SchemaKeyword]` per type. The hacker table keeps
`frozenset[SchemaKeyword | str]`, honestly: `HACKER_EXTRA_FIELDS` are the
hacker contract's own snake_case wire names, not schema keywords.

### Rejected

A loose string constant with a comment explaining why it is not in the enum.
The absent member would leak into the type of the base allow-list.

### Consequences

Twenty-two keywords. The base allow-list has one element type; the hacker
allow-list's union names exactly the two things it holds.
