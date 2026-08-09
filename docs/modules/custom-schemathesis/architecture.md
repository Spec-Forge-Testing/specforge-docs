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

Everything a strategy mode decides lives in a **`StrategyModeProfile`**: which phases
compile, how examples split across them, which contract fields are legal, and which
contract type the mode accepts. The default profile compiles `valid`, `boundary` and
`invalid`; the hacker profile adds `attack`. The compiler asks the profile instead of
branching on the mode, so a new mode is a `register_profile` call, not an edit.

The compiler compiles path, query, header and body separately, and a second registry
lets new contract types supply their own compiler through `register_compiler`.

## Execution

A run names its **execution mode**, and the entry point resolves the runner registered
for it rather than choosing between hardcoded paths. A runner owns the whole procedure,
including which fuzzer it drives and how it aggregates statistics — modes differ by more
than their fuzzer, since the stateless one explores and then shrinks in two separate
phases while the stateful one minimizes as it goes. Two modes ship today; adding one is
a `register_runner` call.

That is the second of two independent extensibility axes. The runner registry answers
*how a run executes*; the strategy profile answers *what gets generated*. They never
consult each other — the engine cannot import `StrategyMode` at all.

The async engine shares an `httpx.AsyncClient`, limits concurrency and retries only
transient infrastructure failures. The entry point owns that client's lifetime, so every
mode inherits the same connection reuse and the same guaranteed close. Responses are
checked for server errors, declared status/content types, response schemas and
state-transition invariants; persisted headers are sanitized.

A run also records its **execution trace**: the ordered list of requests it actually
sent, with concrete values and the status each one returned. That is how a run is
reproduced — by re-sending the trace, never by regenerating the data — so the module
has no seed and keeps Hypothesis's example database disabled. Credentials are omitted
from the trace by origin rather than redacted, since a redacted trace could not be
replayed.

For the full file map, algorithms, error categories and extension points, use the
[complete reference](reference.md). The strategy compiler's internals — every
builder function behind `default/` and `hacker/` — get their own page: see
[Strategy compiler internals](strategy-compiler-internals.md).
