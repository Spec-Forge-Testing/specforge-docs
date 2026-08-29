# Example Walkthrough

`examples/ast_demo/` is a self-contained *Dummy Bank API* used to exercise the
commands end to end and see each renderer against one consistent project. It pairs
a handful of source handlers with the matching `openapi.yaml`:

```text
examples/ast_demo/
├── openapi.yaml   # POST /transfer · GET /account/{account_id}
├── handlers.py    # the FastAPI handlers (the trace targets)
├── rules.py       # business validators called by the handlers
├── models.py      # request/response DTOs
└── data.py        # in-memory account fixtures
```

`transfer` carries the canonical Spec Forge bug: a non-positive `amount` escapes as
an unhandled error and surfaces a `500` where the schema implies a clean `4xx` — a
business invariant the OpenAPI alone never states.

Run the demo from the repository root:

```bash
# 1. Validate the spec
SpecForge ❯ contract-engine --validate -f core/examples/ast_demo/openapi.yaml

# 2. List the endpoints and their engine readiness
SpecForge ❯ contract-engine --analyze -f core/examples/ast_demo/openapi.yaml

# 3. Trace the transfer handler against the example source
SpecForge ❯ trace -c core/examples/ast_demo/openapi.yaml -p core/examples/ast_demo --operation-id transfer

# 4. Inspect the extracted code and the LLM context for transfer
SpecForge ❯ ast-extract -c core/examples/ast_demo/openapi.yaml -p core/examples/ast_demo --operation-id transfer --payload

# 5. Fuzz the live API — start it first in another terminal:
#    uvicorn handlers:app --app-dir core/examples/ast_demo --port 8000
SpecForge ❯ fuzz -f core/examples/ast_demo/openapi.yaml --base-url http://localhost:8000
```

Step 3 locates `transfer` in `handlers.py` and follows its calls into `rules.py`
and `data.py`, so the trace report lists the helper functions it walked across
files. Step 4 prints the actual extracted source and the packaged LLM context for
the same endpoint. Point `--project` at `core/examples/ast_demo` (not the whole
repo) so the locator resolves a single, unambiguous handler. Step 5 serves those
same handlers and fuzzes them: the schema-only run reaches the `500` (whenever
Hypothesis happens to generate a valid `account_id`) and also flags the `422`s the
spec never declares.

See the [CLI Reference](cli-reference.md) for what each command's flags and output mean.
