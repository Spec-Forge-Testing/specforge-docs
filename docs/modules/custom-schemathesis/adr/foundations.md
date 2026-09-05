# Custom Schemathesis — Decision records — Foundations

Part of the [Custom Schemathesis decision records](index.md). Package-wide
decisions: how failures are typed, where shared constants live, and how a
type's name tells you its role.

---

## ADR-001 — Every domain exception descends from `CustomSchemathesisError`, none from `ValueError` { #adr-001 }

**Status:** accepted · `exceptions.py`

### Context

The engine is called by an orchestrator that also parses files, decodes JSON
and runs shell commands — all of which raise `ValueError`. A domain failure
that inherits from `ValueError` is indistinguishable, in an `except` clause,
from a typo in a config file: the caller cannot tell "the engine found its own
invariant broken" from "the user mistyped a number". `StatefulLinkError` also
has to carry the exploration that was under way when a state link broke, so
the caller can report what was found before the abort.

### Decision

One root, `CustomSchemathesisError(Exception)`. `PolicyError`,
`StrategyCompilationError` (with `EndpointCompilationError`, which carries the
`endpoint_id` and the underlying reason) and `EngineError` (with
`StatefulLinkError`) hang from it. `StatefulLinkError` takes `endpoint_id` and
`partial_exploration` as keyword arguments of its constructor and sets them
once; nothing is assigned after construction.

Expected alternatives are not exceptions: `CompilationOutcome` reports the
endpoints that did not compile, `ReplayReadiness` reports what a replay lacks.
An exception is reserved for a failure the caller cannot plan for.

### Rejected

Inheriting from `ValueError` so that callers already catching builtins keep
working. It buys silence at the cost of confusing a defect in the engine with
malformed input.

### Consequences

A consumer catches the root, or the branch it cares about, by type. No builtin
exception crosses the package boundary; a builtin that does is a bug.

---

## ADR-002 — The root `constants.py` imports nothing, and the phase splits are profile data { #adr-002 }

**Status:** accepted · `constants.py`, `profiles/builtin.py`

### Context

`constants.py` holds the engine-health numbers two or more layers read:
`DEFAULT_MAX_EXAMPLES`, `MAX_AGGRESSIVENESS`, the abort thresholds, the
status-class boundaries. The contract models need some of those numbers for
their defaults. A constant typed with `Phase` — a phase split is a
`dict[Phase, float]` — would import `models`, and `models.contracts` imports
`constants`: a cycle that runs through the package `__init__`.

### Decision

The three root leaves — `constants.py`, `exceptions.py`, `numeric.py` — import
nothing from the package. Any layer, `models/` included, may import them. The
two phase splits (`DEFAULT_PHASE_SPLIT`, `HACKER_PHASE_SPLIT`) are not shared
constants: they are the data with which `profiles/builtin.py` registers the
built-in profiles, read-only `Mapping[Phase, float]`s. They belong to a
profile, and a profile belongs to the profile registry.

### Rejected

A deferred import inside a function, or importing `Phase` from its submodule
rather than from `models`. Both hide the cycle; neither removes it, because
the package `__init__` runs regardless of which submodule is named.

### Consequences

Every stage keeps its own `constants.py` for what only it reads; only what two
or more layers share is at the root. Adding a phase split means registering a
profile, never editing a constant.

---

## ADR-003 — A type's suffix names the role it plays at the boundary { #adr-003 }

**Status:** accepted · `__init__.py`

### Context

The facade carries several families of types: things a producer or the LLM
fills in, per-mode knobs, global runtime, results with alternatives, aggregate
outputs and their components. Without a rule, one role ends up with two
suffixes and the reader has to open the class to learn which side of `run` a
type belongs to. The output family is also persisted by the orchestrator, so
its names are expensive to change.

### Decision

| Suffix | Role |
|---|---|
| `*Contract` | input filled by the producer or the LLM |
| `*Options` | per-mode knobs passed to `run(options=...)` |
| `*Config` | global runtime (`ExecutionConfig`) |
| `*Outcome`, `*Readiness` | a return with alternatives — a Result object |
| `*Result` | the aggregate output (`EngineRunResult`) |
| `*Report`, `*Stats`, `*Trace` | components of the output |

The compiler's input is an `EndpointSpec`: a specification of what to test,
not an "info" bag. `StatefulOptions` sits with `StatelessOptions`,
`PerformanceOptions` and `ReplayOptions` because all four are what `run`
receives per mode; `ExecutionConfig` and `Identity` keep their names because
they are global runtime.

### Rejected

One suffix for everything passed in (`*Config`). It would put a per-mode knob
and the global runtime in the same family, which is exactly the distinction
the reader needs.

### Consequences

Reading a name says where it goes. The output family is never renamed; the
input family can be, and the characterization goldens cover an input rename
transitively ([Testing](../testing.md)).

---

## ADR-042 — Each stage owns its constants; the root holds only what two or more layers share { #adr-042 }

**Status:** accepted · `constants.py`, `engine/**/constants.py`

### Context

[ADR-002](#adr-002) fixed that the root `constants.py` imports nothing. As the
engine grew, the question became which constants belong there at all. The retry
statuses matter only to the HTTP transport; the fingerprint cap only to the
finding grouper; the stateful phase only to the state machine. A single root
module holding every number turns into a junk drawer nobody can reason about,
and a name with one consumer at the root reads as if it were shared.

### Decision

The root `constants.py` holds **only** what two or more layers read — the
status-class thresholds, `MAX_INFRA_FAILURES`, `CONTENT_TYPE_HEADER`,
`MS_PER_SECOND`. Every stage keeps its own `constants.py` for what only it uses:
`engine/http/constants.py` for the retry policy, `engine/findings/constants.py`
for the fingerprint and percentile numbers, each fuzzer's `constants.py` for its
own thresholds. A constant with a single consumer lives in that consumer's
stage; promoting one to the root is a deliberate step that asserts a second
layer now genuinely shares it.

### Rejected

One root constants module for the whole package. It couples every layer to a
file each edit forces the others to re-read, and it hides which numbers are
truly shared behind those that merely happen to sit together.

### Consequences

A number lives next to the code that reads it; the root file is a short,
honest list of what is genuinely shared; and moving a constant to the root is
the moment to check that both layers mean the same thing by it.
