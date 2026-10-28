# Spec Forge Engine — Decision records — Public API

Part of the [Spec Forge Engine decision records](index.md). Decisions about
the facade: what `run` takes, what is exported, and how input is validated at
the policy boundary.

---

## ADR-013 — `run` takes an `ExecutionMode` and per-mode options, nothing else { #adr-013 }

**Status:** accepted · `main.py`, `runtime/__init__.py`, `runtime/runners/`

### Context

There are five ways to execute: stateless, stateful, replay, performance,
resilience. A boolean flag can choose between two of them; a string that may
or may not be a mode name invites a reconciliation helper that grows with
every mode; and each mode has its own knobs, which a flat signature would have
to list one parameter at a time.

### Decision

`run(engine_input, config, mode: ExecutionMode, options=None)`. The mode
resolves a runner object from a registry; `options` is validated against that
runner's `options_type`, and `None` means the mode's defaults. The three
inputs travel together as a `RunRequest`, so a runner's signature does not
change when a mode gains a knob. Turning a string into a mode is the CLI's
job, at its own edge.

### Rejected

A `stateful=True` flag and a `mode: ExecutionMode | str` union. Also composing
modes orthogonally (stateful *and* performance in one run): no mode needs it,
and the registry makes a combined mode a new runner, not a new axis of the
signature.

### Consequences

A new mode is a runner and a registration; the dispatcher never changes. An
unknown mode is an `EngineError`.

---

## ADR-014 — The facade exports what the orchestrator names, and nothing else { #adr-014 }

**Status:** accepted · `__init__.py`

### Context

A facade that re-exports everything is not a facade. The orchestrator builds
inputs, consumes outputs, picks a mode and its options, and content-addresses
traces. It never sanitizes headers, never reads `Zone`, `Phase` or
`SchemaType`, and does need every options type — including the one for the
default mode.

### Decision

`__all__` holds: the two entry points; the input DTOs, including every type a
field of one names; the output DTOs; `ExecutionConfig`, `Identity` and the
complete `*Options` family; the five enums a consumer touches
(`ExecutionMode`, `Strategy`, `ErrorCategory`, `TruncationReason`,
`FidelityLevel`); `canonical_json`, `split_userinfo` and
`validate_replayable`; the three exception branches; and the two validation
entry points. The kernel's vocabularies are imported from
`specforge_contracts`, not from here.

### Rejected

Exporting internal helpers "in case", and leaving one options class internal
because its mode is the default. Both make the surface lie about what a
consumer needs.

### Consequences

A test pins `__all__`. Internal module paths may move without notice.

---

## ADR-015 — Endpoint validation is three ordered checks behind one verb { #adr-015 }

**Status:** accepted · `policy/validators.py`

### Context

Before compiling, an endpoint spec passes three checks: the value types, the
fields each type may carry under the chosen strategy, and the consistency
of its ranges. The orchestrator always runs them together, in that order. A
fourth check, `validate_property_field_references`, runs per semantic property
with a different signature and granularity.

### Decision

`validate_endpoint_spec(spec, *, strategy)` calls the three in order:
types, then allowed fields, then range consistency. The first `PolicyError`
wins — the exception is the short-circuit, and there is no verdict object.
The per-property check stays a separate function. The order is part of the
contract: an `EndpointExclusion.reason` reports the first failing check, so a
different order would change what the user reads.

### Rejected

Absorbing the fourth check into the same verb — it loses the per-property
call. A Chain of Responsibility over the three — three functions that already
raise need no handler objects and no verdict to pass along.

### Consequences

Two validation entry points on the facade. A test that violates two checks at
once pins which one is reported.

The decision — one ordered chain behind `validate_endpoint_spec`, first
`PolicyError` wins, the per-property check kept separate — is unchanged as the
chain grows. Two more checks have since joined it, in order after range
consistency: phase-split validation (a budget may only name phases the mode's
profile allocates), then focus-fields validation (under a strategy that plans an attack phase, a
`focus_fields` entry must address a field the endpoint declares). New checks
append to the chain; they do not change its shape.

---

## ADR-175 — A focus entry names a nested field by its path, and is checked along the whole path { #adr-175 }

**Status:** accepted · Extends [ADR-015](#adr-015) · `shared/field_addressing.py`, `strategy_compiler/parameter.py`, `strategy_compiler/fields/attack/mass_assignment.py`, `policy/validators.py`; Semantic Inference `section_attack.j2`

### Context

`attack.focus_fields` narrows the attack phase to named fields, and
`sensitive_fields` biases a field's payloads toward disclosure and auth bypass.
An entry read on its first two segments, a bare name or `zone.name`, makes
`body.article.title` reach the whole `article` object: its sibling `article.body`
is attacked as well, and the entry the producer wrote is not the field it meant.
With every leaf of a body poisoned on its own
([ADR-174](compiler.md#adr-174)), an entry can say exactly which leaf it wants.

### Decision

**One addressing rule over the whole path.** An entry is a bare top-level name or
a zone followed by a dotted path. `is_field_addressed` holds when the entry names
the field or a field that contains it; `leads_to_addressed_field` also holds for a
field that contains a named one. An entry that enters an array names the field in
every element by index `0`; a body sent as an array is entered as `body.0.price`,
as its findings spell it, or `body.$.0.price`. A bare name never reaches a nested
field.

**The named leaf carries the attack.** Under focus, a field no entry addresses
compiles `valid`. An object that holds a named leaf is compiled as the leaf's
carrier: its named leaf is attacked, the object is never attacked whole, and the
mass-assignment variant reaches only the objects on a focused path.

**The policy boundary checks the whole path.** Under a strategy that plans
`attack`, `addresses_declared_field` walks the entry through the declared
`properties` and `items`. A misspelled segment, a path through a scalar, or a key
into an array without its index is a `PolicyError`, the same error a top-level
typo raises. `sensitive_fields` is not checked: an unmatched entry there narrows
nothing.

**The prompt teaches the same paths.** The inference producer's attack section
names a nested field by its dotted path and an array element by its index.

### Rejected

- **Prefix matching on the first two segments.** It is what attacked the sibling.
- **Silently ignoring an entry that matches nothing.** Every field would move out
  of the attack phase, and a producer typo would disable the attack quietly.

### Consequences

A contract whose focus entry named a nested field through its top-level parent
keeps working, and one that names the leaf gets exactly that leaf. An entry the
endpoint does not declare at that path makes the contract unusable: the
`inference` producer falls back to the schema for that endpoint, and the `fixture`
producer stops the run. The prompt's fingerprint changes, so a cached inferred
contract is inferred once more on its endpoint's next run.
