# Spec Forge Engine — Decision records — Strategy compiler

Part of the [Spec Forge Engine decision records](index.md). Decisions about
how a validated field becomes a Hypothesis strategy.

---

## ADR-016 — Field builders are functions in tables, not implementations of a Protocol { #adr-016 }

**Status:** accepted · `strategy_compiler/fields/default/`, `strategy_compiler/fields/security.py`

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
the attack families an endpoint's risk inherits — and most do not. The knobs
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

**Status:** accepted · `strategy_compiler/fields/attack/request.py`

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

**Status:** accepted · `strategy_compiler/fields/security.py`

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

**Status:** accepted · Superseded in part by [ADR-141](measurement.md#adr-141), [ADR-156](strategies.md#adr-156), [ADR-180](#adr-180) · `models/phase.py`, `strategy_compiler/fields/mutation/operators.py`, `strategy_compiler/fields/security.py`, `strategy_compiler/fields/builtin.py`, `profiles/builtin.py`

### Context

Mutation used to exist only as a single `mutate_object({})` payload inside the
attack phase — one hostile object shape among the sampled pools. A real mutation
family is different in kind: it starts from a value the endpoint would accept and
breaks it in exactly one place, so the interesting inputs are the near-misses of
a valid request, not fixed hostile constants. That family needed a home, a seed
and a budget, none of which the attack pools provide.

### Decision

Mutation is a `Phase.MUTATION` registered in the phase registry by contract type,
not a new `Strategy`. On a hacker contract the builder draws a **non-null
valid seed** and applies **one operator per draw**, sampled from a table keyed by
the field's `SchemaType`; the seed is drawn per example so Hypothesis can shrink
the mutated variant. The operators and their table are owned by the engine and
gated by the existing `AttackToggles`; intensity comes from `mutation_depth`,
which reaches only the structural operators. The share is taken from `valid` in
the `security` split (`valid` 0.50), so `boundary`, `invalid` and `attack` keep their
budget. (Superseded in part by [ADR-141](measurement.md#adr-141): the measured
`security` split gives `mutation` 0.05 and `valid` 0.40.) On the base contract the phase falls back to the valid strategy, exactly
as `attack` does, so a plain field inside a `security` compile still compiles. (Superseded in part by
[ADR-156](strategies.md#adr-156): the base contract mutates too, with the default toggles.)

### Rejected

- **A `Strategy.MUTATION`.** The strategy is a closed, persisted vocabulary, and
  mutation intensifies the `security` strategy rather than being orthogonal to it — a new
  strategy would fork the whole profile for what is one more phase.
- **Producer-declared seeds and operators.** No kernel field is needed: the
  producer already carries intensity through `mutation_depth`, and the operator
  catalogue is an engine concern, not part of the boundary contract.
- **A whole-payload mutation at zone level.** The compiler is per-field; "drop a
  required field" is simply an operator of the parent object field, so no
  payload-level pass is warranted.
- **Hacker-only registration.** A base-contract field met inside a `security` compile
  would then fail to compile when the mutation phase ran — hence the base
  fallback.

### Consequences

`security` compiles gain a fifth phase for every field; `RunStats.by_phase` reports
`mutation` separately; nullable seeds are filtered so an operator always receives
a typed value; storage's phase description lists `mutation`.

---

## ADR-067 — A header's text alphabet is narrowed at generation by zone, derived from what the wire carries, and an incompatible pattern falls back rather than excluding the endpoint { #adr-067 }

**Status:** accepted · Superseded in part by [ADR-114](#adr-114) · `strategy_compiler/zone.py`, `strategy_compiler/fields/context.py`, `strategy_compiler/fields/default/alphabet.py`, `strategy_compiler/fields/default/valid.py`, `strategy_compiler/constants.py`

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

---

## ADR-111 — Numbers stay finite, and the boundary phase stays inside the declared range { #adr-111 }

**Status:** accepted · Superseded in part by [ADR-113](#adr-113) and [ADR-128](#adr-128) · `strategy_compiler/constants.py`, `strategy_compiler/fields/default/constraints.py`, `strategy_compiler/fields/default/boundary.py`, `strategy_compiler/fields/attack/payloads.py`; engine `runtime/http/wire_body.py`

### Context

The float edge table carried `inf` and `-inf`, the `number` boundary builder did
not filter its candidates by the declared range (the `integer` one did), and an
exclusive bound was resolved by adding or subtracting a fixed `1e-10`. Three
failures followed. httpx serializes a JSON body with `allow_nan=False`, so a single
infinite value raised inside the send path and aborted the whole run. A boundary
value outside `minimum`/`maximum` was spent as a "boundary" probe it was not. And
the fixed step broke at both ends of the scale: on a large bound `x + 1e-10 == x`,
so an exclusive bound was included, and a range narrower than the step resolved to
nothing at all.

### Decision

**Every generated number is finite.** `FLOAT_BOUNDARY` holds finite edges only,
and the candidates built from a declared bound drop anything non-finite.

**An exclusive bound resolves to the adjacent representable float**
(`math.nextafter`), so it is excluded at any magnitude and a narrow range keeps its
values.

**The boundary phase stays inside the declared range.** `number` candidates are
the finite edges plus each resolved bound and the floats on either side of it, kept
only when they fall within the range, as `integer` candidates already were. When no
candidate survives, the field falls back to its valid-phase draw, or to an open
finite draw when no sendable value satisfies the field at all.

**The attack phase keeps out-of-range values.** Its numeric payloads are finite,
but they still cross the declared range on purpose: probing outside it is what the
phase is for.

### Rejected

- **Catching the failure only when the body is serialized.** It keeps the run
  alive but spends budget on values that can never be sent. The engine does catch
  it as a second line of defence: a body JSON cannot encode becomes an
  `unsendable_request` result.
- **Filtering attack values to the range.** It would remove the probes the phase
  exists to send.

### Consequences

A contract with a `number` field runs to completion, its boundary probes sit on and
next to the declared edges, and an exclusive bound is honoured exactly. Boundary
candidates are filtered by range, not by `multipleOf`.

---

## ADR-113 — Numbers are bounded by their declared format, and the generation word bounds only the valid phase { #adr-113 }

**Status:** accepted · Supersedes in part [ADR-111](#adr-111) · `models/schema.py`, `strategy_compiler/constants.py`, `strategy_compiler/fields/default/constraints.py`, `strategy_compiler/fields/default/boundary.py`, `strategy_compiler/fields/default/valid.py`, `runtime/oracles/schema_check.py`

### Context

An `integer` drawn from an open strategy reaches twenty-nine digits, and about one
valid draw in five has eleven or more. A field declared `format: int32` drawn the
same way leaves its word. A server rejects such a value while parsing, before its
endpoint logic runs, so the valid phase spends its budget on requests that test
the parser. A `number` declared `format: float` is probed with a double's edges
(`1e308`), which a single-precision field cannot hold either.

### Decision

**Numeric formats are their own vocabulary.** `NumericFormat` (`int32`, `int64`,
`float`, `double`) sits beside the string `SchemaFormat`, and `NUMERIC_WORD_RANGE`
in `models/schema.py` holds the word of each bounded one. The string builders key
their regex table by `SchemaFormat`; a string that declares `format: int32` never
reaches it.

**Two ranges, read by different phases.**

| Range | What it is | Read by |
|---|---|---|
| declared (`declared_int_range`, `declared_float_range`) | `minimum`/`maximum` and the exclusive bounds, narrowed by a declared format's word and never widened | `boundary`, `invalid`; the oracles hold a value to the same bounds and word |
| generation (`generation_int_range`, `generation_float_range`) | the declared range inside the word of `UNFORMATTED_INTEGER_FORMAT` (`int64`) when the field names no integer format | `valid` |

`int64` for an unformatted integer is a choice of generation: an integer with no
format is a 64-bit word in every real implementation. It is not a promise of the
spec, so the boundary and invalid phases still probe past it, and the oracles hold
an unformatted integer to no word at all. An `int32` field's boundary phase offers
`2**31 - 1`; its invalid phase offers `2**31` as out of range.

**Float edges follow the format.** `FLOAT_BOUNDARY` is keyed by `NumericFormat`:
`float` probes `±3.4028235e38` and `±1.1754944e-38`, and `double` (and a `number`
with no format) keeps the double's edges.

**Boundary candidates sit on the declared multiple.** Each candidate is snapped
down and up to `multipleOf` in exact rational arithmetic, and an integer field
keeps only the whole results.

The attack phase keeps the full word tables: probing past a declared range is
what it is for.

### Rejected

- **Leaving the unformatted integer open in the valid phase.** Twenty-nine digits
  is noise, not coverage.
- **Bounding the boundary and invalid phases by `int64` too.** For an unformatted
  integer, the value past the word is exactly the probe those phases exist to send.
- **Adding the numeric formats to `SchemaFormat`.** The string builder indexes its
  pattern table by every known `SchemaFormat`; a numeric member there has no
  pattern and fails at the first string that declares it.

### Consequences

Valid integers fit the word their field declares, or `int64`. A response that
returns `2**31` for a field declared `int32` breaks the response schema. The
boundary phase of a field with `multipleOf` stays on the multiple.

---

## ADR-114 — Strings draw from one of three alphabets, chosen by zone and phase, and the body stays open { #adr-114 }

**Status:** accepted · Supersedes in part [ADR-067](#adr-067) · `models/wire.py`, `strategy_compiler/constants.py`, `strategy_compiler/parameter.py`, `strategy_compiler/fields/default/alphabet.py`

### Context

[ADR-067](#adr-067) narrows a header's strings to what the transport can carry.
Query and path strings drawn from the open alphabet carry control characters and
unassigned code points. They are percent-encoded and sent, and a server rejects
the URL before routing it, so a valid request tests the URL parser. A body string
is different: a control character is legal inside a JSON string.

### Decision

**`TextAlphabet` has three members.**

| Member | Characters |
|---|---|
| `OPEN` | every code point but the surrogates |
| `PRINTABLE` | every code point but the control (`Cc`), surrogate (`Cs`) and unassigned (`Cn`) categories |
| `WIRE_SENDABLE` | printable ASCII without space, `0x21`–`0x7E` |

**The alphabet is a table of phase and zone.** `TEXT_ALPHABET_BY_PHASE` maps the
`valid` phase to `VALID_TEXT_ALPHABET`; every other phase takes
`NON_VALID_TEXT_ALPHABET`. A zone absent from a table draws `OPEN`.

| Zone | `valid` | every other phase |
|---|---|---|
| `header` | `WIRE_SENDABLE` | `WIRE_SENDABLE` |
| `query`, `path` | `PRINTABLE` | `OPEN` |
| `body` | `OPEN` | `OPEN` |

`compile_parameter` sets the alphabet on the field's `GenerationContext` for the
phase it compiles. In a poisoned request only the poisoned field is compiled for
the poisoning phase; every other field draws valid, under the valid alphabet.

**The body keeps the open alphabet on purpose.** A JSON string may carry any
character but a surrogate. A server that rejects a control character in a JSON
string validates more than it declares, and the valid phase is where that shows.

### Rejected

- **An alphabet per field in the contract.** A knob no producer has a value for.
- **`PRINTABLE` for the body.** It would stop sending legal JSON strings a server
  may mishandle.

### Consequences

Valid query and path values never carry a control or unassigned character. The
header table is unchanged. The printable narrowing belongs to the valid phase
alone: `semantic`, `attack` and `mutation` draw query and path text from the open
alphabet.

---

## ADR-115 — Optional parameters are optional, and the minimal request is the first valid example, inside the quota { #adr-115 }

**Status:** accepted · `strategy_compiler/zone.py`, `strategy_compiler/fields/default/valid.py`, `runtime/harness/minimal.py`, `runtime/fuzzers/stateless/example_counts.py`, `runtime/fuzzers/stateless/exploration.py`; core `services/fuzz/projection/schema.py`

### Context

A zone compiled as a fixed dictionary of every parameter sends every optional
parameter in every draw. The request clients send most often, the required
parameters and nothing else, is then never sent, and an endpoint that misbehaves
only without an optional parameter is never caught. On the fused path the core
never marks a parameter required, so every parameter there is optional by
omission.

### Decision

**A valid draw holds what is required and sometimes the rest.** The valid phase
compiles each zone as a fixed dictionary with the required parameters always
present and every optional one optional. A path segment is always present. The
non-poisoning phases other than `valid` (`attack`, `mutation`, `semantic`) send
every parameter; a poisoning variant holds the required parameters and the
poisoned one, and the rest optionally.

**The core marks the kernel's required parameters.** The projection reads the
contract's `required_parameters` and sets `required` on the contracts of their
zone.

**The minimal request is a seeded example.** `plan_passes` computes, for every
valid pass, `minimal_draw(strategy)`: the simplest payload the pass's strategy
draws, found by Hypothesis with the shrink settings. The pass runs it as an
explicit `@example`, so it is the first request the pass sends. It is carried as
`Pass.minimal_payload`.

**It takes one place of the pass's share.** A pass with a minimal payload
generates `share - 1` examples, or runs only the explicit example when its share
is 1. Hypothesis does not count an explicit example toward `max_examples`, so
adding it on top would send one request more than the plan.

### Rejected

- **A separate `minimal` pass.** It duplicates the budget and its accounting.
- **The minimal request on top of the share.** A performance ladder step promises
  to send exactly its budget, and every request counter would drift by one per
  pass.

### Consequences

Every valid pass opens with the request that sends only what the spec requires.
Optional parameters are left out of a share of the draws, and request counts stay
exact.

---

## ADR-117 — The zone's wire decides what is invalid and how the oracle reads it back { #adr-117 }

**Status:** accepted · Superseded in part by [ADR-177](findings.md#adr-177) · `models/wire.py`, `models/media_type.py`, `strategy_compiler/fields/context.py`, `strategy_compiler/fields/default/invalid.py`, `strategy_compiler/parameter.py`, `runtime/oracles/input_validation.py`

### Context

A query, a header and a form field carry text. An integer drawn for a string
field arrives as the text `6`, which the string accepts. `None` for an optional
query parameter means the parameter is left out, which is valid. A path segment
can be neither empty nor left out. Lenient servers read more texts as a type than
a strict parser does: `?flag=1` is `true` for many of them, and Python's `int`
reads `" 7"` and `"1_0"`. A JSON body carries types and `null` as such.

An invalid generator that ignores the wire sends valid requests labelled invalid,
and an oracle that judges them reports an API for accepting valid input.

### Decision

**`ZoneWire` names how a zone carries a value.** `zone_wire(zone, media_type)`:
path is `SEGMENT`, query and header are `TEXT`, and the body is `STRUCTURED` for a
JSON media type (or none) and `TEXT` for any other, form and multipart included.
The compiler puts the wire on the field's `GenerationContext`.

**The invalid candidates are those the wire tells apart.**

| Candidate | `STRUCTURED` | `TEXT` | `SEGMENT` |
|---|---|---|---|
| a value of another type (`integer` or `boolean` for a `string`) | yes | no | no |
| text for a numeric or boolean field | any text | text no lenient server reads as the type | text no lenient server reads as the type |
| `""` for `minLength > 0` | yes | yes | no |
| `None` | for an `integer`, `number`, `array` or `object` field | only for a required parameter: leaving it out is the invalid request | never |
| an array | wrong type, or `[]` below `minItems` | one item its own schema rejects, as `[item]` | one item its own schema rejects, as `[item]` |
| an object | wrong type | not poisoned | not poisoned |

Every wire also offers the over-long string past `maxLength`, a text outside an
`enum`, and an integer outside the declared range. "Lenient" is
`reads_leniently_as`: Python's `int` and `float`, and the booleans `1`, `0`, `yes`,
`no`, `on`, `off`, `t`, `f`, `y` and `n`.

**The oracle reads strictly.** On a text wire the input-validation oracle reads
the text the request carried as the declared type through strict literals
(`-?[0-9]+` for an integer, a decimal with an optional exponent for a number,
`true` or `false`); a text the literal does not parse stays text and fails the
type. A form or multipart field is judged as the text its encoder sent.

The gap between the two readings is the point. The generator never offers a text
some server reads as valid; the oracle never credits a text the spec does not
spell.

### Rejected

- **Filtering after generation.** It spends budget on draws that are thrown away,
  and Hypothesis gives up on a strategy it must filter too much.
- **One reading for both.** A strict generator offers `" 7"` as an invalid
  integer, and a lenient server accepts it: a false finding. A lenient oracle
  excuses whatever any server would read.

### Consequences

A path string with no length or `enum` constraint has no invalid candidate, nor
does an optional query or header string without one, so its zone plans no invalid
phase on its account. A pattern or a format
alone is not a candidate: producing a text that breaks an arbitrary pattern is not
attempted. A body sent as a form is generated and judged on a text wire.

---

## ADR-121 — The spec's default and examples seed the valid phase at a fixed share { #adr-121 }

**Status:** accepted · Supersedes [ADR-012](models.md#adr-012) · Superseded in part by [ADR-126](#adr-126) · `models/schema.py`, `models/contracts/strategies/base.py`, `models/contracts/normalization.py`, `strategy_compiler/fields/schema_view.py`, `strategy_compiler/fields/default/valid.py`, `strategy_compiler/constants.py`; kernel `specforge_contracts.endpoint`; `contract_assembly/fusion/vocabulary.py`

### Context

A schema's `default` and `examples` are values the API's author asserts are
valid: the sort order a list takes when none is given, an id that exists, a
realistic date. A valid phase that draws only from the constraints rarely reaches
them, and they are the values most likely to pass the parser and reach the
endpoint's logic.

### Decision

**The contract carries the spec's samples.** The kernel's `SchemaProperty` and
`BaseStrategyContract` carry `default` and `examples`; `SchemaKeyword` gains
`default`, `examples` and `example`; every type allows them; fusion keeps them
beside an `enum`. The dialect folds `example` into `examples`
([ADR-112](models.md#adr-112)), and the core adds a parameter's own `example` and
its `examples` entries' `value`s.

**`SchemaView.seeds` is the declared order, each value once.** The `default`
first, then the `examples`, deduplicated by `same_seed`.

**A fixed share of valid draws is a seed.** `build_valid_strategy` is a weighted
union with no hidden weights: a roll in `0..99` below `SEED_SHARE_PERCENT` (20)
draws a copy of one seed, any other roll draws from the schema. A field with no
seeds draws from the schema alone.

**Seeds are trusted as written.** They are not filtered through the schema: a
seed is an assertion of the spec, and a seed the schema rejects is a contradiction
the server is entitled to answer.

**Only the phases that send benign values seed.** `attack`, `mutation` and
`semantic` reuse the valid builder and inherit the seeds. `boundary` and `invalid`
fall back to `build_unseeded_valid_strategy` where they draw a valid value.

### Rejected

- **Seeds only as explicit `@example`s.** Each would be sent once and never again.
- **A seed weight per field.** A knob no producer has a value for.

### Consequences

About one valid draw in five of a seeded field is a value the spec named. The
documentation schema and the `hypothesis-jsonschema` fallback see `default` and
`examples` as the annotations they are.

---

## ADR-124 — Poisoning is a property of the registered phase { #adr-124 }

**Status:** accepted · Superseded in part by [ADR-126](#adr-126) · `strategy_compiler/fields/registry.py`, `strategy_compiler/fields/builtin.py`, `strategy_compiler/fields/poisoning.py`, `strategy_compiler/zone.py`, `strategy_compiler/body.py`, `strategy_compiler/compiler.py`, `models/runtime/engine_input.py`, `runtime/fuzzers/phases.py`

### Context

Poisoning has two halves. The compiler must know which values a field can be
poisoned with in a phase, and the runtime must know whether a phase draws one zone
poisoned and the rest valid. If the first lives in a compiler table and the second
in a runtime constant, a new phase poisons only after both are edited, and the
runtime reads a list the compiler never saw.

### Decision

**A phase declares its candidates where it is registered.**
`GenerationPhase.candidates` is a `CandidateSource | None`: given a contract and
its context, the strategy over the values the field could be poisoned with, or
`None` when it has none. It resolves by MRO, like `build`. A phase with candidates
poisons; one without never does.

**The candidates decide; the build poisons.** `poisoning_strategy(contract, phase,
context=...)` asks the phase's candidates whether the field can be poisoned and,
when it can, compiles the field with the phase's `build`. One source of truth
decides both whether a field is poisonable and what it is poisoned with.

**The compiled output says which phases poison.** Each `CompiledRequestPart`
carries `poisoning_phases`, the phases whose strategy poisons one of its fields
per draw, always a subset of the phases it compiled.
`CompiledEndpointStrategies.poisoning_phases` holds the phases the endpoint's
contract type poisons. The runtime reads those sets and never the registry: a
poisoning phase that no zone can poison is not drawn.

The built-in `boundary` and `invalid` phases register `boundary_candidates` and
`invalid_candidates`; `valid`, `attack`, `mutation` and `semantic` register none.

### Rejected

- **A constant of poisoning phases in the runtime.** A second source of truth the
  compiler cannot see.
- **The runtime asking the registry.** The runtime consumes the `EngineInput`
  alone ([ADR-014](api.md#adr-014)).

### Consequences

A new poisoning phase is one registration with its candidates. An endpoint with
no poisonable field plans no boundary or invalid pass, and the budget those
phases would have spent stays unspent.

---

## ADR-126 — `attack` is a poisoning phase over any contract, and its candidate is the poison { #adr-126 }

**Status:** accepted · Supersedes in part [ADR-124](#adr-124), [ADR-121](#adr-121) · `strategy_compiler/fields/registry.py`, `strategy_compiler/fields/poisoning.py`, `strategy_compiler/fields/builtin.py`, `strategy_compiler/fields/attack/builders.py`, `strategy_compiler/parameter.py`, `strategy_compiler/zone.py`, `strategy_compiler/body.py`, `runtime/payload.py`

### Context

`attack` drew attack payloads only for a field whose contract was a
`HackerStrategyContract`, which a field becomes when the producer hints it. A
plain field under the `security` profile compiled `attack` with the valid builder,
so a run without an inferred contract sent valid requests in its attack pass and
could find nothing an attack finds. Where it did attack, every field of the
request was hostile at once, and a finding could not be pinned on any of them.

### Decision

**`attack` registers candidates on the base contract and on the hacker one.**
`(BaseStrategyContract, attack)` registers `base_attack_candidates` and
`(HackerStrategyContract, attack)` registers `hacker_attack_candidates`. `attack`
is therefore a poisoning phase like `boundary` and `invalid`: each request
attacks one field and draws every other one valid, and its intent names that
field ([ADR-116](engine.md#adr-116)). Focus, the reserved-header rule and the
shrink apply to it unchanged.

**The candidate is the poison.** A `CandidateSource` draws `PoisonCandidate(value,
attack_family)`. `poisoning_strategy` returns the phase's candidates, and the zone
or body compiler unwraps the drawn candidate into the field's value and the
`ZoneDraw`'s `attack_family`. `boundary` and `invalid` register their value
sources through the `untagged(source)` adapter, which wraps each value as a
candidate of no family, so their modules and the values they draw do not change.

**`build` still draws bare values.** `build_base_attack` is the candidates mapped
to their values, or the valid strategy when no candidate fits the field. A phase's
`build` is what `compile_parameter` and the recursive builders call, so it never
yields a wrapper.

### Rejected

- **Poisoning in a refiner after the draw.** The shrink rebuilds the pass's
  strategy from the compiled parts and would never see the poison.
- **Wrapping only the attack values, and telling the two shapes apart where the
  draw is built.** One channel would carry two shapes.
- **Keeping "the candidates decide, the build poisons".** The family of a drawn
  value is known only where the value is chosen; drawing the build again loses it.

### Consequences

The `security` profile attacks every string field with family-tagged payloads
whether or not a producer ran; the producer narrows and tunes the attack, it does
not enable it. A field outside the endpoint's `focus_fields` is never the
attacked one. The fields `attack` leaves valid draw from the valid builder, seeds
included.

---

## ADR-127 — The attack payloads live in a package any contract uses, with default families per type { #adr-127 }

**Status:** accepted · Superseded in part by [ADR-156](strategies.md#adr-156) · `strategy_compiler/fields/attack/`, `strategy_compiler/fields/security.py`, `strategy_compiler/constants.py`; `tests/strategy_compiler/fields/test_layering.py`

### Context

The payload pools and the per-type payload builders lived in the hacker layer and
read the hacker contract's toggles. Once `attack` serves any contract
([ADR-126](#adr-126)), the generic machinery cannot live in the layer that tunes
it, nor in `default/`, which is the valid, boundary and invalid phases. A plain
field also needs families of its own: it carries no `attack_profiles`.

### Decision

**`fields/attack/` is a peer package.** It holds the pools by `AttackFamily`
(`tables.py`), the base payloads per `SchemaType` and the toggle families
(`payloads.py`), the pure `AttackRequest` and `AttackToggles` (`request.py`), the
shape filter and the candidate builders (`builders.py`), the first-seen
deduplication (`sampling.py`) and the mass-assignment variant
([ADR-134](#adr-134)). `fields/hacker/` keeps what belongs to the hacker contract:
`toggles_of(contract)`, the extra-fields object mutation, the `mutation` phase and
its operators, and the hacker candidates composed over the generic payloads. The
layers point one way, `hacker` → `attack` → `default`, pinned by a layering test.
(Superseded in part by [ADR-156](strategies.md#adr-156): the hacker tuning is
`fields/security.py`, the mutation phase is `fields/mutation/`, and the layers are
`security` → `mutation` → `attack` → `default`.)

**A field with no declared profiles is attacked with its type's defaults.**
`DEFAULT_ATTACK_PROFILES_BY_TYPE` maps a string to `injection`, `xss`,
`path_traversal`, `input_validation` and `information_disclosure`, an integer or a
number to `business_logic` and `resource_abuse`, and every other type to none. The
profiles the endpoint's risk and sensitivity earn (`extra_profiles`) are added
after them, deduplicated. `DEFAULT_ATTACK_TOGGLES` are the toggles an untuned
hacker contract resolves to, pinned by a test.

**Each payload carries its family.** A profile pool tags every spelling it adds
with its profile; a payload that two pools share keeps the first family it came
under. Only string payloads come from profile pools; every other payload has no
family.

### Rejected

- **The generic machinery in `hacker/`.** An attack without any hint would be
  named and housed as the hacker's, and the generic code would depend on the layer
  that tunes it.
- **An attack module inside `default/`.** It would import `hacker/` for the pools
  and close a package cycle.
- **Choosing families by field name.** A name is not a type, and a heuristic on
  names breaks on the first API that spells them differently.

### Consequences

A new attack family pool is a row of `PROFILE_STRING_PAYLOADS`; a new default
for a type is a row of `DEFAULT_ATTACK_PROFILES_BY_TYPE`. Integer and number
payloads are sent without a family label, so an oracle that gates on the family
does not see them.

---

## ADR-128 — An attack payload is sent only when it fits the field's declared shape { #adr-128 }

**Status:** accepted · Supersedes in part [ADR-111](#adr-111) · `strategy_compiler/fields/attack/builders.py`, `strategy_compiler/parameter.py`, `shared/schema_check.py`, `models/wire.py`

### Context

A payload of the wrong type, past `maxLength`, outside an `enum` or out of range
is rejected by the server's shape validation before any handler logic runs. It
spends budget, returns a 400 that tells nothing about the attack, and repeats
what `boundary` and `invalid` already test.

### Decision

**A candidate is kept only when `validate_value` accepts it for the field's
contract.** On a text wire the payload is first read as the declared type through
the strict literals (`interpret_wire_text`), so a textual attack on a numeric
query parameter is judged as the server will read it. `validate_value` lives in
`shared/`, so the compiler and the oracles share one predicate without the
compiler importing `runtime/`.

**What the predicate does not check passes.** `validate_value` holds a value to
its type, `maxLength`, `enum` and numeric range, not to a string `pattern` or
`format`; a payload that breaks a pattern is sent, which is what an attack is
for. A field with no fitting payload is not poisonable in `attack`.

**The zone filters are total.** A poisoned value a path segment cannot carry, or a
header text the client cannot frame, is filtered out per zone. Each filter accepts
any drawn object, because the shrinker may hand a filter the raw value of a
sibling branch.

### Rejected

- **Sending everything and letting the 400 sort it out.** The budget goes to shape
  errors and the security oracles read noise.
- **A list of families allowed to exceed the shape.** `resource_abuse` already
  survives exactly where there is no bound to exceed.

### Consequences

A field with a short `maxLength` never receives a long payload in `attack`; an
`enum` field receives none at all. The oversize probe of a bounded field stays
with `boundary` and `invalid`.

---

## ADR-129 — Aggressiveness is one knob: the attack share of the budget { #adr-129 }

**Status:** accepted · Superseded in part by [ADR-141](measurement.md#adr-141) · `budget/aggressiveness.py`, `strategy_compiler/planning.py`, `strategy_compiler/fields/context.py`, `strategy_compiler/fields/security.py`

### Context

`EndpointAttack.aggressiveness` had two readers. The planner grew the `attack`
share of the split with it, and the hacker attack builder mixed valid values into
attacked fields with a per-field roll weighted by it. The two pulled in opposite
directions: a low aggressiveness funded a small attack pass and then sent valid
values in part of it, so the number of attacks did not grow with the knob.

### Decision

**The planner is the only reader.** `derive_attack_split(base_split,
aggressiveness)` sets the `attack` share at 0.05 per point, capped at
`MAX_AGGRESSIVENESS` (10) points, and rescales the other phases. An endpoint
without the knob keeps its profile's split. `GenerationContext` carries no
aggressiveness, and the attack builders draw attack payloads only: with one field
attacked per request, the rest of the request is already valid.

### Rejected

- **Keeping both readers and balancing them.** The result is not monotone in the
  knob.

### Consequences

More aggressiveness always means more attacking requests, and zero means no
attack pass. The `security` profile's split keeps `attack` at 0.05 of the budget;
the `default` profile has no attack pass. (Superseded in part by
[ADR-141](measurement.md#adr-141): the measured `security` split gives `attack`
0.25.)

---

## ADR-134 — Mass assignment is a zone variant the attack phase registers, one branch per body { #adr-134 }

**Status:** accepted · Superseded in part by [ADR-181](#adr-181) · `strategy_compiler/fields/registry.py`, `strategy_compiler/fields/builtin.py`, `strategy_compiler/fields/attack/mass_assignment.py`, `strategy_compiler/zone.py`

### Context

A server that binds every key of a request body onto its model accepts
properties the contract never declared, privileged ones included. A poisoning
phase iterates the declared fields, so an undeclared key has no field to poison.
Offering each privileged key as its own variant made those variants most of the
`attack` draws and starved the declared fields.

### Decision

**A phase may register whole-zone branches.** `GenerationPhase.zone_variants` maps
a `Zone` to a `ZoneVariantSource`: given the zone's parameters, their valid
strategies and the parameters always sent, a strategy of `ZoneDraw`s, or `None`.
`zone_variants_for(phase, zone, contract_types)` resolves the distinct sources by
MRO, and a poisoning phase adds each one beside its per-field variants. A phase
with variants but no candidates does not poison, so its variants are never drawn.

**`attack` registers `mass_assignment_variant` on the body.** It draws the valid
body plus one key of `MASS_ASSIGNMENT_KEYS` the body does not declare, each with a
sentinel privileged value no real state holds by chance. The draw names that key
as the poisoned field and `auth_bypass` as its family. The key is chosen inside
one branch, so the probe costs one variant of the body's `one_of`, never one per
key. A focus list that addresses no field of the body keeps the variant away.

### Rejected

- **One variant per key.** Hypothesis flattens nested `one_of`s and draws
  uniformly; most attacks went to undeclared keys.
- **Reusing the hacker's extra-fields mutation.** It adds a generic key, not a
  plausible privileged one, and names no field.
- **A branch inside the zone compiler for `attack` on the body.** The zone
  compiler would know about one phase.

### Consequences

The `mass_assignment` oracle judges the echo ([ADR-131](engine.md#adr-131)), and a
control request confirms it ([ADR-138](engine.md#adr-138)). Only a body whose root
is an object carries the variant, and only at its top level: a key slipped beside
a wrapping object is a key the server may ignore.

---

## ADR-171 — A string named like a credential gets a usable value in `valid` when its contract says nothing else { #adr-171 }

**Status:** accepted · `strategy_compiler/constants.py`, `strategy_compiler/fields/name_conventions.py`, `strategy_compiler/parameter.py`, `strategy_compiler/fields/default/valid_collections.py`

### Context

The RealWorld Go target's OpenAPI document declares `username`, `email` and
`password` as plain strings, with no `minLength` and no `format`. The simplest
valid value is the empty string, and the first step of a stateful run sends the
simplest draw. Registration and login were answered 422 on every request, and the
stateful run stopped at its first step: nothing behind a logged-in user was ever
reached.

### Decision

**A table of name conventions.** `NAME_CONVENTIONS` maps a pattern on the field's
name to an update of its contract:

| A name matching, whole | Gets |
| --- | --- |
| `email`, `*_email`, `*-email`, `*Email` | `format: email` |
| `username`, `user_name`, `user-name` | `minLength: 1` |
| `password` | `minLength: 1` |

The match is on the whole name, so `voicemail` is not an email. Matching ignores
case, except for the camel-case suffix `Email`.

**It applies only where the contract is silent.** The update is made in the
`valid` phase only, which also compiles the off-focus fields of a poisoning phase,
and only to a string that declares no `format` beyond a display-only one, no
`pattern`, no `minLength` and no `enum`. `format: password` is display-only
(`DISPLAY_ONLY_FORMATS`): it tells a client to mask the value and constrains no
draw. Under a declared `maxLength`, the email convention is not applied, and a
minimum length only when it fits. A poisoned field is never updated.

`with_name_conventions` rewrites the contract before it is compiled, from both
places that compile a field: `compile_parameter` and the valid object builder.

The pattern is a rule table: a new convention is a new row.

### Rejected

- **A minimum length for every unconstrained string.** It changes the contract of
  fields where an empty string is valid.
- **Matching a substring of the name.** `voicemail` is not an email.
- **Treating `format: password` as a constraint.** The login would keep sending
  `""`.
- **Going past a declared `maxLength`.** The `valid` phase would violate its own
  contract, and `contract_completeness` could no longer judge it.

### Consequences

On the Go target, registration and login answer 2xx, and the stateful run goes past
its first step. The rejection on `body.user.email` turns into one on
`body.user.password`, which the server validates against a minimum length it does
not declare: a real incomplete contract.

---

## ADR-174 — Every leaf of a JSON body is poisoned, arrays at their first element, and the split is drawn in two levels { #adr-174 }

**Status:** accepted · Supersedes in part [ADR-116](engine.md#adr-116) · `strategy_compiler/fields/field_tree.py`, `strategy_compiler/poison_target.py`, `strategy_compiler/zone.py`, `strategy_compiler/body.py`, `strategy_compiler/constants.py`, `strategy_compiler/fields/generation_phase.py`, `strategy_compiler/fields/default/valid_collections.py`, `strategy_compiler/fields/default/json_identity.py`, `runtime/fuzzers/stateless/corpus_overlay.py`, `runtime/fuzzers/stateless/control_payloads.py`

### Context

A poisoning phase that poisons only top-level fields misses most JSON APIs, which
wrap their payload (`{"user": {...}}`, `{"article": {...}}`): their real fields
are never attacked on their own. `invalid` replaces the whole wrapper, `boundary`
moves every child at once and cannot say which child a finding is about, and
`attack` has nothing to offer a wrapper with required children. Measured that way
on the RealWorld Go API, no attack payload reaches a field inside a wrapper.
Arrays of objects (bulk bodies, line items) have the same blind spot one level
further down.

### Decision

**A field tree, walked in preorder.** `field_leaves` enters every declared
property, required or optional, and the element schema of an array at index `0`.
An object with properties is covered by its leaves; an array is a leaf of its own,
because its size has edges, and is also entered. `MAX_FIELD_DEPTH` (8) is a guard
against a pathological schema, not a policy: a holder at that depth is treated as
a leaf. A field declaring `enum` offers no leaves. Only the JSON body is walked:
form and multipart send an object as one text, and the parameter zones do not
nest.

**A leaf variant is the field drawn valid around its poisoned leaf.** It is built
with the valid object and array builders and a poisoned strategy at the leaf's
path, not a parallel fixed dictionary, so `minProperties`, `maxProperties`,
`minItems`, `maxItems`, `uniqueItems` and extra fields stay honoured. Every object
and array on the way is sent; an array on the way holds at least one element, and
element `0` holds the leaf. Uniqueness is compared by JSON equality. The poisoned
field is the leaf's full path.

**Two levels.** A zone draw first picks a top-level field from the same `one_of`
as a body without nesting, and then one of that field's own candidates or one of
its leaf variants (`PoisonTarget`). The second level is built inside the zone's
fixed dictionary, each branch a separate `builds`, because Hypothesis flattens
nested `one_of`s and would otherwise give each leaf the weight of a top-level
field.

**A phase trait decides whether the leaves replace the object.**
`GenerationPhase.leaves_replace_whole` is set for `boundary`, whose object
variant moves every child at once; `invalid`, `attack` and `mutation` keep the
object's own candidates beside its leaves. An array keeps its size edges in
`boundary`.

**The corpus overlay and the controls follow the path.** The overlay never
overwrites the top-level field that holds the poisoned leaf. The timeout control
restores the outermost ancestor the minimal valid payload leaves out, or else the
outermost array on the way, so it never sends an invalid request or a duplicate
element.

### Rejected

- **Poisoning the wrapper with one child changed.** The oracles and the control
  would judge the wrapper, and a finding would not say which child it is about.
- **Flattening the body in the core.** It changes what goes on the wire.
- **One flat `one_of` over every leaf of the zone.** A scalar beside a wrapper of
  ten leaves would drop from half of the draws to a tenth.
- **A depth limit as policy.** Real schemas nest past any small number; the guard
  only stops a pathological one.

### Consequences

On the Go API, the attack phase reaches the leaves of the six endpoints with a
wrapped JSON body in every repetition, and findings name `body.user.email` or
`body.0.price`. A top-level field keeps its share of the draws, and a wrapper's
share is divided among its leaves, so each leaf gets fewer requests than the
whole wrapper. A `boundary` finding on a wrapper's bound is reported on the leaf it
belongs to, and a wrapper whose leaves have no edge (only booleans) has no
`boundary` variant. There is one finding group per leaf.

---

## ADR-178 — A string bound by a `pattern` or a `format` is poisoned with named probes that provably break it { #adr-178 }

**Status:** accepted · `strategy_compiler/format_constants.py`, `strategy_compiler/fields/default/invalid.py`, `strategy_compiler/fields/default/alphabet.py`, `models/schema.py`

### Context

A string whose only constraint is a `pattern` or a `format` has no invalid value
from its length or its `enum`: the invalid phase offers over-long text, an empty
string below a minimum and text outside an `enum`, and a `date` in an optional
query parameter has none of those. Without another candidate such a field is never
poisoned, and a server that accepts a malformed date goes unnoticed.

### Decision

**Two data tables, filtered at compile time.** `SHAPE_PROBES` holds eight named
texts: a blank, `a`, `0`, `-1`, `!`, `a b`, a non-ASCII letter and a 256-character
run. `FORMAT_BREAKING_TEXTS` holds one text per `DecidableFormat` that its checker
rejects (`plainaddress`, `2024-13-45`, `%zz`, ...). A field that declares a
`pattern` or a `format` keeps the probes, and its format's breaking text, that
`first_provable_violation` says break its contract and that fit the zone's
alphabet. The survivors are drawn with `sampled_from`, beside the field's other
invalid candidates.

**Only proof counts.** A probe the predicate cannot decide is dropped, so a probe
is never a valid value labelled invalid ([ADR-176](findings.md#adr-176)).

### Rejected

- **Filtering random text by the pattern.** It fails Hypothesis's health check on
  a permissive pattern and spends draws on discarded values.
- **Generating from the pattern's complement.** It needs a regex engine the
  engine does not carry.

### Consequences

On the lab API, an optional `format: date` query parameter is poisoned, and its
acceptance of `' OR '1'='1` is an `input_validation` finding with
`expected: {"format": "date"}`. A string with neither a `pattern` nor a `format`
draws no probes, and one whose probes all fail the filter stays unpoisonable.

---

## ADR-179 — A known format is drawn within its declared length, and an endpoint is excluded only when no valid text fits { #adr-179 }

**Status:** accepted · `strategy_compiler/format_constants.py`, `strategy_compiler/fields/default/format_builders.py`, `strategy_compiler/fields/default/format_lengths.py`, `strategy_compiler/fields/default/segments.py`, `strategy_compiler/fields/default/valid_text.py`

### Context

A string with a known `format` drawn from the format's regex alone ignores its
declared `minLength` and `maxLength`: an `email` with `maxLength: 8` can be drawn
24 characters long, the `valid` phase breaks its own contract, and
`contract_completeness` cannot trust a valid draw. Filtering the regex by
length fails the health check when the declared window is narrow. A declared
`pattern` beside a known format has to be honoured too.

### Decision

**A builder per format, keyed in a table.** `FORMAT_PATTERNS` pairs each format's
regex with the lengths it draws (`FormatPattern(regex, lengths)`).
`FORMAT_BUILDERS` holds one `FormatBuilder` per format, with two operations:
`reaches(bounds)`, whether a valid text has such a length, and `within(bounds)`, a
strategy at a length that fits.

- `email`, `uri`, `ipv4`, `hostname` and `date-time` are built by parts, each part
  drawn at a length that fits; the shortest are the real minimums (`a@b.c`,
  `a:b`).
- `byte` is whole base64 groups of four characters.
- `uuid` and `date` have one fixed length and keep their regex.

When the regex's lengths lie within the declared ones, the regex is drawn as it
is; otherwise the builder is.

**Exclusion only when nothing fits.** A declared length no valid text of the
format has raises `StrategyCompilationError` (`no email text is 0 to 4 characters
long`), and the endpoint is excluded with that reason. It never falls back to plain
text.

**A pattern is the author's constraint.** A known format with a `pattern` is drawn
from the pattern, kept to texts the format's checker accepts when it can decide,
and bounded by length. A `date` with a declared range and a pattern is drawn from
the range and drops what the pattern provably misses.

### Rejected

- **Filtering the regex by length.** It fails on narrow windows and wastes draws.
- **Excluding by the regex's own window.** An `email` with `maxLength: 5` has a
  valid text (`a@b.c`); excluding it would be a limit of the engine's regex, not
  of the contract.
- **Drawing from the format and filtering by the pattern.** A specific pattern
  rejects almost every text of a format.

### Consequences

The `valid` phase keeps the declared length of every known format, so a
conforming draw is a real one. Three limits are named: the date regex knows no
calendar (`2023-02-31` can be drawn), a declared `date-time` range is drawn without
the length window, and an endpoint is excluded even when the impossible field is
optional.

---

## ADR-180 — Mutation varies one field and is judged only when the mutated value provably breaks its contract { #adr-180 }

**Status:** accepted · Supersedes in part [ADR-051](#adr-051), [ADR-156](strategies.md#adr-156) · `strategy_compiler/fields/mutation/builders.py`, `strategy_compiler/fields/generation_phase.py`, `strategy_compiler/fields/builtin.py`, `strategy_compiler/part_compile.py`, `strategy_compiler/header_sparing.py`, `strategy_compiler/zone.py`, `strategy_compiler/body.py`, `models/runtime/draw.py`, `runtime/fuzzers/stateless/corpus_overlay.py`

### Context

A mutation phase that breaks every field of a request at once, with one operator
each, cannot name any field: an operator can return a value that is still valid,
and with every field changed an oracle cannot attribute a response to any of them.
Such a phase spends its share and yields no findings of its own.

### Decision

**One field varied per request.** `mutation` registers candidates for the base
and the hacker contracts, like a poisoning phase: each request varies one field,
an object or one of its leaves, and keeps every other field valid.

**Classified after the draw.** The mutated value is read as it travels on its
wire and checked with the predicate the oracle uses (`carried_violation`,
[ADR-177](findings.md#adr-177)). `PoisonCandidate.poisons` carries the answer.
`ZoneDraw` separates `varied_field`, the field drawn outside valid values, which
the corpus overlay never overwrites, from `poisoned_field`, set only when the
value provably breaks its contract. A request whose mutation does not break it is
judged as a valid request: its signature names no field, and
`contract_completeness` can speak on it.

**Two phase traits close the edges.**

- `plain_fallback`: a zone with no field to vary keeps the plain mutation, every
  field mutated at once and nothing judged, so the phase's share is still spent.
  The fallback is a declared trait of the phase, never reached by accident.
- `spares_reserved_headers`: a header whose name is the transport's or reads as a
  credential is never mutated. It belongs to the identity, the injector would drop
  it, and `auth` and `attack` already reach it.

### Rejected

- **Filtering the draws to the violating ones.** Many operators rarely break a
  contract; the strategy becomes unsatisfiable.
- **Judging every field of every 2xx.** With every field mutated, the attribution
  is ambiguous, and a finding would blame fields the server never looked at.

### Consequences

`mutation` findings name a field and are judged by `input_validation`: on BugBank
a required query parameter dropped and accepted, on the Go API a `null` username
accepted. A mutation that stays valid surfaces `contract_completeness` findings on
leaves the server rejects though the contract allows them. The heuristic for
reserved headers is by name: a declared `x-api-key` that is not a credential of the
run is never mutated, and `invalid` and `attack` still cover it.

---

## ADR-181 — Mass assignment is slipped inside each object of the body, and never judged under an object that admits extra keys { #adr-181 }

**Status:** accepted · Supersedes in part [ADR-134](#adr-134) · `strategy_compiler/fields/attack/mass_assignment.py`, `strategy_compiler/fields/variants.py`, `strategy_compiler/fields/generation_phase.py`, `strategy_compiler/fields/field_tree.py`, `strategy_compiler/body.py`, `shared/extra_keys.py`, `runtime/oracles/security/mass_assignment.py`, `runtime/oracles/sent_value.py`, `runtime/fuzzers/stateless/control_payloads.py`

### Context

A privileged key added at the top of the body ([ADR-134](#adr-134)) misses most
servers that bind a model: a wrapped body (`{"user": {...}}`) binds from the
wrapper, so a key beside it is ignored, and a body sent as an array (a bulk
endpoint) has no top to add it to. An object whose contract allows extra keys
cannot be blamed for echoing one. On a form or multipart body the key travels as
text, and a server that parses it echoes the parsed value (`true` for the text
`true`).

### Decision

**One branch, many places.** `mass_assignment_variant` picks, inside its single
branch, the top of the body or one of its objects: every object that declares
properties and no `enum`, the elements of arrays included, on the JSON body. A body
sent as an array gets the same branch through a second registered interface,
`RootVariantSource` (`GenerationPhase.root_variant`), into the objects of its
elements. The zone and the root share the filter, the injection and the room
rule; only the holder differs. A whole-zone variant receives one parameter
object, `ZoneVariantRequest`.

**Not under an object that admits extra keys.** `holder_admits_extra_keys` is the
one definition. The generator skips such an object, the top of the body included,
and the oracle reads the holder's contract at the key's parent path and judges
nothing under one.

**Room is made, never forced.** The object's declared draw is capped one key below
`maxProperties` (`MASS_ASSIGNMENT_KEY_ROOM`); `minProperties` is never lowered,
because the control without the key would then be an invalid request. An object
with no room gets no key.

**The echo is matched as sent.** On JSON, plain equality, so a stored `true`
echoed as `1` still matches (an SQLite-backed server does that). On a form or
multipart body, the echo's text is compared with the text sent.

### Rejected

- **A root shape inside the zone request.** Every zone variant would have to check
  a shape it cannot use; a second, root-sized interface keeps each source to what
  it needs.
- **One branch per object or per key.** The variant would take most of the
  phase's draws ([ADR-134](#adr-134)).
- **Lowering `minProperties` to make room.** It makes the control invalid and
  confirms a false finding.

### Consequences

On the lab API, keys echoed from inside `user` and from the elements of a bulk
array are confirmed, and the Go API, which echoes nothing, reports none. One echo
still yields one finding per key the server accepts, so a server that binds every
key reports up to six findings for one defect at each object.
