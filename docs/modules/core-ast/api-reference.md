# Core AST — API reference

Everything `core_ast` exposes, and nothing else. Ten names come from the package
root and the domain exceptions from `core_ast.exceptions`; anything reached
through a deeper module path is internal and may change without notice.

For how the stages work inside, see the [Implementation
Reference](reference.md); for why they are shaped that way, the [decision
records](adr.md).

```python
from core_ast import (
    analyze_endpoint, analyze_endpoints, build_endpoint_payload,
    build_llm_payload, resolve_handler_name,
    EndpointDefinition, EndpointAnalysis, EndpointAnalysisResult,
    ProcessedFunction, LLMPayload,
)
```

## Entry points

### `analyze_endpoint(endpoint, repo_root, parser_manager=None) -> EndpointAnalysis`

The whole pipeline for one endpoint, keeping everything it learned on the way —
how the controller was located, how much of the call graph resolved, which
functions were visited — not just the payload.

```python
from core_ast import EndpointDefinition, analyze_endpoint

endpoint = EndpointDefinition(path="/tags", method="get", operation_id="GetTags")
analysis = analyze_endpoint(endpoint, repo_root="/path/to/api/repo")

analysis.locator.filepath        # PosixPath('.../app/api/routes/tags.py')
analysis.locator.match_strategy  # 'mount_prefix'
analysis.locator.confidence      # 0.45
analysis.target_function         # 'get_all_tags'
analysis.tracer.mode             # 'surgical'
analysis.payload.system_context  # the XML block for the prompt
```

`parser_manager` is optional and exists to share one across calls: grammars and
trees are cached on it.

**Raises** `ControllerNotFoundError`, `AmbiguousControllerError`,
`HandlerNameNotFoundError` or `TargetNodeNotFoundError`.

### `analyze_endpoints(endpoints, repo_root, parser_manager=None) -> list[EndpointAnalysisResult]`

The same, for a whole contract. One result per endpoint, in order, each carrying
either its analysis or the domain error that stopped it — an endpoint that
cannot be located costs you that endpoint and no other
([ADR-043](adr.md#adr-043)).

```python
from core_ast import analyze_endpoints

for result in analyze_endpoints(endpoints, repo_root="/path/to/api/repo"):
    if result.ok:
        print(result.analysis.locator.filepath, result.analysis.tracer.mode)
    else:
        print(result.endpoint.path, type(result.error).__name__)
```

All endpoints share one `ParserManager`, so each file is parsed once.

**Raises** only what invalidates the whole run: `RepositoryNotFoundError`,
`RepositoryNotADirectoryError`, `MissingQueryTemplateError`.

### `build_endpoint_payload(endpoint, repo_root, parser_manager=None) -> LLMPayload`

`analyze_endpoint(...).payload`, for callers that only need the prompt. Raises
the same four exceptions.

### `build_llm_payload(extracted, tracer_result) -> LLMPayload`

Packages context that was gathered elsewhere. Useful when you already hold an
`ExtractedContext` and a `TracerResult` and want the XML assembly on its own; the
three entry points above call it for you.

### `resolve_handler_name(controller_path, endpoint_path, method, scope=None) -> str`

Which function of an **already located** file serves the endpoint. Finds the
route declaration and takes the definition that follows it, using method-level
declarations only ([ADR-013](adr.md#adr-013)).

```python
from core_ast import resolve_handler_name

resolve_handler_name("app/api/routes/tags.py", "/tags", "get")   # 'get_all_tags'
```

**Raises** `HandlerNameNotFoundError`.

## Input

### `EndpointDefinition`

One endpoint of the contract, flat. Every field except `path` and `method` is
optional, because a spec may not declare it.

| Field | Type | |
|---|---|---|
| `path` | `str` | As written in the contract: `/articles/{slug}` |
| `method` | `str` | Lowercase: `get`, `post`, … |
| `operation_id` | `str \| None` | Used as a shortcut when it names something callable ([ADR-042](adr.md#adr-042)) |
| `parameters` | `list[dict]` | Path, query and header parameters |
| `request_body` | `dict \| None` | Body schema |
| `responses` | `dict` | Response code → schema |

## Output

### `EndpointAnalysis`

| Field | Type | |
|---|---|---|
| `endpoint` | `EndpointDefinition` | What was asked for |
| `locator` | `LocatorResult` | Which file, and how it was found |
| `language` | `str` | Detected language of the controller |
| `target_function` | `str` | The handler that was analysed |
| `extracted` | `ExtractedContext` | Its source, exactly as written |
| `tracer` | `TracerResult` | Metrics and the dependency chain |
| `payload` | `LLMPayload` | The packaged context |
| `processed_functions` | `list[ProcessedFunction]` | Every function the trace visited |

`locator.confidence` runs from 1.00 down to 0.35 depending on the strategy that
hit — the table is in the [Implementation Reference](reference.md). Note that
`locator.filepath` may not be the file the locator originally chose: when the
route declaration points at a neighbouring module, the controller is that one
([ADR-042](adr.md#adr-042)).

### `EndpointAnalysisResult`

Carries an analysis **or** an error, never both and never neither.

| Field | Type | |
|---|---|---|
| `endpoint` | `EndpointDefinition` | |
| `analysis` | `EndpointAnalysis \| None` | |
| `error` | `Exception \| None` | The domain exception that stopped it |
| `ok` | `bool` | Property: `True` when the analysis completed |

### `LLMPayload`

| Field | Type | |
|---|---|---|
| `system_context` | `str` | The XML block: handler, dependencies, bundled files, unresolved calls |
| `estimated_tokens` | `int` | Exact with the `tokens` extra installed, a heuristic without it ([ADR-041](adr.md#adr-041)) |
| `is_partial_context` | `bool` | `True` when something could not be resolved, or the mode was not surgical |

The XML looks like this — code goes in `CDATA` so the model reads it literally
([ADR-040](adr.md#adr-040)):

```xml
<source_context>
<primary_controller filepath="..." name="get_all_tags">
<![CDATA[async def get_all_tags(...): ...]]>
</primary_controller>
<dependencies>
<dependency filepath="..." name="fetch_tags"><![CDATA[...]]></dependency>
</dependencies>
<missing_context>
<unresolved_call>charge_customer</unresolved_call>
</missing_context>
</source_context>
```

### `ProcessedFunction`

`filepath` and `function_name` of a function the trace visited. Replaces the
`'path::name'` signature the tracer accumulates internally, which is a detail of
cycle-breaking and not a contract.

## Exceptions

All from `core_ast.exceptions`, all carrying their context as attributes. A
message states what happened and never what to do about it
([ADR-045](adr.md#adr-045)).

| Exception | Raised when | Attributes |
|---|---|---|
| `ControllerNotFoundError` | No file matched the endpoint | `endpoint_path`, `method` |
| `AmbiguousControllerError` | Several did | `endpoint_path`, `method`, `candidates` |
| `HandlerNameNotFoundError` | File located, function not nameable | `controller_path`, `endpoint_path`, `method` |
| `TargetNodeNotFoundError` | The function is not in the file | `target_identifier`, `filepath` |
| `UnsupportedLanguageError` | Extension outside the Golden Path, or its optional grammar is missing | `extension`, `filepath` |
| `SyntaxParseError` | The tree is unusable ([ADR-020](adr.md#adr-020)) | `filepath` |
| `SourceFileNotFoundError` | The file to parse does not exist | `filepath` |
| `MissingQueryTemplateError` | A supported language has no `.scm`: corrupt install | `language_name`, `scm_path` |
| `RepositoryNotFoundError` | `repo_root` does not exist | `repo_root` |
| `RepositoryNotADirectoryError` | `repo_root` is not a directory | `repo_root` |
| `UnresolvableDependencyError` | A language has no resolver registered | `call_signature`, `reason` |

**`ENDPOINT_ANALYSIS_ERRORS`** is the tuple of the first six: the failures that
exhaust one endpoint without saying anything about the others. It is what
`analyze_endpoints` catches, and it is exported so a caller can make the same
distinction.

```python
from core_ast.exceptions import ENDPOINT_ANALYSIS_ERRORS

try:
    analysis = analyze_endpoint(endpoint, repo_root)
except ENDPOINT_ANALYSIS_ERRORS as exc:
    log.warning("skipping %s: %s", endpoint.path, exc)
```
