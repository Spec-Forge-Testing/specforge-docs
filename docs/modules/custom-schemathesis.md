# Custom Schemathesis

The pipeline's deterministic validation engine. It turns LLM-enriched endpoint
contracts into concrete Hypothesis strategies and runs them against the target API
asynchronously, in a controlled and reproducible way.

Unlike Schemathesis — which parses a generic OpenAPI contract and generates data
with Hypothesis with no further context — this module adds three differentiators:

1. **Fine-grained, type-scoped rules.** Each parameter carries an explicit contract
   with `type` and controlled constraints; the LLM can only fill in fields allowed
   for that type (`ALLOWED_FIELDS_BY_TYPE`).
2. **Adaptive budget and combinatorics reduction.** The generation space is
   estimated before compiling, split across phases (`valid`, `boundary`, `invalid`,
   `attack`), and capped with a hard ceiling to avoid combinatorial explosion.
3. **Risk-based endpoint prioritization.** Critical endpoints can carry a risk
   profile that steers fuzzing effort toward them.

## Pipeline

```
StrategyMode
    v
questionnaire.builder  ->  QuestionnaireBundle   (empty template for the LLM)
    v (LLM fills it in)
questionnaire.resolver  ->  CompilerInput          (validated contracts)
    v
strategy_compiler.compile()  ->  EngineInput        (Hypothesis strategies per zone)
    v
engine  ->  HTTP API  ->  ExecutionResult
```

## Layered architecture

### `src/models/`

The typed-contracts layer. The module's entire domain lives here — no other layer
defines its own domain models.

```
models/
  strategy_mode.py          -> StrategyMode enum (DEFAULT | HACKER)
  questionnaire/
    questionnaire.py         -> QuestionnaireBundle, QuestionnaireEndpointItem, QuestionnaireEndpointContracts
    resolved.py               -> ResolvedQuestionnaireBundle, ResolvedQuestionnaire (re-exports CombinationLimits)
    rules.py                  -> QUESTIONNAIRE_RULES_BY_MODE, DEFAULT_QUESTIONNAIRE_RULES, HACKER_QUESTIONNAIRE_RULES
  compiler/
    endpoint_info.py          -> EndpointInfo (identity + per-HTTP-zone contracts)
    compiler_input.py         -> CompilerInput (list of EndpointInfo, compiler input)
    budget.py                 -> CombinationLimits (combinatorics limits)
    contracts/
      strategies/
        base.py                -> BaseStrategyContract (standard technical contract)
        hacker.py               -> HackerStrategyContract (extends base with offensive knobs)
      endpoint_controls.py     -> EndpointRiskContract, EndpointBudgetContract
      response.py               -> ResponseContract (expected response shape per status)
      normalization.py          -> ALLOWED_FIELDS_BY_TYPE, ALLOWED_FIELDS_BY_TYPE_HACKER
      state_link.py              -> StateLinkContract, StateProduction, StateConsumption, TransitionInvariant
  engine/
    engine_input.py            -> EngineInput, CompiledExecutionEndpoint, CompiledEndpointStrategies, CompiledRequestPart
    execution.py                -> ExecutionConfig, RequestBlueprint, ExecutionResult, ErrorCategory
    crash_report.py             -> CrashReport, InvariantViolation
    results.py                   -> EngineRunResult, RunStats, EndpointStats, RawFinding
```

**Contracts (`models/compiler/contracts/`).** `BaseStrategyContract` is the root
contract: standard JSON Schema constraints (`type`, ranges, lengths, lists, objects,
`enum`, `pattern`, `nullable`, ...), with `extra="forbid"` to reject any field the
LLM shouldn't send. `HackerStrategyContract` extends it with high-level offensive
knobs — `attack_profiles`, `focus_fields`, `sensitive_fields`, `aggressiveness`,
`mutation_depth`, `invalid_input_ratio`, `include_encoded_variants`, `include_null`,
`include_unicode`, `include_control_chars` — without holding concrete payloads;
those are decided by the compiler. `EndpointRiskContract` (sensitivity/criticality)
and `EndpointBudgetContract` (generation budget and phase split) are separate models
because prioritization and example spend are independent decisions.
`ALLOWED_FIELDS_BY_TYPE`/`ALLOWED_FIELDS_BY_TYPE_HACKER` are immutable lookup tables
that define which contract fields are legal per JSON Schema type — LLM validation
depends on these tables, not scattered conditional logic.

`StateLinkContract` is the **optional** contract that enables [stateful
fuzzing](#stateful-fuzzing): declaratively, which response field to save into which
bundle (`StateProduction`), which bundle to reinject into which request zone
(`StateConsumption`), and which transition invariant to check after producing a
resource (`TransitionInvariant`). It defaults to `None` — an endpoint with no state
links fuzzes exactly as before.

**`EndpointInfo`/`CompilerInput`.** `EndpointInfo` is the per-endpoint unit: `method`,
`path_url`, `base_url`, and the four HTTP zones (`path_params`, `query_params`,
`header_params`, `body`), each a `str -> BaseStrategyContract | HackerStrategyContract`
map, plus optional `risk`/`budget`. `CompilerInput` is the questionnaire's output and
the compiler's input: a global `strategy_mode` plus a list of `EndpointInfo`. The
mode lives globally because it affects questionnaire rules, allowed contract types,
compilation, and whether attack phases activate.

**`CompiledRequestPart`/`CompiledEndpointStrategies`.** `CompiledRequestPart` is one
compiled HTTP zone: `location` (path/query/header/body), normalized `schema`, and a
ready-to-generate Hypothesis `strategy`. `CompiledEndpointStrategies` groups an
endpoint's four compiled zones.

**`EngineInput`/`CompiledExecutionEndpoint`.** `CompiledExecutionEndpoint` combines
an endpoint's execution metadata (method, path_url, base_url, risk, budget) with its
`CompiledEndpointStrategies` — the engine's unit of work — plus an optional
`state_link` that the stateful fuzzer consumes and the stateless one ignores.
`EngineInput` is the list of `CompiledExecutionEndpoint` plus global config; it's the
only input the engine needs.

### `src/questionnaire/`

The boundary layer with the outside world. Its only job is to emit a questionnaire
template for the LLM to fill in, then validate and transform the answer into a safe
`CompilerInput`. It never compiles or executes anything — the compiler only ever
receives already-validated data.

- **`builder.py`** builds the empty `QuestionnaireBundle`, selecting the right rules
  via `QUESTIONNAIRE_RULES_BY_MODE` for the given `StrategyMode` — a lookup, no
  conditional logic of its own.
- **`resolver.py`** converts the filled bundle into `CompilerInput`: validates the
  `ResolvedQuestionnaireBundle` against the global mode, coerces optional models
  (`risk`, `budget`) to their Pydantic types, checks that every contract only uses
  allowed fields, builds `EndpointInfo` per endpoint, and returns a
  `ResolvedQuestionnaire`.
- **`policy.py`** holds validation rules and budget heuristics:
  `validate_endpoint_contract_types` (every zone's contract has a `type`),
  `validate_contract_allowed_fields`/`validate_endpoint_contract_allowed_fields`
  (no field outside the type's allowed set), `estimate_parameter_space` (heuristic
  product of per-field option counts), and `compute_combination_limits` (estimates
  the space, caps it hard, and splits examples across `valid`/`boundary`/`invalid`/
  `attack`). Validation and the budget heuristic are deliberately separate: the
  first is a correctness check, the second is a tunable policy.

### `src/strategy_compiler/`

The translation layer. Takes an already-validated `CompilerInput` and produces
`EngineInput` (Hypothesis strategies, organized by zone and phase). **The compiler
makes no domain decisions** — it never re-validates contracts or reinterprets the
global mode, only translates.

```
strategy_compiler/
  compiler.py                -> orchestrator: compile(CompilerInput) -> EngineInput
  schema_compiler/
    __init__.py               -> ContractCompiler Protocol, _REGISTRY, compile_contract, register_compiler
    default/
      compiler.py              -> DefaultContractCompiler (valid / boundary / invalid; attack falls back to valid)
      phases.py                 -> build_valid_strategy, build_boundary_strategy, build_invalid_strategy
      type_strategies.py        -> valid_for_type, string_strategy, array_strategy, object_strategy, compile_for_phase
      constraints.py            -> INT_BOUNDARY, FLOAT_BOUNDARY + shared numeric helpers
    hacker/
      compiler.py                -> HackerContractCompiler (delegates to default for non-attack phases)
      builders.py                 -> build_attack_payloads, _encode_variants, mutate_object
      tables.py                    -> attack-vector string tables (pure data)
```

**`compiler.py`** is the canonical entry point, `compile(CompilerInput) -> EngineInput`.
For each `EndpointInfo`: determines the active phases from `strategy_mode` (DEFAULT:
`valid`/`boundary`/`invalid`; HACKER: + `attack`); compiles each HTTP zone
independently via `_compile_zone`; per zone, builds a
`st.fixed_dictionaries({param: compile_contract(contract, phase)})` per phase; packs
everything into `CompiledRequestPart` -> `CompiledEndpointStrategies` ->
`CompiledExecutionEndpoint`; and propagates the serialized `CombinationLimits` as
`generation_plan`. Path parameters are always forced `required=True`, regardless of
the contract.

**`schema_compiler/`** is the dispatch layer, translating a `BaseStrategyContract`
(or subclass) into a Hypothesis `SearchStrategy` via a registry:

```python
class ContractCompiler(Protocol):
    def compile_contract(self, contract: BaseStrategyContract, phase: str) -> SearchStrategy: ...
```

`_REGISTRY` is preloaded with `BaseStrategyContract -> DefaultContractCompiler` and
`HackerStrategyContract -> HackerContractCompiler`. `compile_contract(contract,
phase)` dispatches on `type(contract)`, raising `StrategyCompilationError` if
nothing is registered; `register_compiler(type, compiler)` is the public extension
API — no core file needs editing for a new contract type.

`schema_compiler/default/` handles `BaseStrategyContract` with no knowledge of
`HackerStrategyContract`. `DefaultContractCompiler` dispatches by phase to
`phases.py`: `build_valid_strategy` (correct values — `const` -> `st.just`, `enum`
-> `st.sampled_from`, a known type -> `valid_for_type`, no type ->
`fallback_from_jsonschema`; wrapped in `st.one_of(st.none(), base)` when
`nullable=True`), `build_boundary_strategy` (domain edges — integer candidates from
`integer_boundary_values(min, max)` filtered by `boundary_int_filter`; strings at
`minLength`/`maxLength` and their neighbors; arrays/objects delegate with
`phase="boundary"`), and `build_invalid_strategy` (wrong types and out-of-range
values). `attack` falls back silently to `build_valid_strategy`, since
`BaseStrategyContract` has no offensive knobs. `type_strategies.py` dispatches by
JSON Schema type (`string_strategy` picks a known-format regex, a custom `pattern`,
or `st.text`; `array_strategy`/`object_strategy` recurse via `compile_for_phase`,
which uses a deferred import of `phases.py` to break the `phases -> type_strategies
-> phases` circular dependency; `strategy_from_jsonschema` is a patchable attribute
pointing at `hypothesis_jsonschema.from_schema` when installed, used for constructs
with no native coverage like `anyOf`/`oneOf`/`$ref`/unknown `format`).
`constraints.py` holds pure numeric tables/helpers shared by `default/` and
`hacker/` (boundary and attack value tables, `minimum`/`exclusiveMinimum`
normalization, filter predicates) with no Hypothesis import.

`schema_compiler/hacker/` extends DEFAULT by adding the `attack` phase for
`HackerStrategyContract`; it depends on `default/`, never the other way around.
`HackerContractCompiler` delegates every phase except `attack` to
`DefaultContractCompiler`; for `attack`, it extracts the contract's knobs and calls
`build_attack_payloads`, which dispatches per type: strings pull from
`PROFILE_STRING_PAYLOADS[profile]` (or `GENERIC_STRING_PAYLOADS` with no declared
profile), optionally expanded via `_encode_variants` (original + URL-encoded +
Base64) and nullbytes; numbers combine `integer_attack_values()` with
`integer_boundary_values(min, max)`; booleans use a fixed list that deliberately
mixes types (`True`, `False`, `None`, `0`, `1`, `"true"`, `"false"`, `"null"`);
arrays/objects get prototype-pollution, overflow, and null mutations
(`mutate_object`, recursive up to a depth limit). `tables.py` holds twelve pure
string tables by attack vector (SQL, XSS, path traversal, SSRF, auth bypass, input
validation, deserialization, parser compat, headers/cookies, info disclosure,
resource abuse, business logic) with no Hypothesis or heavy stdlib import.

**Extending with a new contract type:** implement the `ContractCompiler` Protocol
and call `register_compiler(MyContractType, MyCompiler())` — no core file changes.

### `src/engine/`

The execution layer. Receives `EngineInput` (already-compiled strategies) and runs
async HTTP requests against the target API, validates response invariants, shrinks
every finding to its minimal reproducer, and deduplicates the reports. **The engine
knows nothing about contracts or strategy modes** — it only consumes `EngineInput`.

```
strategy_compiler.compile(CompilerInput) -> EngineInput
engine.run(EngineInput, ExecutionConfig, *, stateful=False) -> EngineRunResult
```

```
engine/
  __init__.py                 -> run(engine_input, config, *, stateful=False) -> EngineRunResult
  protocols.py                 -> FuzzStrategy, StatefulFuzzStrategy (structural Protocols)
  core/
    orchestrator.py             -> AsyncOrchestrator (persistent client, semaphore, retries)
    context_injector.py         -> ContextInjector (interpolates params, builds the URL, assembles the request)
    error_classifier.py         -> ErrorClassifier (maps responses/exceptions to ErrorCategory)
    response_validator.py       -> ResponseValidator (checks response invariants -> InvariantViolation)
    report_deduplicator.py       -> dedupe_crash_reports (collapses reports of the same defect)
    hypothesis_bridge.py         -> run_sync (runs async coroutines from Hypothesis's synchronous callbacks)
  strategies/
    async_http_fuzzer/           -> AsyncHttpFuzzer (stateless, the default)
    stateful_fuzzer/             -> StatefulFuzzer (stateful; see below)
```

Engine models live in `models/engine/`: `execution.py` (`ErrorCategory`,
`INFRA_CATEGORIES`, `ExecutionConfig`, `RequestBlueprint`, `ExecutionResult`),
`results.py` (`RawFinding`, `EndpointStats`, `RunStats`, `EngineRunResult`), plus
`engine_input.py` and `crash_report.py`. Shared constants
(`DEFAULT_MAX_EXAMPLES`, `DEFAULT_PHASE_SPLIT`, `MAX_BACKOFF_S`,
`MAX_INFRA_FAILURES`, `DEFAULT_SHRINK_MAX_EXAMPLES`) live in `src/constants.py`; the
domain exception `EngineError` lives in `src/exceptions.py`.

**Two-phase design.** Testing happens in two clearly separated phases so exploring
for bugs and minimizing them never interfere with each other:

1. **Explore** — find as many failures as possible without stopping. Hypothesis
   generates with `phases=[Phase.explicit, Phase.generate]` (no `Phase.shrink`),
   and the callback **never raises** on a violation — it records a `RawFinding` and
   keeps generating up to `max_examples`. Catching the `AssertionError` that
   `@given` would otherwise raise was ruled out: Hypothesis already shrinks
   internally before re-raising, which would take the minimization process out of
   the engine's control.
2. **Shrink** — for each `RawFinding`, `hypothesis.find(strategy, predicate)`
   searches for the minimal payload that still reproduces the failure. This runs
   **sequentially**, one finding at a time, to avoid interference from shared
   state, rate limits, or side effects; it reuses Hypothesis's own `conjecture`
   algorithm rather than reimplementing shrinking. A finding that no longer
   reproduces is discarded as flaky.

**Components:**

- **`AsyncOrchestrator`** is the engine's only point of contact with the network: a
  single shared `httpx.AsyncClient` for the whole run (reuses TCP connections,
  avoids exhausting sockets), an `asyncio.Semaphore` limiting concurrency, and
  retries limited to transient infrastructure failures (`429`/`502`/`503` and
  `ConnectTimeout`) with exponential backoff plus jitter — never `400`/`422`
  (findings) or `500` (the bug being hunted). Transport errors never escape: every
  attempt becomes an `ExecutionResult` (with `status_code=None` and a transport
  `ErrorCategory`), so one dead endpoint never aborts the run. It classifies
  results but never interprets invariants — that's `ResponseValidator`'s job.
- **`ContextInjector.build`** turns a per-zone payload (path/query/header/body)
  into an immutable `RequestBlueprint`: interpolates path params (a missing one is
  an `EngineError`), builds the absolute URL from `base_url` + `path_url`, merges
  headers (generated ones win over config), and picks the content type. A pure data
  transformation, no HTTP or Hypothesis involved.
- **`ErrorClassifier`** maps outcomes to `ErrorCategory`: 5xx -> `server_error`,
  4xx -> `client_error`, 2xx/3xx -> `None`; connect/protocol/connect-timeout
  exceptions -> `availability`, other timeouts -> `timeout`. `contract_violation` is
  never produced by the classifier — the fuzzer assigns it when
  `ResponseValidator` detects an invariant violation on an otherwise successful
  response.
- **`ResponseValidator`** checks the endpoint's declared invariants and returns the
  matching `InvariantViolation` (or `None`): `NOT_A_SERVER_ERROR` (any 5xx is a
  defect), `STATUS_CODE_CONFORMANCE` (undeclared status), `CONTENT_TYPE_CONFORMANCE`,
  `RESPONSE_SCHEMA_CONFORMANCE` (body doesn't validate against the declared schema),
  and `STATE_TRANSITION` (used by the stateful fuzzer). Infrastructure failures
  (timeouts, connection errors) never count as a violation; the body is validated
  with a pure recursive walk against `BaseStrategyContract` (no Pydantic). It also
  exposes `sanitize_headers`, redacting `Authorization`/`Cookie`/`X-Api-Key` before
  persisting anything.
- **`dedupe_crash_reports`** collapses reports that reproduce the same defect: two
  reports are the same bug if they share endpoint, method, phase, violated
  invariant, status, and minimal payload (canonicalized with sorted keys), keeping
  the order of first appearance. Deduplicating once here — instead of leaving every
  consumer to repeat it — matters for three audiences: the **auto-fixer LLM**
  (N copies of the same crash waste tokens and skew the defect ranking), **storage**
  (N rows for one defect inflates "how many bugs did this run find"), and the
  **human-facing report/CLI** ("24 crashes" reads as 24 problems when there's one).
  No information is lost: `findings_confirmed` still holds the per-finding total,
  and `findings_unique == len(crash_reports)` is the distinct-defect count.
- **`run_sync(coro)`** (the hypothesis bridge) runs an async coroutine from
  Hypothesis's synchronous callback. A single event loop lives in a daemon thread
  for the whole process, and `run_sync` blocks for the result via
  `run_coroutine_threadsafe` — an `asyncio.run()` per generated example would
  exhaust file descriptors. Both the stateless and stateful fuzzers reuse this
  bridge; the engine's tests require `settings(deadline=None)` to avoid false
  positives from latency on a stressed API.

**`AsyncHttpFuzzer`** (stateless, the default strategy) implements `FuzzStrategy` in
two steps mirroring the two-phase design: `fuzz` generates examples per phase from
the compiled `CompiledRequestPart`s, materializes each one with `ContextInjector`,
executes it via `AsyncOrchestrator`, and validates it with `ResponseValidator`,
accumulating `RawFinding`s without raising (aborting only a single endpoint after
`MAX_INFRA_FAILURES` consecutive transport failures, then moving to the next);
`shrink` re-runs each finding under `hypothesis.find` to minimize it into a
`CrashReport` (sanitized headers, status, minimal body), returning `None` for a
flaky (non-reproducing) finding. `phases.py` discovers active phases and merges
per-zone strategies; `budget.py` resolves how many examples each phase gets,
treating the compiler's `generation_plan` as authoritative over
`budget.max_examples x phase_split` and further over hardcoded defaults.

**Entry point (`__init__.py`).** `run(engine_input, config, *, stateful=False)`
opens one orchestrator for the whole run, dispatches to the stateless or stateful
path per the flag, then deduplicates confirmed reports and builds `RunStats`
(`EngineRunResult`). The stateless path explores every endpoint, collects
`RawFinding`s, and shrinks each one sequentially today — the structure allows
parallelizing exploration later without touching the signature or phase 2. The
stateful path delegates to `StatefulFuzzer.fuzz_sequence`. The HTTP client's
lifecycle and per-request stat counting are helpers shared by both paths.

## Stateful fuzzing

`StatefulFuzzer` is a **second execution strategy** added alongside
`AsyncHttpFuzzer` (stateless) **without modifying it**. Where the default fuzzer
tests each endpoint in isolation with synthetic data, the stateful one **chains
requests**: it captures real values from a response (an `id`, a token) and
reinjects them into later requests, exercising complete business flows
(`POST -> GET -> DELETE -> GET`). This catches bugs the stateless fuzzer can't see:
deleted resources that are still accessible, reads that don't reflect a prior
update, tokens that survive logout, and similar issues.

**The state-link contract.** The mapping of "what to save and where to reinject it"
is **declarative data** (`StateLinkContract`, in
`models/compiler/contracts/state_link.py`), not fuzzer-side hardcoded logic. It
travels as an **optional** field through the whole pipeline
(`QuestionnaireEndpointContracts -> EndpointInfo -> CompiledExecutionEndpoint`) —
filled in today by a fixture/spec, and in the future by `semantic_inference`'s LLM
output; the module is agnostic about who produces it.

- `StateConsumption.invalidates` — if `True`, the value is **removed** from the
  bundle on consumption (via `hypothesis.stateful.consumes`), so a deleted resource
  can't be operated on again. By default the value stays reusable (the same `id`
  can serve both `GET` and `DELETE`).
- `TransitionInvariant.echoed_fields` — beyond the status code, requires the
  follow-up probe's body to **echo** the fields sent in the triggering request
  (e.g. after `PUT {price: 10}`, a subsequent `GET` must return `price == 10`).
  Empty means only the status is checked.

**The state machine.** `state_machine.build_state_machine(...)` dynamically builds
a Hypothesis `RuleBasedStateMachine`: one `Bundle` per declared bundle name; one
`@rule()` per endpoint that injects consumed values (`bundles.inject`), executes
through the orchestrator (`run_sync`, the same async bridge), captures produced
values into their bundle (`bundles.capture`), and checks transition invariants;
`@precondition()` enforces logical ordering so nothing consumes a bundle no
endpoint has produced yet. On the first broken invariant, the rule **raises**
`StatefulViolationError`, so Hypothesis shrinks the **sequence of operations** down
to a minimal reproducer — unlike the stateless path, which collects findings and
shrinks the *payload*. `transitions.py` builds the follow-up probe by reusing
`ContextInjector`, delegates the 5xx check to the existing `ResponseValidator`, and
adds the expected-status and (if declared) `echoed_fields` comparisons
(`InvariantViolation.STATE_TRANSITION`).

**Multiple bugs per run (loop-until-dry, optional).** A rule stops at the first
failure, so by default `fuzz_sequence` makes a **single pass** (cheap: reports the
first defect). Raising `StatefulConfig.max_distinct_bugs` enables a loop: each pass
reports one defect, records its signature `(method, path, invariant)` in a
`suppressed` set, and reruns; rules log but don't re-raise signatures already seen,
so later passes surface other defects. The loop stops when a pass finds nothing new
or the configured cap is reached; each defect keeps its own shrinking.

```python
run(engine_input, config)                  # stateless (AsyncHttpFuzzer) - unchanged prior behavior
run(engine_input, config, stateful=True)   # stateful (StatefulFuzzer) - one pass (default)
run(engine_input, config, stateful=True,   # exhaustive stateful (loop-until-dry)
    stateful_config=StatefulConfig(max_distinct_bugs=10))
```

`StatefulConfig` tunes exhaustiveness: `max_distinct_bugs` (default `1`, one pass),
`max_examples` (sequences per pass), and `step_count` (max length per sequence).
`StatefulFuzzer.fuzz_sequence(endpoints, config, stateful_config)` runs the machine
and returns `(results, crash_reports)` already minimized — there's no separate
shrink phase. Reports reuse `CrashReport` with an optional `transition_sequence`
field (the steps leading up to the failure), avoiding a second report type.

**What changed in the stateless engine:** nothing — every addition is additive and
the stateless path's tests were untouched.

| Existing component | Change |
|---|---|
| `engine.run(engine_input, config)` | Accepts `*, stateful=False`; `True` runs `StatefulFuzzer`. Prior signature still works unchanged. |
| `protocols.py` (`FuzzStrategy`) | Unchanged. **Adds** `StatefulFuzzStrategy` (operates on the endpoint set, not one at a time). |
| `AsyncHttpFuzzer` | Unchanged; still the default strategy. |
| `CompiledExecutionEndpoint` / `EndpointInfo` / `QuestionnaireEndpointContracts` | New optional field `state_link` (default `None`). |
| `CrashReport` | New optional field `transition_sequence` (default `None`). |
| `InvariantViolation` | New member `STATE_TRANSITION`. |
| `ResponseValidator`, `ContextInjector`, `run_sync`, `AsyncOrchestrator` | Reused **unmodified**. |

## Facade, constants, and exceptions

**`src/main.py`** is the minimal public facade: `build_questionnaire`,
`resolve_questionnaire`, `compile_strategies`, and `run` (with its `stateful`
flag), delegating to the internal layers (`questionnaire/`, `strategy_compiler/`,
`engine/`). The real logic lives in those layers, not in the facade.

**`src/constants.py`** holds configuration shared by `policy.py`, the questionnaire,
and the engine: default example/combination limits, the combinatorial-explosion
ceiling, default phase split (`DEFAULT`: `valid` 60% / `boundary` 25% / `invalid`
15%; `HACKER` adds `attack` 5%, lowering `invalid` to 10%), orchestrator retry/backoff
parameters, the stateful fuzzer's budget (`DEFAULT_STATEFUL_MAX_EXAMPLES`,
`DEFAULT_STATEFUL_STEP_COUNT`), and base heuristics for estimating options per type.
Constants live outside the models so generation policy can be tuned without
touching contracts or validators.

**`src/exceptions.py`** defines the module's domain exceptions: `PolicyError` (a
contract, rule, or field fails the questionnaire's constraints),
`StrategyCompilationError` (a contract can't be translated into a Hypothesis
strategy), `EngineError` (an execution invariant is violated), and
`StatefulLinkError` (a state link can't be honored during stateful fuzzing;
subclasses `EngineError`). These separate business failures from generic technical
errors.

## Consolidated architectural decisions

- `strategy_mode` is global on `CompilerInput` — never repeat it per endpoint.
- The **resolved questionnaire** is the only place mode/contract-type compatibility
  is validated.
- The **compiler** receives already-validated data; it never re-normalizes or
  re-validates.
- The **engine** knows nothing about contracts — it only consumes `EngineInput`.
- The `attack` phase only activates when a field has a `HackerStrategyContract`
  **and** the global mode is `HACKER`.
- `HACKER` has its own validation rules; it does not inherit from `DEFAULT`.
- The engine uses `Protocol` for strategies, not inheritance: `FuzzStrategy`
  (stateless, per endpoint) and `StatefulFuzzStrategy` (stateful, over the whole
  set), selected via `run(..., stateful=...)`.
- `hypothesis_bridge` reuses one persistent event loop — never one per generated
  example. The stateful fuzzer reuses it as-is from inside the (synchronous)
  `RuleBasedStateMachine`.
- `StateLinkContract` is optional and additive: `state_link is None` means an
  identical stateless flow. The stateful fuzzer never infers links by heuristic —
  it only reads them from the contract.
- `extra="forbid"` on every Pydantic model — an unexpected LLM field is never
  silently dropped.
