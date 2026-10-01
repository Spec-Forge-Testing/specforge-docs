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

- `contract-assembly`
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
- **Spec Forge Engine (`lib/specforge_engine`)**: it depends on the shared
  kernel at runtime, so install `lib/contracts` first —
  `pip install -e ../contracts -e ".[dev]"` from the module directory, the same
  command CI runs — then `python -m pytest -q`. Its `fixtures-api` image is built
  from the repository root for the same reason
  (`docker compose run --rm fixtures-api ...` from the module directory already
  does this). `tests/characterization/` is the Golden Master net over the
  compiler and engine boundary; its goldens regenerate only under
  `SPECFORGE_UPDATE_GOLDENS=1`.
- **Storage (`lib/storage`)**: build its image with
  `docker build -t storage-engine .`, then run
  `docker run --rm storage-engine pytest -v --cov=src/storage --cov-report=term-missing`.
- **Semantic Inference (`lib/semantic_inference`)**: run fast tests with
  `python -m pytest -m "not integration" -q`; run live-provider tests with
  `python -m pytest -m integration` after configuring `LLM_MODEL` and its key.

Core AST and Contract Assembly primarily use the Compose pattern above, but both
also work from a local venv (`pip install -e ".[dev]"`, then `pytest`/`ruff`
directly) when you want editor tooling or scripts outside Docker. Core AST can
additionally install `.[dev,golden-path,tokens]` when optional languages or token
counting are needed.

## Test scope

Semantic-inference integration tests are marked `@pytest.mark.integration` and do
not run in GitHub Actions by default. Storage unit tests can use
`StorageEngine(db_path=":memory:")` to share one in-memory database connection.

## Continuous integration { #continuous-integration }

GitHub Actions runs three workflows on every pull request to `main` and on every
push to it. **Tests** (`tests.yml`) runs one job per module suite. **Lint**
(`lint.yml`) runs `poe lint` once for the whole monorepo, on Ubuntu with Python
3.11 and the pinned toolchain of `requirements-lint.txt`. **Protocol**
(`protocol.yml`) validates the protocol fixtures against the envelope schema with
`python protocol/validate.py`, also on Ubuntu with Python 3.11.

Each test job installs its module with `pip install -e .[dev]` from the module
directory, plus the sibling packages it imports, then runs pytest with a coverage
floor. Jobs run on Ubuntu with Python 3.11 unless the table says otherwise.

| Job | Runs on | Python | What it runs | Gate |
|---|---|---|---|---|
| `core` | Ubuntu | 3.11 | `core` suite, with `contracts`, `contract_assembly`, `core_ast`, `specforge_engine` and `storage` installed | coverage ≥ 90 % |
| `core_ast` | Ubuntu | 3.11 | `lib/core_ast` suite | coverage ≥ 75 % |
| `specforge_engine` | Ubuntu | 3.11 | `mypy src/specforge_engine`, then the suite | mypy clean, coverage ≥ 75 % |
| `semantic_inference` | Ubuntu | 3.11 | `pytest -m "not integration"` | tests pass, no coverage floor |
| `contract_assembly` | Ubuntu | 3.11 | `lib/contract_assembly` suite | coverage ≥ 75 % |
| `storage_engine` | Ubuntu | 3.11 | `lib/storage` suite | coverage ≥ 75 % |
| `llm` | Ubuntu | 3.11 | `pytest -m "not integration"` | coverage ≥ 75 % |
| `storage_engine (windows)` | Windows | 3.11 | `lib/storage` suite | coverage ≥ 75 % |
| `storage_engine (python 3.14)` | Ubuntu | 3.14 | `lib/storage` suite | coverage ≥ 75 % |
| `core (python 3.14)` | Ubuntu | 3.14 | `core` suite | coverage ≥ 90 % |

The Windows job exercises the artifact store's extended-length path handling,
which is Windows-specific.

The two Python 3.14 jobs back the leak gate. Both `core` and `storage` turn
leaked resources into test errors: their `filterwarnings` lists
`error::ResourceWarning` and `error::pytest.PytestUnraisableExceptionWarning`,
and their dev extras require `pytest>=8.4`, which collects garbage at the end of
the session so a leak found there still fails the run. As the workflow notes, an
unclosed SQLite connection only surfaces as a warning on Python 3.13 and later;
on 3.11 the filter catches other unclosed resources but not connections, and the
3.14 jobs are where a leaked connection fails CI.

Integration tests are not part of any job; see [Test scope](#test-scope).

### Finding a leak

The error is raised wherever the garbage collector finalizes the resource, which
can be a later, unrelated test or the end of the session rather than the test
that leaked it. To find the line that opened it, run the suspect file from the module
directory with the warning downgraded to a report and allocation tracing on:

```bash
cd lib/storage   # or core
python -X tracemalloc=10 -m pytest -W default::ResourceWarning tests/<path>/test_<area>.py
```

The run does not stop at the leak; pytest prints each `ResourceWarning` in its
warnings summary with the allocation traceback of a leaked connection or file, up to
ten frames deep, so the line that opened it is in the output.
