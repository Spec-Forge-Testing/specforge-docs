# Custom Schemathesis reference

This reference records the public boundaries and implementation decisions of the
fuzzing engine. Start with the [overview](index.md) for the short version.

## Data flow

```text
StrategyMode → QuestionnaireBundle → CompilerInput → EngineInput → EngineRunResult
```

The four layers have deliberately separate responsibilities:

| Layer | Owns | Does not do |
|---|---|---|
| `models` | Typed contracts, budgets, inputs and results. | I/O or compilation. |
| `questionnaire` | LLM template and validation. | Generate strategies or send requests. |
| `strategy_compiler` | Contract → Hypothesis strategy translation. | Reinterpret validated policy. |
| `engine` | Request execution and reporting. | Know contract types or strategy mode. |

## Models and questionnaire

`BaseStrategyContract` is the closed standard contract: JSON Schema constraints,
`nullable` and `extra="forbid"`. `HackerStrategyContract` extends it with offensive
controls (`attack_profiles`, focus/sensitive fields, aggressiveness, mutation depth,
invalid-input ratio and encoded/null/unicode/control-character variants). It never
stores a payload; compilation chooses concrete values.

`ALLOWED_FIELDS_BY_TYPE` and its hacker variant are immutable type-to-field tables.
They are the single source of truth for what the LLM may set. `EndpointRiskContract`
and `EndpointBudgetContract` are independent because risk prioritization and sample
spend answer different questions.

`EndpointInfo` holds endpoint identity and contracts for the path, query, header and
body zones. `CompilerInput` is a global `StrategyMode` plus endpoint list.
`EngineInput` contains compiled endpoints and global execution configuration.

`questionnaire.builder` selects rules by mode and emits an empty
`QuestionnaireBundle`. `questionnaire.resolver` validates the completed response,
coerces optional risk/budget models, checks type and allowed fields, and produces
`CompilerInput`. `policy.py` separately validates correctness and estimates the
parameter space before it caps and divides the generation budget.

## Strategy compiler

`compile(CompilerInput) -> EngineInput` compiles each HTTP zone independently.
DEFAULT mode uses `valid`, `boundary` and `invalid`; HACKER mode adds `attack`.
Path parameters are always required. The resulting `CompiledRequestPart` objects are
grouped into `CompiledEndpointStrategies` and then `CompiledExecutionEndpoint`.

The dispatch registry maps a contract type to a `ContractCompiler`:

```python
class ContractCompiler(Protocol):
    def compile_contract(self, contract: BaseStrategyContract, phase: str) -> SearchStrategy: ...
```

`BaseStrategyContract` uses `DefaultContractCompiler`; `HackerStrategyContract`
uses `HackerContractCompiler`. A missing registration raises
`StrategyCompilationError`. To add a contract type, implement that protocol and call
`register_compiler(MyContractType, MyCompiler())`.

The default compiler handles constants, enums, native scalar/object/array strategies,
boundary values and deliberately-invalid alternatives. Unsupported JSON Schema
constructs such as `anyOf`, `oneOf`, `$ref` or unfamiliar formats can delegate to
`hypothesis_jsonschema.from_schema`. Hacker compilation delegates all non-attack
phases to the default compiler; its attack phase builds profile-based strings,
numeric extremes, mixed boolean values and recursive array/object mutations.

## Engine

```python
engine.run(engine_input, config, *, stateful=False) -> EngineRunResult
```

`AsyncOrchestrator` is the only network boundary. It owns one shared
`httpx.AsyncClient`, a concurrency semaphore and exponential-backoff retries for
transient infrastructure failures (`429`, `502`, `503`, connection timeout). Client
errors are findings, and server errors are never retried away.

| Component | Role |
|---|---|
| `ContextInjector` | Creates an immutable request blueprint from zone payloads. |
| `ErrorClassifier` | Classifies HTTP responses and transport failures. |
| `ResponseValidator` | Checks declared response and transition invariants. |
| `AsyncHttpFuzzer` | Default stateless execution strategy. |
| `StatefulFuzzer` | Executes linked endpoint sequences. |
| `dedupe_crash_reports` | Collapses reports for the same reproducible defect. |

Testing has two phases. Explore records failures without raising so generation can
continue. Then each raw finding is shrunk sequentially with `hypothesis.find`; a
finding that cannot be reproduced is discarded as flaky. Sequential shrinking avoids
shared-state, side-effect and rate-limit interference.

`ResponseValidator` checks no-server-error, declared status code, content type,
response schema and state transitions. It never counts transport failures as contract
violations. Headers such as `Authorization`, `Cookie` and `X-Api-Key` are redacted
before persistence.

Reports are equal when endpoint, method, phase, invariant, status and canonical
minimal payload match. Keeping one report prevents repeated defects from skewing the
CLI, storage statistics and auto-fixer input; aggregate counts retain total findings.

## Stateful fuzzing

`StateLinkContract` is optional. It declares a response value to save
(`StateProduction`), where to inject it later (`StateConsumption`) and a transition
invariant to verify. Endpoints without it keep the exact stateless behavior.

The compiler carries a state link to `CompiledExecutionEndpoint`; only
`StatefulFuzzer` consumes it. Stateful results can include the full request sequence
that produced a cross-endpoint finding.

## Operational constants and tests

`src/constants.py` centralizes defaults such as maximum examples, phase split,
backoff, infrastructure-failure cap and shrink budget. `EngineError` is the domain
exception. Tests should keep Hypothesis deadlines disabled when real network latency
would make them nondeterministic.

The invariants to preserve when changing the module are: validated data crosses each
boundary once; the compiler is extensible through its registry; requests use a shared
client; infrastructure failures do not abort a run; and reports never persist secrets.
