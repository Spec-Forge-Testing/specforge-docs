# Spec Forge Engine — Decision records — Strategy compiler

Part of the [Spec Forge Engine decision records](index.md). Decisions about
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
flags, so a new contract flag that no builder reads fails the test until it is
either consumed or removed.

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

---

## ADR-051 — Mutation is a generation phase over hacker contracts, seeded from the valid strategy, with engine-owned operators { #adr-051 }

**Status:** accepted · `models/phase.py`, `strategy_compiler/fields/hacker/mutation_operators.py`, `strategy_compiler/fields/hacker/builders.py`, `strategy_compiler/fields/builtin.py`, `profiles/builtin.py`

### Context

Mutation used to exist only as a single `mutate_object({})` payload inside the
attack phase — one hostile object shape among the sampled pools. A real mutation
family is different in kind: it starts from a value the endpoint would accept and
breaks it in exactly one place, so the interesting inputs are the near-misses of
a valid request, not fixed hostile constants. That family needed a home, a seed
and a budget, none of which the attack pools provide.

### Decision

Mutation is a `Phase.MUTATION` registered in the phase registry by contract type,
not a new `StrategyMode`. On a hacker contract the builder draws a **non-null
valid seed** and applies **one operator per draw**, sampled from a table keyed by
the field's `SchemaType`; the seed is drawn per example so Hypothesis can shrink
the mutated variant. The operators and their table are owned by the engine and
gated by the existing `AttackToggles`; intensity comes from `mutation_depth`,
which reaches only the structural operators. The share is taken from `valid` in
the hacker split (`valid` 0.50), so `boundary`, `invalid` and `attack` keep their
budget. On the base contract the phase falls back to the valid strategy, exactly
as `attack` does, so a plain field inside a hacker-mode compile still compiles.

### Rejected

- **A `StrategyMode.MUTATION`.** The mode is a closed, persisted vocabulary, and
  mutation intensifies the hacker mode rather than being orthogonal to it — a new
  mode would fork the whole profile for what is one more phase.
- **Producer-declared seeds and operators.** No kernel field is needed: the
  producer already carries intensity through `mutation_depth`, and the operator
  catalogue is an engine concern, not part of the boundary contract.
- **A whole-payload mutation at zone level.** The compiler is per-field; "drop a
  required field" is simply an operator of the parent object field, so no
  payload-level pass is warranted.
- **Hacker-only registration.** A base-contract field met inside a hacker compile
  would then fail to compile when the mutation phase ran — hence the base
  fallback.

### Consequences

Hacker compiles gain a fifth phase for every field; `RunStats.by_phase` reports
`mutation` separately; nullable seeds are filtered so an operator always receives
a typed value; storage's phase description lists `mutation`.

---

## ADR-067 — A header's text alphabet is narrowed at generation by zone, derived from what the wire carries, and an incompatible pattern falls back rather than excluding the endpoint { #adr-067 }

**Status:** accepted · `strategy_compiler/zone.py`, `strategy_compiler/fields/context.py`, `strategy_compiler/fields/default/alphabet.py`, `strategy_compiler/fields/default/valid.py`, `strategy_compiler/constants.py`

### Context

A `header` string parameter was drawn from almost the whole Unicode space. But a
header value cannot carry it: the client encodes header values as strict ASCII
before framing, and the framing grammar
(`field_value = ([^\x00\s]+(?:[ \t]+[^\x00\s]+)*)?`) refuses NUL, CR, LF, VT, FF
and whitespace at either edge. A header string drawn from the open alphabet is
therefore almost always unencodable, and the request never leaves the client — an
honest "unsendable" result, but budget spent on a value that could never reach
the server. Measured on a real corpus endpoint, 64 of 200 requests (32%) never
reached the wire. The valid phase looked like it was exploring the endpoint while
most of its examples never left the client.

### Decision

**The compiler narrows a string's alphabet by zone, during generation.** The
`GenerationContext` carries a `text_alphabet` (`OPEN` | `WIRE_SENDABLE`, default
`OPEN`); a `_ZONE_TEXT_ALPHABET` table maps `Zone.HEADER` to `WIRE_SENDABLE`, and
`compile_parameter` narrows the context to the zone's alphabet before compiling.
A `TextAlphabet` **mode enum** names the alphabet, and a small table
(`alphabet.py`) maps the mode to the `SearchStrategy` of characters — the value
object carries the choice, not the strategy.

**The wire alphabet is measured, not read off a spec.** It is printable ASCII
without space, `0x21..0x7E` — the set proven to survive the client encoder and
the framing grammar in any position. Space and tab, legal only as an interior
separator between tokens, and the control characters that would in fact pass
(`\x01`, `\x08`, `\x1f`, `\x7f`) are deliberately not generated: a header
parameter is nearly always a single token, and producing valid values is this
phase's job, not stressing the framing layer.

**An alphabet-incompatible pattern falls back to its open draw.** The restricted
pattern is validated eagerly at compile time, so an incompatibility surfaces
there rather than from inside a running generation — the boundary the engine
already closed for requests it cannot build. The generator refuses a character
class containing any character outside the alphabet, even when a compatible value
exists (`[aé]{2}` is refused though `aa` is drawable), so the branch restricts
where it can and keeps the open draw where it cannot. Nothing is excluded,
nothing raises.

The same fix makes the `date`, `date-time` and `ipv4` format patterns match
`[0-9]` rather than the Unicode decimal category, so those formats are ASCII in
every zone, not only in headers.

### Rejected

- **A filter over drawn values, like the path zone's.** Nearly everything the
  open alphabet draws is non-ASCII, so a header filter would reject almost every
  draw and Hypothesis would abandon it with `filter_too_much`. The alphabet must
  be narrowed while generating, not after.
- **Unifying the path zone's value filter with the header's character
  restriction into one table.** They are different mechanisms: the path filter
  rejects a few discrete finished values, the header restriction constrains the
  characters a value is built from. Merging them would blur a post-generation
  reject with a during-generation constraint.
- **Excluding an endpoint whose pattern cannot honour the alphabet.** Because the
  generator refuses a class that admits any outside character even when a
  drawable value exists, exclusion would lose coverage the open draw still
  provides. Falling back keeps it.
- **Putting the alphabet's `SearchStrategy` in the context value object.** The
  context is a frozen bag of endpoint knobs; a mode enum plus a mode→strategy
  table keeps the strategy out of the value object and the choice serializable and
  comparable.

### Consequences

On the measured endpoint, 0 of 200 requests are now unsendable, down from 64. The
header zone spends its valid, semantic and non-hostile attack/mutation budget on
values that reach the server; every other zone keeps the open alphabet, and the
hostile attack and mutation pools are untouched, since a payload that cannot cross
this transport is the raw-socket path's concern. The `GenerationContext` grows one
field, and a new zone that needs its own alphabet is a row in
`_ZONE_TEXT_ALPHABET`.
