# Architecture

The module has one-way layers. Each consumes the typed output of the previous one;
the compiler does not revalidate questionnaires and the engine does not reinterpret
contracts or strategy modes.

| Layer | Input → output | Responsibility |
|---|---|---|
| `models` | Typed DTOs | Owns contracts, endpoint metadata, budgets and results. |
| `questionnaire` | LLM template → `CompilerInput` | Builds, validates and resolves contracts. |
| `strategy_compiler` | `CompilerInput` → `EngineInput` | Compiles one strategy per HTTP zone and phase. |
| `engine` | `EngineInput` → `EngineRunResult` | Sends requests, validates responses, shrinks and deduplicates findings. |

## Contracts and compilation

`BaseStrategyContract` is the standard, closed (`extra="forbid"`) contract.
`HackerStrategyContract` adds offensive knobs but not concrete payloads. Immutable
allowed-field tables enforce the permitted LLM output by JSON Schema type.

The compiler selects `valid`, `boundary` and `invalid` phases by default; hacker
mode also enables `attack`. It compiles path, query, header and body separately and
uses a registry, so new contract types can supply a compiler through
`register_compiler` without editing core dispatch code.

## Execution

The async engine shares an `httpx.AsyncClient`, limits concurrency and retries only
transient infrastructure failures. It first explores without shrinking, then shrinks
each recorded finding sequentially and deduplicates confirmed defects. Responses are
checked for server errors, declared status/content types, response schemas and
state-transition invariants; persisted headers are sanitized.

For the full file map, algorithms, error categories and extension points, use the
[complete reference](reference.md).
