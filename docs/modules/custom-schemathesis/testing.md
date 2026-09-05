# Testing `custom_schemathesis`

The suite freezes the engine's observable behaviour: what a contract compiles
to, what a replay returns, which enums serialize how, and that every extension
axis accepts a new row through its public seam. A behaviour change is only ever
an explicit, reviewed change to one of these.

| Element | What it pins | Where |
|---|---|---|
| **Unit suite** | each function behaves as specified, in isolation | `tests/`, mirroring `src/` |
| **Characterization goldens** | the compiled output and the replay projection, field by field | seven goldens in `tests/characterization/golden/*.json` (6 compiler + 1 replay), plus `tests/characterization/fixtures/replay_trace.json` |
| **Projection guard** | the goldens' projection rules: enum keys stringify to their wire value, a strategy map collapses to its sorted keys | `tests/characterization/test_projection_guard.py` |
| **Enum contract** | every vocabulary enum is a `StrEnum` whose `str()` is its `.value` | `tests/models/test_enum_contract.py` |
| **Extensibility suite** | the five registry axes each accept a new row via `isolated()` + `registered_*()`: a phase, a re-pointed strategy-mode profile, an oracle, a runner (a new mode driven end to end through the facade) and a chaos transport | `tests/test_extensibility_gate.py` |
| **Public-surface guard** | `custom_schemathesis.__all__` equals a frozen list written out in the test — adding or removing an export fails it by name; every export resolves, internal helpers such as `sanitize_headers` stay unexported, `EndpointRisk`/`EndpointAttack` are the kernel classes from `specforge_contracts`, and the `StatefulOptions` field reserve (`max_examples`, `step_count`, `max_distinct_bugs`) round-trips through `model_dump`/`model_validate` because the orchestrator persists that dump | `tests/test_public_api.py` |
| **Entry-point surface** | `main.__all__` lists exactly the two entry points, each importable and callable, and `compile` never hides the builtin | `tests/test_main.py` |
| **Field-consumer guard** | every field of the 17 contract models exported by `models.contracts` (derived from its `__all__`) is either registered against the module that reads it or excepted with a written reason; an unregistered field, a stale entry for a removed field, or a blank justification fails the suite | `tests/models/contracts/test_field_consumers.py` |
| **Toggle-field guard** | every attack toggle maps to a contract include-flag, so no knob is dead | `tests/strategy_compiler/fields/hacker/test_request.py`, `test_payloads.py` |
| **Fixtures API** | a small versioned API with known defects, for end-to-end runs | `tests/support/fixtures_api/` |

## Running it

Install and container commands are in
[Development & Testing](../../developer-guide/contributing.md#test-a-compose-module).
Locally, from the package directory:

```bash
cd lib/custom_schemathesis
python -m pytest -q                                  # full suite, coverage gate at 75%
python -m pytest tests/characterization -q           # goldens only
```

Async tests need no marker (`asyncio_mode = "auto"`). Engine tests that make
real HTTP calls set `settings(deadline=None)` so load does not trip
Hypothesis's deadline.

The fixtures API serves on `http://localhost:8000` with `poe demo` from the
repository root. Each endpoint exists to reproduce one class of defect —
missing ownership checks, fixed and load-dependent latency, an unhandled
crash on a partial body, and a control endpoint that flips every route to 500
on demand. Three API keys are built in: `alice-key`, `bob-key` and
`root-key` (admin).

## The goldens

The characterization files are a Golden Master over the compiler and engine
boundary. Neither subject can be dumped with `model_dump()` alone — the
compiled output carries live Hypothesis `SearchStrategy` objects and mixes
plain dataclasses with pydantic models — so `project` walks both shapes
uniformly: a field added to either lands in the golden on its own, and a
mapping whose values are all strategies collapses to the sorted list of its
keys. Comparison is on parsed JSON, so a CRLF checkout stays green.

A golden is never rewritten silently. Update it deliberately, then review the
diff before committing:

```bash
SPECFORGE_UPDATE_GOLDENS=1 python -m pytest tests/characterization -q
```

A golden going red is either a real behaviour change (fix the code) or an
intended one (update the file, and explain why in the commit).

## What the goldens do not see

- They project by field name and enum `.value`: a renamed output field or a
  changed `.value` is invisible until it breaks a consumer. That is why output
  DTOs and output-enum values are never renamed
  ([ADR-003](adr/foundations.md#adr-003)).
- Input-side shapes (`EndpointSpec`, `RequestZones`) are covered only
  transitively: if the compiled output is unchanged, the input change did not
  change the logic. `StatefulOptions` crosses the input/output line — the
  orchestrator persists it — so its field set is pinned by its own test in
  `tests/models/engine/test_options.py`, including a `model_validate(model_dump())`
  round-trip, and re-asserted at the facade by the public-surface guard.
- A projection that collapses strategies to sorted keys does not see which
  bytes a strategy generates. The drawn values are pinned by the replay trace
  and the end-to-end runs against the fixtures API, not by the compiler
  goldens alone.
