# Custom Schemathesis — Decision records — Public API

Part of the [Custom Schemathesis decision records](index.md). Decisions about
the facade: what `run` takes, what is exported, and how input is validated at
the policy boundary.

---

## ADR-013 — `run` takes an `ExecutionMode` and per-mode options, nothing else { #adr-013 }

**Status:** accepted · `main.py`, `engine/__init__.py`, `engine/runners/`

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
(`ExecutionMode`, `StrategyMode`, `ErrorCategory`, `TruncationReason`,
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
fields each type may carry under the chosen strategy mode, and the consistency
of its ranges. The orchestrator always runs them together, in that order. A
fourth check, `validate_property_field_references`, runs per semantic property
with a different signature and granularity.

### Decision

`validate_endpoint_spec(spec, *, strategy_mode)` calls the three in order:
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
