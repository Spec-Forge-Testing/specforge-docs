# Extension guide

The engine extends by registration, never by editing its core. There are six
extension axes, each a registry populated at import time, each with a public
`isolated()` seam so tests never patch a private dictionary.

| Axis | Add one by | Registry | Test seam |
|---|---|---|---|
| **Runner** (how a run executes) | an `ExecutionRunner` + `register_runner(...)` | `runtime/runners/registry.py` | `isolated()` + `registered_modes()` |
| **Profile** (what gets generated) | a `StrategyMode` member + `register_profile(StrategyModeProfile(...))` | `profiles/registry.py` | `isolated()` + `registered_strategy_modes()` |
| **Phase** (a generation phase, poisoning when it declares candidates) | a `GenerationPhase(name=Phase.X, ..., candidates=...)` + `register_phase(...)` | `strategy_compiler/fields/registry.py` | `isolated()` + `registered_phases()` |
| **Phase extension** (an extra phase that activates on a datum) | a `PhaseExtension(phase, applies, share, refiner)` + `register_phase_extension(...)` | `shared/phase_extensions.py` | `isolated()` + `registered_phase_extensions()` |
| **Oracle** (a response check) | a class satisfying `ResponseOracle` + `register_oracle(...)` | `runtime/oracles/registry.py` | `isolated()` + `registered_oracle_names()` |
| **Chaos transport** | a factory under a new key in the transport table | `runtime/runners/resilience/transport.py` | `isolated()` |

An unknown key raises a domain exception — `PolicyError` from the profile
registry, `EngineError` from the engine-side registries — never a builtin
`ValueError`.

One table is **closed** on purpose and is not a registry: the body encoders. An
encoder decides what a request carries on the wire and how the input-validation
oracle reads it back, so a new media type is a new row in
`runtime/http/body_encoders.py`, reviewed with that oracle
([Add a body encoder](#add-a-body-encoder)).

## Add a runner

An `ExecutionRunner` is a Protocol:

```python
class ExecutionRunner(Protocol):
    mode: ExecutionMode
    options_type: type[BaseModel] | None

    def run(self, request: RunRequest, orchestrator: AsyncOrchestrator) -> EngineRunResult: ...
```

Register it beside the built-ins in `runtime/runners/__init__.py`:

```python
from specforge_engine.runtime.runners import register_runner

register_runner(MyRunner())
```

If your runner reuses the shared loop, pass an `EndpointLoopSpec(fuzz_one,
evidence_of, resolve, build_stats)` to `explore_endpoints`. `evidence_of(endpoint)`
returns the `SentEvidence` — results and findings — the endpoint had produced when
its `fuzz_one` raised, so the bulkhead keeps it; a runner whose `fuzz_one` records
nothing outside its return value passes `lambda _endpoint: SentEvidence()`. If its
shape is genuinely different (like stateful, replay or resilience), write its own
loop, and wrap each endpoint's work in `guard_endpoint(endpoint_id, work,
evidence=...)` (`runtime/bulkhead.py`) so a failing endpoint is isolated as
`engine_failure` instead of taking the run down
([Engine internals](engine-internals.md#isolating-a-failing-endpoint)). The options
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
fallback on the base contract:

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

### A phase that poisons one field

A phase that registers `candidates` is a **poisoning phase**: each of its requests
draws one field from the phase and every other field valid, and the request's
intent names that field ([Requests](requests.md#one-poisoned-field-per-request)).
`candidates` is a `CandidateSource`: given the contract and its context, a
strategy of `PoisonCandidate(value, attack_family)`, or `None` when the field has
none on its wire. The drawn candidate is the poison: the compiler unwraps it into
the field's value and the request's `attack_family`. A source that draws bare
values registers through `untagged(source)`, which wraps each value as a candidate
of no family; that is how `boundary` and `invalid` register. The phase's `build`
draws bare values and is what `compile_parameter` and the recursive builders
call ([ADR-126](adr/compiler.md#adr-126)).

```python
from hypothesis import strategies as st

from specforge_engine.models.contracts import BaseStrategyContract
from specforge_engine.models.phase import Phase
from specforge_engine.models.wire import ZoneWire
from specforge_engine.strategy_compiler.fields import (
    GenerationPhase,
    SchemaView,
    register_phase,
    untagged,
)
from specforge_engine.strategy_compiler.fields.default import build_valid_strategy


def my_values(contract, *, context):
    view = SchemaView(contract)
    if view.max_length is None or context.zone_wire is ZoneWire.SEGMENT:
        return None  # nothing this phase can tell apart here
    return st.just("a" * (view.max_length * 2))


def build_my_phase(contract, *, context):
    values = my_values(contract, context=context)
    return build_valid_strategy(contract, context=context) if values is None else values


register_phase(
    GenerationPhase(
        name=Phase.MY_PHASE,
        contract_type=BaseStrategyContract,
        build=build_my_phase,
        candidates=untagged(my_values),
    )
)
```

A phase whose values belong to an attack family draws `PoisonCandidate(value,
attack_family=AttackProfile.X)` directly, as `base_attack_candidates` does; the
family then reaches the oracles through the intent
([ADR-130](adr/engine.md#adr-130)).

Nothing else changes. The compiler records the phase in each zone's
`poisoning_phases` and in the endpoint's, the runtime draws one poisonable zone
per request, and a phase no zone can poison on an endpoint is not planned there.
Read the wire from `context.zone_wire` and offer only values the wire can tell
apart from a valid one: on a text wire every value is text, and `None` is the
parameter left out ([ADR-117](adr/compiler.md#adr-117)). The input-validation
oracle then judges every 2xx to such a request against the poisoned field's
declared schema, with no change of its own.

### A whole-zone variant

A poisoning phase can add branches that are not one declared field: a body with
an undeclared key, for instance. Register a `ZoneVariantSource` per zone in
`zone_variants`. It receives the zone's parameters, their valid strategies and the
parameters always sent, and returns a strategy of `ZoneDraw`s that names its own
poisoned field, or `None` when it does not apply. The zone compiler adds it beside
the per-field variants; a focus list that addresses no field of the zone keeps it
away.

```python
from specforge_engine.models.contracts import Zone

register_phase(
    GenerationPhase(
        name=Phase.ATTACK,
        contract_type=BaseStrategyContract,
        build=build_base_attack,
        candidates=base_attack_candidates,
        zone_variants={Zone.BODY: mass_assignment_variant},
    )
)
```

A source should draw the key it adds inside one branch: every variant is one
`one_of` member, so a source that returns one branch per key would take most of
the phase's draws ([ADR-134](adr/compiler.md#adr-134)). A phase with variants but
no candidates does not poison, so its variants are never drawn.

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
from specforge_engine.shared import (
    PhaseExtension,
    has_input_constraint,
    register_phase_extension,
)
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

A string `format` is served by two tables: `FORMAT_PATTERNS` in
`strategy_compiler/constants.py` and `DATE_RANGE_STRATEGIES` in
`strategy_compiler/fields/default/formats.py`. Two ways in, by nature of
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
A numeric format (`int32`, `int64`, `float`, `double`) is not a string format:
it is a `NumericFormat` member, and a bounded one is a row of `NUMERIC_WORD_RANGE`
in `models/schema.py` ([ADR-113](adr/compiler.md#adr-113)).

## Add an attack toggle

A payload-variant toggle is three coordinated edits — the guard test fails if
any is missing:

1. **The contract.** Add an `include_*` boolean field to
   `HackerStrategyContract`.
2. **`AttackToggles`.** Add a field of the same name to the `AttackToggles`
   value object (`strategy_compiler/fields/attack/request.py`), give it a value in
   `DEFAULT_ATTACK_TOGGLES`, and read it in `toggles_of(contract)`
   (`strategy_compiler/fields/hacker/builders.py`). The pinning test asserts the
   toggle set equals the contract's `include_*` flags, so this step is not
   optional.
3. **A toggle family.** Add a row to the toggle-family table in
   `strategy_compiler/fields/attack/payloads.py`, keyed by
   `(toggle_name, SchemaType)`, whose value is the pool the toggle contributes.
   A toggle whose effect is inside a base builder (like `include_nulls`) reads
   the flag off `request.toggles` there instead.

## Add an attack profile pool

An attack profile's string payloads live in `PROFILE_STRING_PAYLOADS` in
`strategy_compiler/fields/attack/tables.py`, keyed by `AttackProfile`. Add the
`AttackProfile` member to the kernel vocabulary, then a row mapping it to its
payload tuple. The attack string builder draws that pool, each spelling tagged
with the profile as its family, whenever the profile is on the field's
`AttackRequest`. To attack every field of a type with it, add it to the type's
row of `DEFAULT_ATTACK_PROFILES_BY_TYPE`; to make an endpoint's data earn it, add
a row to `SENSITIVITY_ATTACK_PROFILES`. Both live in the compiler's `constants.py`
([ADR-127](adr/compiler.md#adr-127)).

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
a runner. The sixteen built-ins are, in precedence order: input-induced
timeout, infrastructure, resilience, server error, access control, mass
assignment, semantic property, information disclosure, sensitive data exposure,
input validation, reflected payload, contract completeness, status code, content
type, response schema, latency ([ADR-036](adr/engine.md#adr-036),
[ADR-048](adr/engine.md#adr-048), [ADR-050](adr/engine.md#adr-050),
[ADR-104](adr/engine.md#adr-104), [ADR-118](adr/engine.md#adr-118),
[ADR-131](adr/engine.md#adr-131), [ADR-143](adr/engine.md#adr-143)). A
non-terminal oracle placed early adds its violation and lets the rest judge the
same response; the fold records one finding per violated rule
([ADR-137](adr/engine.md#adr-137)), and a terminal verdict decides which later
oracles never speak. The infrastructure oracle is the only suppressor of an
unanswered request: an oracle that must judge one, such as a timeout, runs ahead
of it ([ADR-132](adr/engine.md#adr-132)).

An oracle can be **dormant until it has its datum**: it registers unconditionally
but returns `CONTINUE` until the endpoint carries the input it judges. The
semantic-property oracle is the clearest example — with no business rule declared
for the endpoint it stands down and costs nothing, and it only ever speaks on a
2xx (its family lives under `runtime/oracles/semantic/`). The `access_control`
oracle is dormant the same way: it stays silent unless the auth runner hands the
context an `AccessExpectation`, so it fires in an auth run and nowhere else.
Registration is the extension point; the datum on the context decides whether the
check runs. The input-validation oracle reads its datum off the request: it speaks
only when `context.intent` names a poisoned field. An oracle that judges what a
request was drawn to test reads `context.intent`, never the phase, and gates on
`context.intent.attack_family` when its signal depends on the payload's family.
An oracle whose signal can be the endpoint's normal behaviour also adds a row to
`CONTROL_CHECKS` (`runtime/fuzzers/stateless/control.py`): how to build the
control payload, and whether the control's response shows the same signal
([ADR-138](adr/engine.md#adr-138)).

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
a `build(blueprint)` that yields the emissions it puts on the wire, and an
`expectation` that says what the server may legitimately do to it — added to the
battery with `register_attack(attack)`. The expectation defaults to
`NOTHING_TOLERATED`, under which a dropped connection is a degradation; an attack a
server may refuse by cutting the connection (a body too large or too slow, a
request cut short) passes `DROP_IS_REJECTION` instead. A row registered by hand
looks like the built-in oversized-body one:

```python
from specforge_engine.runtime.runners.resilience.attack import (
    DROP_IS_REJECTION, ChaosAttack, ChaosAttackName,
)
from specforge_engine.runtime.runners.resilience.battery import register_attack
from specforge_engine.runtime.runners.resilience.transport import HTTPX_TRANSPORT

register_attack(
    ChaosAttack(
        name=ChaosAttackName.OVERSIZED_BODY,
        transport=HTTPX_TRANSPORT,
        build=_build_oversized_body,
        expectation=DROP_IS_REJECTION,
    )
)
```

A raw-socket builder lays out its header block with `header_lines(blueprint,
*attack_lines)`, which writes the headers httpx would send and then the attack's,
so the attack reaches the endpoint under the run's identity.

Adding an attack is one data row, not a branch: it names an existing transport key (or a new one you registered)
and the runner resolves the transport for it. The `ChaosAttackName` vocabulary is
the closed set of attacks across both the httpx and raw-socket tables.

## Add a body encoder

`BODY_ENCODERS` (`runtime/http/body_encoders.py`) is a closed table keyed by the
media type's essence (lowercased, without parameters). Every JSON media type —
`application/json` or any `+json` — resolves to the JSON encoder before the table
is read. A media type with no row makes the request an `unsendable_request`.

An encoder satisfies the `BodyEncoder` Protocol:

```python
class BodyEncoder(Protocol):
    def content_type(self, media_type: str) -> str | None: ...
    def arguments(self, body: Any, *, file_fields: frozenset[str]) -> Mapping[str, Any]: ...
    def unsendable_reason(self, body: Any, *, file_fields: frozenset[str]) -> str | None: ...
```

`content_type` is the header to send (`None` leaves it to the client, as multipart
needs for its boundary); `arguments` are the httpx body arguments; and
`unsendable_reason` says why a body cannot be encoded, never echoing a value.
Adding a media type is one new class and one new entry in the table:

```python
BODY_ENCODERS: Final[Mapping[str, BodyEncoder]] = MappingProxyType(
    {
        JSON_MEDIA_TYPE: _JSON_ENCODER,
        FORM_MEDIA_TYPE: FormEncoder(),
        MULTIPART_MEDIA_TYPE: MultipartEncoder(),
        "text/plain": PlainTextEncoder(),  # the new row
    }
)
```

Three things travel with the row. The compiler gives every body that is not JSON
the `TEXT` wire, so its invalid candidates are those a text wire tells apart; the
input-validation oracle reads such a body's fields as the text `wire_text` spells,
so the encoder must send that same text; and `None` must stay off the wire, as the
other encoders leave a `None` field out. Its tests sit in
`tests/runtime/http/test_body_encoders.py`, beside the cases that resolve an encoder
from a media type and the ones that check the `Content-Type` sent matches the
bytes written.

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
