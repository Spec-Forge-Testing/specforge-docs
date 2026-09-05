# Custom Schemathesis — Decision records — Strategy compiler

Part of the [Custom Schemathesis decision records](index.md). Decisions about
how a validated field becomes a Hypothesis strategy.

---

## ADR-016 — Field builders are functions in tables, not implementations of a Protocol { #adr-016 }

**Status:** accepted · `strategy_compiler/fields/default/`, `strategy_compiler/fields/hacker/`

### Context

Every "dispatch on the schema type" in the compiler — valid values, boundary
values, invalid values, format-specific values, and the response-body
fingerprint on the engine side — is a mapping from `SchemaType` or
`SchemaFormat` to a builder. A `Generator` Protocol with one class per type
and a registry to hold them looks like the more extensible shape.

### Decision

Each site owns a named table keyed by the enum, and the entries are plain
functions. The extension axis of the compiler is the phase registry
(`register_phase`), where a `GenerationPhase` binds a contract type and a
`Phase` to a builder; the tables inside a phase are that phase's own.

### Rejected

A `Generator` Protocol plus a builder registry. Every entry has exactly one
implementation and no second one in sight — a registry for a single
implementation is speculative structure, and it would put a second extension
mechanism beside the one that already exists.

### Consequences

Adding a type is a row in each table, and the enum makes a missing row a
lookup failure rather than a silent fall-through. The `if/elif` cascade over
type names does not exist anywhere in the compiler.

---

## ADR-023 — `SchemaView` wraps the contract, not its dump { #adr-023 }

**Status:** accepted · `strategy_compiler/fields/schema_view.py`

### Context

Every builder needs the same schema constraints of a contract — its type,
bounds, enum, format, length. A contract is a pydantic model; the constraints
are readable by dumping it to a dict and indexing by string key.

### Decision

`SchemaView` wraps the contract itself and exposes each constraint as a typed
property returning a closed enum (`SchemaType`, `SchemaFormat`) or a scalar. The
raw dump survives as a single property, `json_schema`, used only for the zone's
documentation schema and the `hypothesis-jsonschema` fallback.

### Rejected

Thread the `model_dump()` dict through the builders and read string keys. It
turns every access into an untyped lookup where a typo is a silent `None`, and
scatters `model_dump()` calls across the compiler.

### Consequences

A mistyped constraint is a missing attribute, caught immediately; enums stay
enums; and the raw dump has exactly two call sites instead of many.

---

## ADR-024 — The generation context is always present { #adr-024 }

**Status:** accepted · `strategy_compiler/fields/context.py`

### Context

Some phase builders read endpoint-wide knobs — aggressiveness, mutation depth,
the attack profiles an endpoint's risk inherits — and most do not. The knobs
could be passed only when they exist.

### Decision

A `GenerationContext` is always threaded alongside the contract, and
`EMPTY_CONTEXT` is the shared instance for an endpoint with no knobs. A builder
reads the fields unconditionally.

### Rejected

An `Optional[GenerationContext]` passed only to builders that want it. Every
reader would then guard for `None`, and the guard would be wrong the day a knob
matters.

### Consequences

Builders never branch on presence; the caller decides `EMPTY_CONTEXT` once; the
signature-adaptation rule can hand `context` to any builder that names it.

---

## ADR-025 — Phase builders are registered explicitly { #adr-025 }

**Status:** accepted · `strategy_compiler/fields/builtin.py`

### Context

The phase registry could fill itself as a side effect of importing each builder
module — the import registers the builder.

### Decision

`register_builtin_phases()` registers the five built-ins explicitly, called once
when `fields/` is imported. Import of a builder module registers nothing.

### Rejected

Registration on import of each builder. It makes the registered set depend on
which modules were imported and in what order, and hides the full set from any
single place.

### Consequences

The built-in set is one readable function; a test can start from an empty
registry through `isolated()`; import order cannot change behaviour.

---

## ADR-026 — `GenerationPhase` rejects a non-callable builder { #adr-026 }

**Status:** accepted · `strategy_compiler/fields/registry.py`

### Context

A `GenerationPhase` binds a `build` callable. A mis-registration could pass
something that is not callable, and the registry would hold it until the first
draw.

### Decision

`GenerationPhase.__post_init__` raises `TypeError` when `build` is not callable,
at registration time.

### Rejected

Let the failure surface when the builder is first invoked. The traceback would
then point at a draw deep in a compile, not at the wrong registration.

### Consequences

A mis-registration fails where it is written, and the registry never holds an
entry it cannot call.

---

## ADR-027 — `AttackToggles` are explicit fields, pinned by a test { #adr-027 }

**Status:** accepted · `strategy_compiler/fields/hacker/request.py`

### Context

The hacker contract declares a set of `include_*` payload-variant flags. The
attack builders need those flags, and the two lists could drift.

### Decision

`AttackToggles` names the eight consumed flags as explicit fields and reads them
in `from_contract`. A guard test pins the field set to the contract's `include_*`
flags, minus `include_duplicate_fields`, which no builder consumes.

### Rejected

Derive the toggles from the contract at runtime. It would silently accept a new
contract flag as a toggle that no builder actually reads, and lose the typed
field names.

### Consequences

The builders read named fields; a new contract flag without a matching toggle
field fails the guard; the one unconsumed flag is excluded on purpose, in view.

---

## ADR-028 — The attack builder takes the type, defaulted by its caller { #adr-028 }

**Status:** accepted · `strategy_compiler/fields/hacker/builders.py`

### Context

A hacker field may declare no type, yet the base-payload table keys on
`SchemaType`. Something has to decide the type a typeless field attacks as.

### Decision

`build_attack_payloads` takes `(value_type, request)` as two arguments.
`build_hacker_attack`, the caller, defaults a typeless field to `string` before
building the request; the base-payload lookup falls back to a generic pool for
any type it does not recognize.

### Rejected

Fold the default into the payload table. The table would then mix a lookup with
a policy about missing types, and the default would be invisible to a reader of
the caller.

### Consequences

The default is decided once, in the caller, in plain sight; the payload table
stays a pure mapping from type to builder.

---

## ADR-029 — The zone compile context does not carry the zone { #adr-029 }

**Status:** accepted · `strategy_compiler/zone.py`

### Context

An endpoint's zones are compiled against the same knobs — the phases to build,
the generation context, the attack focus and sensitive field lists. Only the
`Zone` differs between them.

### Decision

`ZoneCompileContext` holds the shared knobs and not the zone. The zone is a
per-call argument to `compile_zone`, and the narrowing to one phase per
parameter is a small internal slot.

### Rejected

Build a context per zone that carries its own zone. It would recompute the
shared knobs four times and blur what is constant across an endpoint with what
varies within it.

### Consequences

The endpoint-wide knobs are computed once; the varying `Zone` is explicit at
each call; the shared and the per-zone parts do not get confused.

---

## ADR-030 — The generation plan is built directly, never mutated { #adr-030 }

**Status:** accepted · `strategy_compiler/planning.py`

### Context

`build_generation_plan` computes several figures — totals, the phase split, the
combination limits — before it has a plan to return.

### Decision

The figures are computed as locals and the `GenerationPlan` is constructed once,
directly, from them. It is a frozen value object; nothing mutates a plan after
construction. Performance mode scales it by producing a new plan.

### Rejected

Build an empty or partial plan and fill it field by field. A half-built plan is
a shape the type says cannot exist, and a mutable one invites a later edit that
the frozen contract is meant to forbid.

### Consequences

A plan is valid the moment it exists; every field is set in one expression;
scaling is replacement, not mutation.

---

## ADR-031 — A foreign phase split is a `PolicyError`, kept where it is raised { #adr-031 }

**Status:** accepted · `strategy_compiler/planning.py`, `strategy_compiler/compiler.py`

### Context

A budget may declare its own `phase_split`. A split naming a phase the mode does
not run is not a fact about one endpoint's schema — it is an input the mode
cannot honour.

### Decision

The planner raises `PolicyError` for a phase outside the mode's split. The
per-endpoint reporting that turns a `StrategyCompilationError` into an
exclusion does not catch it, so the `PolicyError` propagates out of `compile`.

### Rejected

Catch it and reify it as an `EndpointExclusion` like any other rejection. That
would demote a malformed input to a skipped endpoint and let a compile succeed
over an input the caller got wrong.

### Consequences

An uncompilable endpoint is an exclusion; a malformed input fails the whole
compile loudly; the two failure kinds keep their distinct exits.

---

## ADR-032 — Compiled output carries the kernel attack contract in full { #adr-032 }

**Status:** accepted · `strategy_compiler/compiler.py`

### Context

A `CompiledExecutionEndpoint` keeps the endpoint's `EndpointAttack` so the
engine has the attack semantics at run time. The kernel's `EndpointAttack`
carries `field_hints` alongside its profiles and field lists.

### Decision

The compiled output carries the kernel attack contract in full, `field_hints`
included, unpruned. The recorded characterization goldens for the compiler
therefore show `field_hints` on every compiled endpoint that declares it.

### Rejected

Copy only the attack fields the compiler reads and drop the rest. The engine
would then lose per-field hints it is entitled to, and the compiled endpoint
would stop being a faithful carrier of the contract.

### Consequences

The engine receives the whole attack contract; the goldens record it as it is;
a new kernel attack field reaches the engine without a change to the compiler.
