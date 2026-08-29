# Contributing & Testing

Use this page when changing Spec Forge itself. For initial CLI setup, see
[Installation](../user-guide/installation.md); for runtime profiles, see
[Running with Docker](../user-guide/docker.md).

## Local setup

Install the CLI editable, plus the task runner and the linter, then register the
pre-commit hooks:

```bash
pip install -e core poethepoet ruff
poe setup-hooks
```

`poe` drives the repo-wide tasks (`poe test`, `poe dev`, `poe demo`); `ruff` is
the linter every module suite expects.

## Test the repository

From the repository root:

```bash
poe test
poe test-engine <engine-name>
# Example: poe test-engine storage-engine
```

The first command runs all module suites. The second narrows the run to one
engine.

## Test a Compose module

For modules with a Compose service, use the same pattern from the corresponding
module directory:

```bash
docker compose run --rm <service> pytest tests/ -v --cov=src --cov-report=term-missing
docker compose run --rm <service> ruff check src/ tests/
docker compose run --rm <service> bash
```

Available module test services are:

- `contract-engine`
- `storage-engine`
- `core-ast`

The root Compose file also defines `specforge` (the CLI) and `dummy-api` (the demo
target); those are runtime services, not module test suites. The last command opens
an interactive shell for the selected service.

## Exceptions

Only these modules need a different workflow:

- **Core CLI (`core`)**: create a virtual environment, install `.[dev]`, then run
  `.venv/Scripts/python.exe -m pytest -q`.
- **Contracts (`lib/contracts`)**: `pip install -e ".[dev]"`, then run
  `pytest -q --cov=src/specforge_contracts --cov-report=term-missing`, then
  `ruff check src tests`.
- **Storage (`lib/storage`)**: build its image with
  `docker build -t storage-engine .`, then run
  `docker run --rm storage-engine pytest -v --cov=src/storage --cov-report=term-missing`.
- **Semantic Inference (`lib/semantic_inference`)**: run fast tests with
  `python -m pytest -m "not integration" -q`; run live-provider tests with
  `python -m pytest -m integration` after configuring `LLM_MODEL` and its key.

Core AST and Contract Engine primarily use the Compose pattern above, but both
also work from a local venv (`pip install -e ".[dev]"`, then `pytest`/`ruff`
directly) when you want editor tooling or scripts outside Docker. Core AST can
additionally install `.[dev,golden-path,tokens]` when optional languages or token
counting are needed.

## Test scope

Semantic-inference integration tests are marked `@pytest.mark.integration` and do
not run in GitHub Actions by default. Storage unit tests can use
`StorageEngine(db_path=":memory:")` to share one in-memory database connection.
