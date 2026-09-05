# Extension guide

The engine extends by registration, never by editing its core. There are five
extension axes, each a registry populated at import time, each with a public
`isolated()` seam so tests never patch a private dictionary.

| Axis | Add one by | Registry | Test seam |
|---|---|---|---|
| **Runner** (how a run executes) | an `ExecutionRunner` + `register_runner(...)` | `engine/runners/registry.py` | `isolated()` + `registered_modes()` |
| **Profile** (what gets generated) | a `StrategyMode` member + `register_profile(StrategyModeProfile(...))` | `profiles/registry.py` | `isolated()` + `registered_strategy_modes()` |
| **Phase** (a generation phase) | a `GenerationPhase(name=Phase.X, ...)` + `register_phase(...)` | `strategy_compiler/fields/registry.py` | `isolated()` + `registered_phases()` |
| **Oracle** (a response check) | a class satisfying `ResponseOracle` + `register_oracle(...)` | `engine/oracles/registry.py` | `isolated()` + `registered_oracle_names()` |
| **Chaos transport** | a factory under a new key in the transport table | `engine/runners/resilience/transport.py` | `isolated()` |

An unknown key raises a domain exception — `PolicyError` from the profile
registry, `EngineError` from the engine-side registries — never a builtin
`ValueError`.

## Add a runner

An `ExecutionRunner` is a Protocol:

```python
class ExecutionRunner(Protocol):
    mode: str
    options_type: type[BaseModel] | None

    def run(self, request: RunRequest, orchestrator: AsyncOrchestrator) -> EngineRunResult: ...
```

Register it beside the built-ins in `engine/runners/__init__.py`:

```python
from custom_schemathesis.engine.runners import register_runner

register_runner(MyRunner())
```

If your runner reuses the shared loop, pass an `EndpointLoopSpec(fuzz_one,
resolve, build_stats)` to `explore_endpoints`; if its shape is genuinely
different (like stateful, replay or resilience), write its own loop. The options
type is resolved per runner by `resolve_options(runner, options)` beside the
registry — the dispatcher never changes.

## Add a profile

A `StrategyModeProfile` is a frozen value object naming what one strategy mode
decides: its `mode`, `phase_split`, `allowed_fields_by_type`, `contract_type`
and `allow_contract_subclasses` ([Strategy compiler](strategy-compiler.md)).
The built-ins are registered in `profiles/builtin.py`. A new one is a
`StrategyMode` member plus one call:

```python
from custom_schemathesis.models import Phase, StrategyMode, StrategyModeProfile
from custom_schemathesis.models.contracts import ALLOWED_FIELDS_BY_TYPE, BaseStrategyContract
from custom_schemathesis.profiles import register_profile

register_profile(
    StrategyModeProfile(
        mode=StrategyMode.MY_MODE,  # the member you added to StrategyMode
        phase_split={Phase.VALID: 0.7, Phase.BOUNDARY: 0.3},
        allowed_fields_by_type=ALLOWED_FIELDS_BY_TYPE,
        contract_type=BaseStrategyContract,
        allow_contract_subclasses=True,
    )
)
```

Runner and profile are independent axes — they do not know about each other,
which is what keeps the engine ignorant of `StrategyMode`.

## Add a phase

A phase is a `GenerationPhase(name=Phase.X, contract_type=..., build=...)`
registered through `custom_schemathesis.strategy_compiler.fields`:

```python
from custom_schemathesis.models.phase import Phase
from custom_schemathesis.models.contracts import BaseStrategyContract
from custom_schemathesis.strategy_compiler.fields import GenerationPhase, register_phase


def build_my_phase(contract, *, context):
    ...  # -> SearchStrategy


register_phase(
    GenerationPhase(name=Phase.MY_PHASE, contract_type=BaseStrategyContract, build=build_my_phase)
)
```

The key is `(contract_type, Phase)` resolved by MRO, so a phase registered on
`HackerStrategyContract` applies to hacker contracts only and a phase registered
on `BaseStrategyContract` applies to both. Adding a `Phase` member is the first
step; the `StrEnum` keeps every enum-keyed map serializing correctly. The
`build` callable receives the `GenerationContext` only if its signature accepts
a `context` keyword — a builder that ignores the endpoint's knobs stays
one-argument. A non-callable `build` is rejected at registration.

## Add a string format

A string `format` is served by the constraint tables in
`strategy_compiler/fields/default/constraints.py`. Two ways in, by nature of
the format:

- **A pattern format.** Add a member to the `SchemaFormat` enum and a row to
  `FORMAT_PATTERNS` mapping it to a regex. `SchemaView.known_format` then
  recognizes the wire spelling and the valid-phase string builder draws from
  the regex.
- **A range-aware format.** A format whose string bounds sort in value order
  (like a date) also gets a builder in `DATE_RANGE_STRATEGIES`, keyed by the
  `SchemaFormat` member, taking `(minimum, maximum)`. A field that declares a
  bound then draws in-range values; without a bound it falls back to the regex.

A `format` the tables do not know is handed to `hypothesis-jsonschema` through
the `json_schema` fallback, so an unknown format degrades rather than failing.

## Add an attack toggle

A payload-variant toggle is three coordinated edits — the guard test fails if
any is missing:

1. **The contract.** Add an `include_*` boolean field to
   `HackerStrategyContract`.
2. **`AttackToggles`.** Add a field of the same name to the `AttackToggles`
   value object and read it in `from_contract`. The pinning test asserts the
   toggle set equals the contract's `include_*` flags, so this step is not
   optional.
3. **A toggle family.** Add a row to the toggle-family table in
   `strategy_compiler/fields/hacker/payloads.py`, keyed by
   `(toggle_name, SchemaType)`, whose value is the pool the toggle contributes.
   A toggle whose effect is inside a base builder (like `include_nulls`) reads
   the flag off `request.toggles` there instead.

## Add an attack profile pool

An attack profile's string payloads live in `PROFILE_STRING_PAYLOADS` in
`strategy_compiler/fields/hacker/tables.py`, keyed by `AttackProfile`. Add the
`AttackProfile` member to the kernel vocabulary, then a row mapping it to its
payload tuple. The hacker string builder draws that pool whenever the profile
is on the field's `AttackRequest`. To make an endpoint's data earn the profile
automatically, add a row to `SENSITIVITY_ATTACK_PROFILES` in the compiler's
`constants.py`.

## Add an oracle

A `ResponseOracle` is a Protocol:

```python
class ResponseOracle(Protocol):
    name: str
    order: OraclePrecedence

    def check(self, context: ResponseContext) -> OracleVerdict: ...
```

`OraclePrecedence` is an `IntEnum`, so precedence is a named value, not a magic
gap. Oracles run as a Chain of Responsibility: the first terminal verdict
short-circuits, non-terminal ones continue. All built-ins are registered
explicitly in `engine/oracles/builtin.py` — never as a side effect of importing
a runner. The seven built-ins are, in precedence order: infrastructure,
resilience, server error, status code, content type, response schema, latency
([ADR-036](adr/engine.md#adr-036)).

## Add a chaos transport

A `ChaosTransport` is a Protocol that delivers one `ChaosRequest` and reports
its outcome:

```python
class ChaosTransport(Protocol):
    async def send(self, request: ChaosRequest) -> ExecutionResult: ...
```

Register a factory under a new key with `register_transport(key, factory)` in
`engine/runners/resilience/transport.py`.
`resolve_transport(attack.transport, orchestrator)` picks it, raising
`EngineError` for an unknown key; a new attack in `LEVEL_1_ATTACKS` references
its transport by that key, and nothing that dispatches an attack branches on the
attack itself. The built-in `httpx` transport routes chaos through the run's one
orchestrator client.

## The `isolated()` seam in tests

Every registry exposes `isolated()`, a context manager that gives the block
its own copy of the registry and restores the prior state on exit. Tests
register a component inside it and exercise it there — they never touch the
registry's private state. The extensibility suite exercises every axis
through its public `isolated()` and `registered_*()`; that is how "extension
is a row, not an edit" stays a testable property.

```python
from custom_schemathesis import profiles


def test_custom_profile_is_resolvable():
    with profiles.isolated():
        profiles.register_profile(my_profile)
        assert my_profile.mode in profiles.registered_strategy_modes()
        assert profiles.profile_for(my_profile.mode) is my_profile
    # outside the block the registry is back to the built-ins
```
