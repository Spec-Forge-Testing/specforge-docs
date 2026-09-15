# Extension guide

The engine extends by registration, never by editing its core. There are six
extension axes, each a registry populated at import time, each with a public
`isolated()` seam so tests never patch a private dictionary.

| Axis | Add one by | Registry | Test seam |
|---|---|---|---|
| **Runner** (how a run executes) | an `ExecutionRunner` + `register_runner(...)` | `runtime/runners/registry.py` | `isolated()` + `registered_modes()` |
| **Profile** (what gets generated) | a `StrategyMode` member + `register_profile(StrategyModeProfile(...))` | `profiles/registry.py` | `isolated()` + `registered_strategy_modes()` |
| **Phase** (a generation phase) | a `GenerationPhase(name=Phase.X, ...)` + `register_phase(...)` | `strategy_compiler/fields/registry.py` | `isolated()` + `registered_phases()` |
| **Phase extension** (an extra phase that activates on a datum) | a `PhaseExtension(phase, applies, share, refiner)` + `register_phase_extension(...)` | `phase_extensions.py` | `isolated()` + `registered_phase_extensions()` |
| **Oracle** (a response check) | a class satisfying `ResponseOracle` + `register_oracle(...)` | `runtime/oracles/registry.py` | `isolated()` + `registered_oracle_names()` |
| **Chaos transport** | a factory under a new key in the transport table | `runtime/runners/resilience/transport.py` | `isolated()` |

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

Register it beside the built-ins in `runtime/runners/__init__.py`:

```python
from specforge_engine.runtime.runners import register_runner

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
from specforge_engine.models import Phase, StrategyMode, StrategyModeProfile
from specforge_engine.models.contracts import ALLOWED_FIELDS_BY_TYPE, BaseStrategyContract
from specforge_engine.profiles import register_profile

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
registered through `specforge_engine.strategy_compiler.fields`:

```python
from specforge_engine.models.phase import Phase
from specforge_engine.models.contracts import BaseStrategyContract
from specforge_engine.strategy_compiler.fields import GenerationPhase, register_phase


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

The built-in `mutation` phase is the worked example. It is meaningful only for a
hacker contract — it seeds from a valid value and applies one hostile operator —
but it must still compile for a plain field inside a hacker-mode compile. So it
is registered twice: the real builder on the hacker contract, and a valid-value
fallback on the base contract, exactly as `attack` is:

```python
from specforge_engine.models.contracts import BaseStrategyContract, HackerStrategyContract
from specforge_engine.models.phase import Phase
from specforge_engine.strategy_compiler.fields import GenerationPhase, register_phase
from specforge_engine.strategy_compiler.fields.default import build_valid_strategy
from specforge_engine.strategy_compiler.fields.hacker import build_hacker_mutation

register_phase(
    GenerationPhase(name=Phase.MUTATION, contract_type=BaseStrategyContract, build=build_valid_strategy)
)
register_phase(
    GenerationPhase(name=Phase.MUTATION, contract_type=HackerStrategyContract, build=build_hacker_mutation)
)
```

Register the base fallback whenever the new phase carries the risk of meeting a
base-contract field: without it, that field would fail to compile the moment the
phase runs. The share the phase draws from the budget is a row of the mode's
`phase_split` ([Add a profile](#add-a-profile)); it does not come from
registration.

## Add a phase extension

A phase in a profile's `phase_split` compiles for every endpoint that mode runs.
A phase that only means something for an endpoint carrying a particular datum is a
**phase extension** instead: it activates, funds itself and refines its payloads
only where the endpoint satisfies its predicate, so no endpoint spends budget on a
phase that could find nothing
([Strategy compiler](strategy-compiler.md#the-semantic-phase)). The built-in one is
`semantic`, applicable to an endpoint that declares an `input_constraint`.

A `PhaseExtension` is a frozen value object that declares, in one place, the three
things a phase extension decides:

| Field | What it decides |
|---|---|
| `phase` | the `Phase` this extension adds |
| `applies` | a predicate over the `EndpointSpec` — the endpoints that activate the phase |
| `share` | the fraction of the endpoint's budget the phase reserves (strictly between 0 and 1) |
| `refiner` | a `(strategy, endpoint) -> strategy` callable that rewrites the assembled per-field draw before it goes on the wire |

Because a phase extension spans two layers — the compiler decides *which endpoints*
draw the phase and *how much* budget it gets, and the engine *refines* its
payloads — it is wired from a composition root, `phase_extension_builtins.py`,
which the package `__init__` calls once. The built-in registration mirrors this:

```python
from specforge_engine.runtime.fuzzers.semantic import build_semantic_payloads
from specforge_engine.models.phase import Phase
from specforge_engine.phase_extensions import PhaseExtension, register_phase_extension
from specforge_engine.semantic_properties import has_input_constraint
from specforge_engine.strategy_compiler.constants import SEMANTIC_SHARE


def register_builtin_phase_extensions() -> None:
    register_phase_extension(
        PhaseExtension(
            phase=Phase.SEMANTIC,
            applies=has_input_constraint,
            share=SEMANTIC_SHARE,
            refiner=build_semantic_payloads,
        )
    )
```

The compiler's `effective_phases` and `effective_split`
(`strategy_compiler/effective_phases.py`) read the registry so the endpoints that
compile the phase are exactly the ones that fund it; the engine's `refine_for_phase`
(`runtime/fuzzers/phases.py`) reads it too, applying the extension's `refiner` to a
phase that has one and returning the assembled strategy unchanged for any other
phase. This is the seam the `semantic` phase uses to turn valid per-field draws into
inputs that break, or hold, a declared rule — a phase whose intent is a property of
the whole payload, not of any one field, lives here rather than in a per-field
builder. The refiner receives the `CompiledExecutionEndpoint`, so it can read the
endpoint's declared schemas and semantic properties.

A `PhaseExtension` validates itself at construction: a non-callable `applies` or
`refiner` raises `TypeError`, and a `share` outside `(0, 1)` raises `ValueError`,
so a half-declared extension fails loudly the moment it is built rather than
silently skewing a budget. Register the phase's per-field builders first
([Add a phase](#add-a-phase)) — the extension decides *which endpoints* draw the
phase and *how* the whole payload is refined, not *how* a single field compiles for
it.

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
explicitly in `runtime/oracles/builtin.py` — never as a side effect of importing
a runner. The nine built-ins are, in precedence order: infrastructure,
resilience, server error, access control, status code, content type, response
schema, semantic property, latency ([ADR-036](adr/engine.md#adr-036),
[ADR-048](adr/engine.md#adr-048), [ADR-050](adr/engine.md#adr-050)).

An oracle can be **dormant until it has its datum**: it registers unconditionally
but returns `CONTINUE` until the endpoint carries the input it judges. The
semantic-property oracle is the clearest example — with no business rule declared
for the endpoint it stands down and costs nothing, and it only ever speaks on a
2xx (its family lives under `runtime/oracles/semantic/`). The `access_control`
oracle is dormant the same way: it stays silent unless the auth runner hands the
context an `AccessExpectation`, so it fires in an auth run and nowhere else.
Registration is the extension point; the datum on the context decides whether the
check runs.

## Add a chaos transport

A `ChaosTransport` is a Protocol that delivers one `ChaosRequest` and reports
its outcome:

```python
class ChaosTransport(Protocol):
    async def send(self, request: ChaosRequest) -> ExecutionResult: ...
```

Register a factory under a new key with `register_transport(key, factory)` in
`runtime/runners/resilience/transport.py`.
`resolve_transport(attack.transport, orchestrator)` picks it, raising
`EngineError` for an unknown key, and nothing that dispatches an attack branches
on the attack itself. Two transports are built in: `httpx`, which routes chaos
through the run's one orchestrator client, and `raw`, a raw-socket transport
that writes the request byte for byte over `asyncio.open_connection` for
framing-level anomalies httpx corrects by design. Both take a slot from the
orchestrator's single concurrency semaphore.

An attack is a `ChaosAttack` — a `ChaosAttackName`, the transport key it rides,
and a `build(blueprint)` that yields the emissions it puts on the wire — added
to the battery with `register_attack(attack)`. Adding an attack is one data row,
not a branch: it names an existing transport key (or a new one you registered)
and the runner resolves the transport for it. The `ChaosAttackName` vocabulary is
the closed set of attacks across both the httpx and raw-socket tables.

## The `isolated()` seam in tests

Every registry exposes `isolated()`, a context manager that gives the block
its own copy of the registry and restores the prior state on exit. Tests
register a component inside it and exercise it there — they never touch the
registry's private state. The extensibility suite exercises every axis
through its public `isolated()` and `registered_*()`; that is how "extension
is a row, not an edit" stays a testable property.

```python
from specforge_engine import profiles


def test_custom_profile_is_resolvable():
    with profiles.isolated():
        profiles.register_profile(my_profile)
        assert my_profile.mode in profiles.registered_strategy_modes()
        assert profiles.profile_for(my_profile.mode) is my_profile
    # outside the block the registry is back to the built-ins
```
