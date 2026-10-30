# Spec Forge Engine — Decision records

Decisions taken while building `specforge_engine` that are not obvious
from reading the code, and that someone would otherwise be tempted to undo.
Each record states the situation that forced the decision, what was decided,
the alternative that was rejected, and what it costs.

They are append-only and numbered in the order they were written down. A
record is never edited to reflect a later change of mind — a new record
supersedes it.

!!! info "The rule these decisions answer to"
    **Report what was measured, never what was inferred.** Every counter has
    one producer; a flaky finding is counted where it was observed, not
    derived by subtraction; a request that never reached the wire is not
    evidence about the API. When a shortcut would make a number look better
    than what the engine actually saw, the number wins.

## How to use this section

These records explain **why** the engine works the way it does; they are not
the current API reference. Start with the [module overview](../index.md) and
reference pages for current behavior. Use the ADRs when you need the
constraints, alternatives or trade-offs behind a decision.

!!! tip "Choose a path"
    - **Understand the module:** start with the [module overview](../index.md).
    - **Find current behavior:** use the module's reference pages.
    - **Understand a design choice:** choose an area under [Where a decision
      lives](#where-a-decision-lives), then open its records.
    - **Find a specific ADR:** search the [full index](#full-index).

## Where a decision lives

The records are split one file per area, in pipeline order, plus one file for
decisions that belong to no single area. Numbers stay global and are never
reused across files — the number tells you when it was written, the file
tells you what it governs. The sequence is shared by the whole site, so a number
missing here belongs to another module:

- [ADR-064](../../contract-assembly/adr/foundations.md#adr-064) is Contract
  Assembly's.
- [ADR-125](../../core/adr/core.md#adr-125), how the report labels
  `input_validation` and `engine_failure`;
  [ADR-139](../../core/adr/core.md#adr-139), how it labels and ranks the security
  findings; [ADR-146](../../core/adr/core.md#adr-146), how the run's URL is
  composed; [ADR-153](../../core/adr/core.md#adr-153), how a finding's summary is
  told; [ADR-154](../../core/adr/core.md#adr-154), how a replay judges each
  recorded defect; [ADR-155](../../core/adr/protocol.md#adr-155), the strategy's
  one name and its alias; [ADR-160](../../core/adr/core.md#adr-160), presets;
  [ADR-161](../../core/adr/core.md#adr-161), how a run's examples per endpoint
  resolve; and [ADR-168](../../core/adr/core.md#adr-168), how a `DELETE`
  invalidates what it consumes and how a deleted-resource transition is derived,
  are the core's.
- [ADR-136](../../semantic-inference/adr/prompts.md#adr-136), the plausible values
  the prompt asks for, is Semantic Inference's.

| File | Area | Covers |
| --- | --- | --- |
| [foundations.md](foundations.md) | package-wide | Exceptions, the root constants, naming |
| [models.md](models.md) | models | Vocabularies, the contract package and its dialect, the boundary DTOs, field paths |
| [api.md](api.md) | facade / policy | What `run` takes, what the facade exports, how input is validated |
| [compiler.md](compiler.md) | strategy_compiler | How a field becomes a strategy, which leaves of a body are poisoned, and how mutation and mass assignment reach them |
| [engine.md](engine.md) | engine | Requests and their intent, oracles, findings, counters, runners, replay |
| [measurement.md](measurement.md) | measurement | How the default numbers are measured and set, and what an inferred contract adds |
| [findings.md](findings.md) | findings | How a finding is classified, what it observed, when a value provably breaks its contract, how findings are told apart, refuted, left unverified and redacted |
| [strategies.md](strategies.md) | strategies | What a strategy decides, the oracles it opts into, and the traits each runner declares |
| [runners.md](runners.md) | runners | How far each runner reaches: when a stateful run stops and how it tells defects apart, the stateless run corpus, refuting a whole-request rejection, the resilience base request and its confirmation, links into reserved headers |

## Full index

| | Area | Decision |
| --- | --- | --- |
| [ADR-001](foundations.md#adr-001) | package | Every domain exception descends from `SpecforgeEngineError`, none from `ValueError` |
| [ADR-002](foundations.md#adr-002) | package | The root `constants.py` imports nothing, and the phase splits are profile data |
| [ADR-003](foundations.md#adr-003) | package | A type's suffix names the role it plays at the boundary |
| [ADR-004](models.md#adr-004) | models | Closed vocabularies are `StrEnum` members, the shared ones owned by the kernel |
| [ADR-005](models.md#adr-005) | models | Generation knobs stay in the engine; only vocabularies go to the kernel |
| [ADR-006](models.md#adr-006) | models | The contract vocabulary is a sibling of the compiler and engine models |
| [ADR-007](models.md#adr-007) | models | Risk and attack travel as the kernel's own types |
| [ADR-008](models.md#adr-008) | models | The four request zones are one value object |
| [ADR-009](models.md#adr-009) | models | `EndpointSpec` keeps its endpoint-level controls flat |
| [ADR-010](models.md#adr-010) | models | `HackerStrategyContract` is a subclass, dispatched by type |
| [ADR-011](models.md#adr-011) | models | `GenerationPlan` is a frozen engine-side value that scales by replacement |
| [ADR-012](models.md#adr-012) | models | `SchemaKeyword` omits `default` |
| [ADR-013](api.md#adr-013) | facade | `run` takes an `ExecutionMode` and per-mode options, nothing else |
| [ADR-014](api.md#adr-014) | facade | The facade exports what the orchestrator names, and nothing else |
| [ADR-015](api.md#adr-015) | policy | Endpoint validation is three ordered checks behind one verb |
| [ADR-016](compiler.md#adr-016) | strategy_compiler | Field builders are functions in tables, not implementations of a Protocol |
| [ADR-017](engine.md#adr-017) | engine | `ExecutionResult` is the canonical record of a request; stats and trace are projections |
| [ADR-018](engine.md#adr-018) | engine | Flaky findings are counted where they are observed, in the shrinker |
| [ADR-019](engine.md#adr-019) | engine | Stateful runs discard flaky findings |
| [ADR-020](engine.md#adr-020) | engine | Finding resolution is a callable on the loop specification |
| [ADR-021](engine.md#adr-021) | engine | Options are resolved beside the runner registry |
| [ADR-022](engine.md#adr-022) | engine | Replay readiness is a value object the engine computes |
| [ADR-023](compiler.md#adr-023) | strategy_compiler | `SchemaView` wraps the contract, not its dump |
| [ADR-024](compiler.md#adr-024) | strategy_compiler | The generation context is always present |
| [ADR-025](compiler.md#adr-025) | strategy_compiler | Phase builders are registered explicitly |
| [ADR-026](compiler.md#adr-026) | strategy_compiler | `GenerationPhase` rejects a non-callable builder |
| [ADR-027](compiler.md#adr-027) | strategy_compiler | `AttackToggles` are explicit fields, pinned by a test |
| [ADR-028](compiler.md#adr-028) | strategy_compiler | The attack builder takes the type, defaulted by its caller |
| [ADR-029](compiler.md#adr-029) | strategy_compiler | The zone compile context does not carry the zone |
| [ADR-030](compiler.md#adr-030) | strategy_compiler | The generation plan is built directly, never mutated |
| [ADR-031](compiler.md#adr-031) | strategy_compiler | A foreign phase split is a `PolicyError`, kept where it is raised |
| [ADR-032](compiler.md#adr-032) | strategy_compiler | Compiled output carries the kernel attack contract in full |
| [ADR-033](engine.md#adr-033) | engine | A zoned payload is a value object with a body sentinel |
| [ADR-034](engine.md#adr-034) | engine | One stop signal crosses the `@given` boundary |
| [ADR-035](engine.md#adr-035) | engine | Exploration state is run-scoped; the liveness probe is shared across endpoints |
| [ADR-036](engine.md#adr-036) | engine | Oracles run as an ordered pipeline with central precedence, registered explicitly |
| [ADR-037](engine.md#adr-037) | engine | `FindingFacts` is the single subject of every crash report |
| [ADR-038](engine.md#adr-038) | engine | The stateful machine is built in a builder, and a pass ends in a closed set of outcomes |
| [ADR-039](engine.md#adr-039) | engine | A `StatefulLinkError` is reconstructed to name its endpoint, never mutated |
| [ADR-040](engine.md#adr-040) | engine | Pacing is a strategy chosen by a factory, not a flag |
| [ADR-041](engine.md#adr-041) | engine | A chaos transport is a Protocol resolved from a registry |
| [ADR-042](foundations.md#adr-042) | package | Each stage owns its constants; the root holds only what two or more layers share |
| [ADR-043](engine.md#adr-043) | engine | The shared endpoint loop is a higher-order function over a three-field spec |
| [ADR-044](engine.md#adr-044) | engine | The public findings are a closed union of outcomes; the counters stay measurements |
| [ADR-045](engine.md#adr-045) | engine | Run status is derived by the engine from the truncation reason |
| [ADR-046](engine.md#adr-046) | engine | Replay readiness separates missing URL userinfo from a host mismatch, and checks every request's host |
| [ADR-047](engine.md#adr-047) | engine | Stateful runs report flaky findings as an occurrence count |
| [ADR-048](engine.md#adr-048) | engine | Semantic properties are checked by an always-on oracle, not an execution mode |
| [ADR-049](engine.md#adr-049) | engine | A finding names the rule it broke through a generic, stable channel |
| [ADR-050](engine.md#adr-050) | engine | Access control is declared by the producer and checked by a dormant oracle woken by the auth runner |
| [ADR-051](compiler.md#adr-051) | strategy_compiler | Mutation is a generation phase over hacker contracts, seeded from the valid strategy, with engine-owned operators |
| [ADR-052](engine.md#adr-052) | engine | Raw-socket chaos transport for framing-level resilience attacks |
| [ADR-053](engine.md#adr-053) | engine | Role-restricted access is a fourth kernel policy, crossed against the roles the user's identities declare |
| [ADR-054](engine.md#adr-054) | engine | The semantic phase steers generation toward a declared input constraint |
| [ADR-055](engine.md#adr-055) | engine | A phase extension is one registered value object, and every finding names its rule |
| [ADR-056](engine.md#adr-056) | engine | A request carries its path parameters, and the shared scope ranks the path zone lowest |
| [ADR-057](engine.md#adr-057) | engine | Undecided business rules are reported as a per-endpoint diagnostic, not as findings |
| [ADR-058](engine.md#adr-058) | engine | Endpoints with declared side effects are held back by a safety guard, not fuzzed |
| [ADR-059](engine.md#adr-059) | engine | Invalid credentials are declared not fabricated, a replay stops on a dead target, and a TLS half-close is not applicable |
| [ADR-060](engine.md#adr-060) | engine | A crash report's response body is redacted by field name, and a confirmed finding's identity is fixed where it is confirmed |
| [ADR-061](engine.md#adr-061) | engine | Latency degradation under load is a concurrency ladder on the performance options, anchored on a real request |
| [ADR-062](engine.md#adr-062) | engine | The engine exposes its own typed observer and cancellation token; a listener adapts them to the protocol |
| [ADR-063](foundations.md#adr-063) | package | The engine package is `specforge_engine`, and its execution layer is `runtime/` |
| [ADR-065](engine.md#adr-065) | engine | The stateful suppression key carries the response status code, and progress ticks every executed step |
| [ADR-066](engine.md#adr-066) | engine | The stateful mode shares the liveness monitor and cuts a dead target run-wide in one streak, with the verdict carried in the outcome |
| [ADR-067](compiler.md#adr-067) | strategy_compiler | A header's text alphabet is narrowed at generation by zone, derived from what the wire carries, and an incompatible pattern falls back rather than excluding the endpoint |
| [ADR-068](engine.md#adr-068) | engine | The sequential runners detect a dead target between endpoints through a shared per-batch watch, and the monitor can abandon a probe in flight |
| [ADR-086](engine.md#adr-086) | engine | Every dispatched endpoint gets one stats row, in every mode |
| [ADR-089](engine.md#adr-089) | engine | The stateful shrink is budgeted, skips Hypothesis's explain phase, and the engine minimizes the sequence by replaying recorded requests |
| [ADR-102](engine.md#adr-102) | engine | The auth run degrades per endpoint, and fails only when it crossed nothing |
| [ADR-103](engine.md#adr-103) | engine | Findings redact the built-in sensitive names whatever the contract declares, and erase the credentials a request sent by value |
| [ADR-104](engine.md#adr-104) | engine | A broken business rule outranks the status, content-type and schema checks |
| [ADR-105](engine.md#adr-105) | engine | A connection the server drops is a crash in every mode, and drops alone never abort a live target |
| [ADR-106](engine.md#adr-106) | engine | The identity tells two findings apart only for access control |
| [ADR-107](engine.md#adr-107) | engine | Confirmed counts reconcile per endpoint and globally in every mode |
| [ADR-108](engine.md#adr-108) | engine | Resilience judges the endpoint unattacked first, and sends the battery as a real caller |
| [ADR-109](engine.md#adr-109) | engine | An echoed credential is matched in any per-character encoding a server writes |
| [ADR-110](engine.md#adr-110) | engine | A route veto reads a path as every modelled server chain does |
| [ADR-111](compiler.md#adr-111) | strategy_compiler | Numbers stay finite, and the boundary phase stays inside the declared range |
| [ADR-112](models.md#adr-112) | models | The dialect folds OpenAPI 3.0's spellings, and a numeric bound is a number or nothing |
| [ADR-113](compiler.md#adr-113) | strategy_compiler | Numbers are bounded by their declared format, and the generation word bounds only the valid phase |
| [ADR-114](compiler.md#adr-114) | strategy_compiler | Strings draw from one of three alphabets, chosen by zone and phase, and the body stays open |
| [ADR-115](compiler.md#adr-115) | strategy_compiler | Optional parameters are optional, and the minimal request is the first valid example, inside the quota |
| [ADR-116](engine.md#adr-116) | engine | A request poisons one field, and its intent travels to the oracles, the trace and the replay |
| [ADR-117](compiler.md#adr-117) | strategy_compiler | The zone's wire decides what is invalid and how the oracle reads it back |
| [ADR-118](engine.md#adr-118) | engine | A success that accepts the poisoned field outside its declared schema is an `input_validation` finding, one per field |
| [ADR-119](engine.md#adr-119) | engine | Credential headers belong to the identities and `Content-Type` to the transport |
| [ADR-120](engine.md#adr-120) | engine | An endpoint whose exploration raises is isolated as `engine_failure`, and the run goes on |
| [ADR-121](compiler.md#adr-121) | strategy_compiler | The spec's default and examples seed the valid phase at a fixed share |
| [ADR-122](models.md#adr-122) | models | The body is one root contract with one media type, encoded by a closed table |
| [ADR-123](engine.md#adr-123) | engine | Credential redaction covers one encoding layer per character over the whole echo |
| [ADR-124](compiler.md#adr-124) | strategy_compiler | Poisoning is a property of the registered phase |
| [ADR-126](compiler.md#adr-126) | strategy_compiler | `attack` is a poisoning phase over any contract, and its candidate is the poison |
| [ADR-127](compiler.md#adr-127) | strategy_compiler | The attack payloads live in a package any contract uses, with default families per type |
| [ADR-128](compiler.md#adr-128) | strategy_compiler | An attack payload is sent only when it fits the field's declared shape |
| [ADR-129](compiler.md#adr-129) | strategy_compiler | Aggressiveness is one knob: the attack share of the budget |
| [ADR-130](engine.md#adr-130) | engine | The payload family travels in the request intent |
| [ADR-131](engine.md#adr-131) | engine | Five security oracles judge a named signal anchored on the intent |
| [ADR-132](engine.md#adr-132) | engine | The oracle pipeline is the only infrastructure suppressor, and the streak counts judged failures |
| [ADR-133](engine.md#adr-133) | engine | The shrink is bulkheaded per endpoint |
| [ADR-134](compiler.md#adr-134) | strategy_compiler | Mass assignment is a zone variant the attack phase registers, one branch per body |
| [ADR-135](engine.md#adr-135) | engine | A reflected payload is judged only in an HTML response |
| [ADR-137](engine.md#adr-137) | engine | One raw finding per violated rule |
| [ADR-138](engine.md#adr-138) | engine | An intent-anchored finding is confirmed against a control request |
| [ADR-140](measurement.md#adr-140) | measurement | The engine's default numbers are set by measurement, under a decision rule written before measuring |
| [ADR-141](measurement.md#adr-141) | measurement | The default budget stays at 200, `security` spends a quarter on attacks, and `deadline_ms` is a ceiling |
| [ADR-142](engine.md#adr-142) | engine | What a pass leaves unspent goes to the next pass of the same identity, up to its own share |
| [ADR-143](engine.md#adr-143) | engine | A 400 or 422 to a request that conforms to its contract is a `contract_completeness` finding |
| [ADR-144](engine.md#adr-144) | engine | Each endpoint reports its requests, raw findings, attack families and budget by phase |
| [ADR-145](engine.md#adr-145) | engine | A load step has a fixed size, is judged against the latency its concurrency predicts, and is confirmed by measuring twice |
| [ADR-147](measurement.md#adr-147) | measurement | What the model-inferred contract adds is measured on bugs only the code shows, against a control and a hand-written ceiling |
| [ADR-148](findings.md#adr-148) | findings | One registry in the engine classifies every invariant, and the core derives the classification when it reads |
| [ADR-149](findings.md#adr-149) | findings | A verdict carries a typed observation: four slots and a location |
| [ADR-150](findings.md#adr-150) | findings | Findings are told apart by the field they poisoned and, without one, by the cause a probe confirms |
| [ADR-151](findings.md#adr-151) | findings | A finding its control request refutes is counted apart from a flaky one, and a control that gets no answer leaves it unverified |
| [ADR-152](findings.md#adr-152) | findings | Evidence is redacted by what each slot holds, against one sensitive-name rule shared with the exposure oracle |
| [ADR-156](strategies.md#adr-156) | strategies | Under `security`, the mutation phase breaks every field, not only the hinted ones |
| [ADR-157](strategies.md#adr-157) | strategies | A strategy opts into oracles, and `conformance` turns on the undeclared-field invariant |
| [ADR-158](findings.md#adr-158) | findings | Sensitive data is judged on every successful response that declares a body, and a response's own secrets are withheld from its finding |
| [ADR-159](strategies.md#adr-159) | strategies | Runners declare their traits, the effects matrix is derived from them, and `changes` is measured against `default` |
| [ADR-162](runners.md#adr-162) | runners | A stateful run continues until a pass finds nothing new, under a ceiling of 25 distinct defects |
| [ADR-163](runners.md#adr-163) | runners | A stateful defect is suppressed by its report's signature and the fields that triggered it, and a range defect widens its suppression once |
| [ADR-164](runners.md#adr-164) | runners | A shrink that fails inside Hypothesis keeps its witness, and the engine requires the Hypothesis release that shrinks narrow strings safely |
| [ADR-165](runners.md#adr-165) | runners | Stateless draws path and query values from what the run's successful responses returned, and runs producers first and deletes last |
| [ADR-166](runners.md#adr-166) | runners | A whole-request rejection is refuted only by positive proof of a state conflict |
| [ADR-167](findings.md#adr-167) | findings | A refuted finding is listed with the control that refuted it |
| [ADR-169](runners.md#adr-169) | runners | Resilience attacks a real resource of the owner with a valid base request, and sends nothing to an owner-only endpoint no valid identity can own |
| [ADR-170](runners.md#adr-170) | runners | A resilience server error is confirmed by resending its attack, and is never refuted |
| [ADR-171](compiler.md#adr-171) | strategy_compiler | A string named like a credential gets a usable value in `valid` when its contract says nothing else |
| [ADR-172](measurement.md#adr-172) | measurement | Targeted generation was measured and is not adopted |
| [ADR-173](models.md#adr-173) | models | A field is addressed by a typed path, and a top-level field keeps its plain name |
| [ADR-174](compiler.md#adr-174) | strategy_compiler | Every leaf of a JSON body is poisoned, arrays at their first element, and the split is drawn in two levels |
| [ADR-175](api.md#adr-175) | policy | A focus entry names a nested field by its path, and is checked along the whole path |
| [ADR-176](findings.md#adr-176) | findings | A value violates its contract only when the engine can prove it: patterns read as ECMA-262 under a deterministic work budget, formats only where the checker decides |
| [ADR-177](findings.md#adr-177) | findings | A violation reads a text as leniently as a server does, conformance reads it strictly, and the observation cites the text sent |
| [ADR-178](compiler.md#adr-178) | strategy_compiler | A string bound by a `pattern` or a `format` is poisoned with named probes that provably break it |
| [ADR-179](compiler.md#adr-179) | strategy_compiler | A known format is drawn within its declared length, and an endpoint is excluded only when no valid text fits |
| [ADR-180](compiler.md#adr-180) | strategy_compiler | Mutation varies one field and is judged only when the mutated value provably breaks its contract |
| [ADR-181](compiler.md#adr-181) | strategy_compiler | Mass assignment is slipped inside each object of the body, and never judged under an object that admits extra keys |
| [ADR-182](findings.md#adr-182) | findings | A finding whose control got an answer that cannot judge it is left unverified |
| [ADR-183](runners.md#adr-183) | runners | A whole-request rejection gets a second control holding the run's corpus values, sent only to refute |
| [ADR-184](runners.md#adr-184) | runners | An endpoint whose state link writes into a reserved header is left unprobed by the runners |
| [ADR-185](engine.md#adr-185) | engine | Path and header values are spelled in OpenAPI's `simple` style, each part as the query spells it |
