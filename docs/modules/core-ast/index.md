# Core AST

Core AST is the static-analysis engine of the pipeline. Given an API endpoint and
the repository that implements it, it finds the handler in the source code, extracts
the exact function, traces its dependencies, and packages everything into a single,
LLM-ready context bundle — **without ever executing the target code**. It relies on
[tree-sitter](https://tree-sitter.github.io/) for fast, deterministic, multi-language
parsing.

> Its job is to answer one question: *"here is an endpoint and a codebase — what code
should the LLM read to understand this endpoint's behavior?"*

The output feeds the semantic inference layer, which infers business invariants for
property-based fuzzing.

```mermaid
flowchart LR
    A[/EndpointDefinition/] --> C["locator<br/><i>(find)</i>"]
    B[/repository root/] --> C
    C --> D["ast_builder<br/><i>(parse)</i>"]
    D --> E["extractor<br/><i>(cut)</i>"]
    E --> F["tracer<br/><i>(follow)</i>"]
    F --> G["quality<br/><i>(decide)</i>"]
    G --> H["packager<br/><i>(bundle)</i>"]
    H --> I[("LLMPayload")]
```

## Installation

The package targets Python 3.11+.

```bash
pip install -e ".[dev]"
```

Seven languages load on demand (Java, C#, Ruby, PHP, Rust, Kotlin, Swift) via
`golden-path` extra. Token counting uses ``tiktoken`` via ``tokens``. Neither
is strictly required — the engine degrades gracefully:  

```bash
pip install -e ".[dev,golden-path,tokens]"
```

## Quick start

``build_endpoint_payload`` is the primary entry point:

```python
from core_ast import build_endpoint_payload
from core_ast.models.locator import EndpointDefinition

endpoint = EndpointDefinition(path="/orders", method="post", operation_id="create_order")
payload = build_endpoint_payload(endpoint, repo_root="/path/to/api/repo")

print(payload.system_context)      # XML-tagged code block for the LLM prompt
print(payload.estimated_tokens)    # approximate size of the bundle
print(payload.is_partial_context)  # True if some context could not be resolved
```

If you only need the plain text context:

```python
from core_ast import build_endpoint_code_bundle

# Returns payload.system_context as a plain string
raw_text = build_endpoint_code_bundle(endpoint, repo_root="/path/to/api/repo")
```

## Public API Re-exports

The root core_ast package exports:

* ``build_endpoint_payload``: Full pipeline execution $\rightarrow$ ``LLMPayload``.
* ``build_endpoint_code_bundle`` / ``export_endpoint_bundle``: Full pipeline
execution $\rightarrow$ ``str``. 
* ``build_llm_payload``: Packages pre-extracted context (``ExtractedContext`` + ``TracerResult``).
* ``LLMPayload``: The output DTO.

Typed domain exceptions are exported from ``core_ast.exceptions``.

## High-Level Pipeline Flow

| Stage | Responsibility | Main Output |
|---|---|---|
| **1. Locator** | Find the endpoint handler file | Location result / Metadata |
| **2. AST Builder** | Parse source bytes with tree-sitter | `ASTContext` |
| **3. Extractor** | Byte-slice the exact target function | `ExtractedContext` |
| **4. Import & Tracer** | Resolve imports & follow dependency calls recursively | `TracerResult` |
| **5. Quality** | Measure completion & select context budget mode | Mode & Fallback plan |
| **6. Packager** | Assemble sanitized XML-tagged payload | `LLMPayload` |

*For in-depth stage specs, exceptions, and extensibility, see the [Implementation Reference](reference.md).*