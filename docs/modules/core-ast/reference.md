# Core AST reference

This page is the implementation reference for the static-analysis pipeline. For
installation and an end-to-end example, see the [overview](index.md).

## Pipeline and guarantees

```text
EndpointDefinition + repository → locator → ast_builder → extractor
                              → tracer → quality → packager → LLMPayload
```

Every stage accepts and returns typed DTOs. The target repository is parsed, never
executed. A failure is a domain exception with context; no stage silently returns a
partial `None` result.

| Stage | Main output | Responsibility |
|---|---|---|
| `locator` | location result | Find the endpoint handler. |
| `ast_builder` | `ASTContext` | Parse source bytes with tree-sitter. |
| `extractor` | `ExtractedContext` | Slice the exact target function. |
| `import_analyzer` + `resolver` | import paths | Interpret and resolve imports by language. |
| `tracer` | `TracerResult` | Follow calls recursively. |
| `quality` | mode + fallback plan | Decide how much context is trustworthy. |
| `packager` | `LLMPayload` | Render safe, bounded LLM context. |

## Public API

```python
from core_ast import (
    build_endpoint_payload,       # endpoint + repo → LLMPayload
    build_endpoint_code_bundle,   # same result as plain system_context text
    export_endpoint_bundle,       # alias of build_endpoint_code_bundle
    build_llm_payload,            # package already-extracted context
    LLMPayload,
)
```

`build_endpoint_payload` is the normal entry point. Its result exposes
`system_context`, `estimated_tokens` and `is_partial_context`.

## Stage reference

### `locator`

The locator scans the repository while honoring `.gitignore` and ignoring tests. It
first matches `operation_id`, then route decorators. Language patterns live in
`cte/patterns.toml`, so a new language normally begins as configuration instead of a
new conditional branch.

- No match: `ControllerNotFoundError`.
- More than one candidate: `AmbiguousControllerError`, including candidates.
- Result metadata includes the selected file, match strategy and confidence.

### `ast_builder` and `extractor`

`ast_builder` reads raw bytes, identifies the language and produces an `ASTContext`
with the tree and precompiled tag query. Unsupported files raise
`UnsupportedLanguageError`; unrecoverable syntax raises `SyntaxParseError`.

`extractor` uses byte offsets (`start_byte:end_byte`), rather than reconstructed
source, so decorators, comments and indentation survive exactly. It returns code,
function name, source path and zero-indexed line bounds. A missing node raises
`TargetNodeNotFoundError`.

### `import_analyzer` and `resolver`

Both use a strategy per language. The analyzer transforms source imports into
`ImportEntry` records; the resolver maps those entries to physical paths relative to
the importing file and repository layout. `filter_relevant_imports` keeps only names
needed by calls in the current snippet.

To add a language, implement its analyzer and resolver, register both in their
factories, then add patterns/tests. Language-specific syntax stays behind this seam.

### `tracer`

The tracer detects calls in the primary snippet, resolves them, extracts each
dependency and repeats until a depth limit or a previously visited symbol prevents a
cycle. It records unresolved calls instead of inventing a match.

`TracerResult` contains the dependency chain, unresolved calls, selected fallback
files, completion ratio and the selected mode:

| Mode | Condition | Context sent |
|---|---|---|
| `surgical` | Trace is sufficiently complete. | Controller and dependency chain. |
| `hybrid` | Some calls remain unresolved. | Chain plus bounded fallback files. |
| `fallback` | Low confidence or unresolved critical call. | Bounded fallback files. |

Critical functions (for example, auth or payment) raise the bar: one unresolved
critical call can choose `fallback` even when the numeric ratio looks acceptable.

### `quality`

The quality policy computes completion from resolved versus discovered calls and
selects `surgical`, `hybrid` or `fallback`. The fallback planner ranks relevant files
and applies a file/token budget. It reports whether the budget truncated the set;
the packager exposes that uncertainty through `is_partial_context`.

Thresholds and language patterns belong in `cte/`, not scattered through stages.

### `packager`

The packager emits one XML-tagged `system_context`, separating the primary
controller, dependencies, fallback files and unresolved calls. Code is wrapped in
CDATA, text is sanitized to UTF-8, and the payload estimates its token count.

```xml
<source_context>
  <primary_controller filepath="app/orders.py" name="create_order"><![CDATA[...]]></primary_controller>
  <dependencies>...</dependencies>
  <missing_context><unresolved_call>charge_card</unresolved_call></missing_context>
</source_context>
```

`is_partial_context` is true for non-surgical modes or any unresolved call.

## Extension points and invariants

- The pipeline is deterministic and stateless for equal inputs.
- Every stage has a narrow, one-directional dependency boundary.
- DTOs are Pydantic models; exceptions are typed and carry diagnostic context.
- Parsers, import analyzers and resolvers are language-specific strategies.
- Token and fallback limits are explicit policy, so callers can reason about an
  incomplete result instead of receiving silently truncated context.

## Tests

Run all tests or one stage at a time from the `core-ast` Docker service:

```bash
docker compose run --rm core-ast pytest tests/ -v --cov=src --cov-report=term-missing
docker compose run --rm core-ast ruff check src/ tests/
```

Integration-test setup and output conventions are documented separately in
[Integration Tests](integration-tests.md).
