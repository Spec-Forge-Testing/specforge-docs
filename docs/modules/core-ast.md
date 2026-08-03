# Core AST

Core AST is the static-analysis engine of the pipeline. Given an API endpoint and
the repository that implements it, it finds the handler in the source code, extracts
the exact function, traces its dependencies, and packages everything into a single,
LLM-ready context bundle — **without ever executing the target code**. It relies on
[tree-sitter](https://tree-sitter.github.io/) for fast, deterministic, multi-language
parsing.

Its job is to answer one question: *"here is an endpoint and a codebase — what code
should the LLM read to understand this endpoint's behavior?"* The output feeds the
semantic inference layer, which infers the business invariants the fuzzer then tests.

It works as a pipeline of focused stages, each usable on its own:

```
EndpointDefinition ─┐
                    ├─► locator ─► ast_builder ─► extractor ─► tracer ─► quality ─► packager ─► LLMPayload
repository root  ───┘   (find)     (parse)        (cut)        (follow)  (decide)   (bundle)
```

## Installation

The package targets Python 3.11+.

```bash
pip install -e ".[dev]"
```

Seven languages load on demand (Java, C#, Ruby, PHP, Rust, Kotlin, Swift) via the
`golden-path` extra; accurate token counting uses the optional `tokens` extra
(`tiktoken`). Neither is required — the engine degrades gracefully without them.

```bash
pip install -e ".[dev,golden-path,tokens]"
```

## Quick start

One call runs the whole pipeline and returns the typed context bundle:

```python
from core_ast import build_endpoint_payload
from core_ast.models.locator import EndpointDefinition

endpoint = EndpointDefinition(path="/orders", method="post", operation_id="create_order")
payload = build_endpoint_payload(endpoint, repo_root="/path/to/api/repo")

print(payload.system_context)      # XML-tagged code block for the LLM prompt
print(payload.estimated_tokens)    # approximate size of the bundle
print(payload.is_partial_context)  # True if some context could not be resolved
```

`build_endpoint_code_bundle(...)` returns the same content as a plain `str` (the
payload's `system_context`) for callers that just want the text.

## How it works

### 1. Locate — `locator`

Given an `EndpointDefinition`, it scans the repository (honoring `.gitignore`,
skipping test files) and finds the file that implements the handler. It uses a
cascade heuristic: match the `operation_id` first, then fall back to the route
decorator (`@app.post("/orders")` and equivalents). Patterns per language live in
`cte/patterns.toml`, so adding a language is a config change, not a code change.

It raises `ControllerNotFoundError` when nothing matches and
`AmbiguousControllerError` (with the candidate list) when several files do, leaving
the disambiguation policy to the caller.

### 2. Parse — `ast_builder`

Reads the located file as raw bytes and parses it with tree-sitter into an
`ASTContext` (the syntax tree, the precompiled tag query, and the original bytes).
Files outside the supported language set raise `UnsupportedLanguageError`; files with
unrecoverable syntax raise `SyntaxParseError`.

### 3. Cut — `extractor`

Extracts the exact source of the target function by byte-slicing the AST
(`source_bytes[start_byte:end_byte]`), preserving indentation, comments and
decorators precisely. The result is an `ExtractedContext` with the raw code, its line
coordinates and the source file path. Missing functions raise `TargetNodeNotFoundError`.

### 4. Follow — `tracer`

Recursively traces what the handler depends on. It detects the calls inside the
snippet (`call_detector`), resolves imported names to physical files
(`import_analyzer` + `resolver`), extracts each dependency, and repeats — with cycle
detection and a depth limit. Calls it cannot map to real code are recorded as
`unresolved_calls`.

### 5. Decide — `quality`

Measures how complete the trace was and picks a mode, so the context stays useful
without blowing up in size:

| Mode | When | Context shipped |
|---|---|---|
| `surgical` | most calls resolved | the surgical dependency chain only |
| `hybrid` | partially resolved | the chain **plus** a bounded fallback file bundle |
| `fallback` | poorly resolved, or a critical call (auth/payment/…) is unresolved | a bounded file bundle only |

The result of stages 3–5 is a `TracerResult` (mode, completion ratio, dependency
chain, fallback files, unresolved calls).

### 6. Bundle — `packager`

Turns the `ExtractedContext` + `TracerResult` into a single `LLMPayload`. It renders
an XML-tagged `system_context` (so the model can tell the controller, its
dependencies, fallback files and missing pieces apart), wraps code in `CDATA` so it
reads verbatim, sanitizes the text to valid UTF-8, and estimates the token size.

```xml
<source_context>
<primary_controller filepath="app/orders.py" name="create_order">
<![CDATA[ ...controller code... ]]>
</primary_controller>
<dependencies>
<dependency filepath="app/validate.py" name="validate"><![CDATA[ ... ]]></dependency>
</dependencies>
<missing_context>
<unresolved_call>charge_card</unresolved_call>
</missing_context>
</source_context>
```

`is_partial_context` is `True` when anything was left unresolved or the mode is not
surgical, signaling to the inference layer that the picture may be incomplete.

## Public API

Everything you normally need is re-exported from the package root:

```python
from core_ast import (
    build_endpoint_payload,     # full pipeline -> LLMPayload
    build_endpoint_code_bundle, # full pipeline -> system_context str
    export_endpoint_bundle,     # alias of build_endpoint_code_bundle
    build_llm_payload,          # package an ExtractedContext + TracerResult
    LLMPayload,                 # the output DTO
)
```

Domain exceptions are exported from `core_ast.exceptions` — every failure mode is a
typed exception with context attributes, never a silent `None` or a stray print.

## Module layout

```
src/
├── exceptions.py       # domain exceptions
├── core_ast.py         # public API re-exports
├── api.py              # build_endpoint_payload / build_endpoint_code_bundle orchestrators
├── models/             # DTOs (EndpointDefinition, ASTContext, ExtractedContext, TracerResult, LLMPayload)
├── cte/                # configuration: language patterns and constants
├── locator/            # find the handler file
├── ast_builder/        # parse a file into an ASTContext
├── extractor/          # byte-slice the target function
├── import_analyzer/    # parse import statements (Strategy per language)
├── resolver/            # resolve imports to physical paths (Strategy per language)
├── tracer/               # recursive dependency tracing
├── quality/              # mode decision + fallback bundle
└── packager/             # assemble the LLMPayload (XML, tokens, sanitization)
```

For a deeper dive into design decisions and per-module code reference, see
[Reference](core-ast/reference.md).

## Design principles

- **Deterministic and stateless.** Same input → same output or the same domain
  exception. No hidden randomness, no global state, no execution of the analyzed code.
- **Configuration over hardcoding.** Languages, patterns and thresholds live in
  `cte/`, so most extensions are data changes, not new branches.
- **Typed boundaries.** Every stage takes and returns a Pydantic DTO; failures raise
  typed exceptions the orchestrator can present.
- **One-directional flow.** Each stage does one transformation and hands a typed
  object to the next; nothing reaches back upstream.

## Development

Tests and linting run in an isolated container via the `core-ast` service defined in
`docker-compose.yml`.

Run the test suite with coverage:

```bash
docker compose run --rm core-ast pytest tests/ -v --cov=src --cov-report=term-missing
```

Check linting:

```bash
docker compose run --rm core-ast ruff check src/ tests/
```

Open an interactive shell in the container:

```bash
docker compose run --rm core-ast bash
```
