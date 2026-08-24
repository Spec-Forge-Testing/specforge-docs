# Storage Engine

`lib/storage` is the persistence layer for the Spec Forge pipeline. It turns the
tool into an auditable, centralized, traceable platform.

The engine manages a **SQLite** database inside the application directory
(`llm-pbt-agent/data/coretest.db`) organized around the **project → analysis → run**
hierarchy: an analysis is the replayable recipe (already-resolved contracts, a
recorded execution trace), and each run is one execution of that recipe — either
the original one, which generates and records it, or a later replay that resends it
as-is.

## Architecture (Repository pattern)

1. **`StorageEngine` (`db.py`)** — its only job is connecting to SQLite, configuring
   safety settings (e.g. enabling foreign keys), and initializing tables from the
   plain `schema.sql` file.
2. **Repositories (`repositories/`)** — one DAO per entity, fully encapsulating
   parametrized SQL (`INSERT`, `SELECT`) to shield the database against injection.
   They never commit on their own — the transaction owner does.
3. **DTOs (`models.py`)** — everything entering or leaving the engine is validated
   through immutable Pydantic models.
4. **Domain exceptions (`exceptions.py`)** — any persistence failure raises a
   handleable domain error (e.g. `RunNotFoundError`) instead of a raw SQLite driver
   exception.

### Schema evolution

`schema.sql` is the single source of truth for the database shape and is edited in
place — there is no migration mechanism. The schema is applied with
`CREATE TABLE IF NOT EXISTS`, which never adds columns to an existing table, so the
engine stamps a fingerprint of `schema.sql` into SQLite's `user_version` and refuses
to open a file built from a different one (`SchemaMismatchError`). The refusal happens
when the engine is constructed, before any run executes — never inside a persistence
transaction after a run: **delete `data/coretest.db` and let the engine recreate it.**
Local databases are disposable development artifacts.

### Engine lifecycle

`StorageEngine` closes deterministically: `close()` is idempotent, the engine is a
context manager (`with StorageEngine(...) as engine:`), and a closed engine rejects
any further use — memory- or file-backed alike — with a typed `EngineClosedError`
instead of silently reconnecting.

## Transactional boundary (Unit of Work)

A composed write spans several tables — `project → analysis → analysis_endpoints →
run → run_metrics → run_endpoint_stats → crash_reports → artifact`. Persisting a run
is one such write, and it must be **all-or-nothing**: a failure halfway through cannot
leave a partial or orphaned analysis behind. `StorageEngine` provides that boundary as
a transaction-scoped **Unit of Work**.

`engine.transaction()` is a context manager (SQLAlchemy `engine.begin()` semantics) that
owns **one** connection and **one** transaction, and yields a `UnitOfWork` whose
repositories are already bound to it:

```python
with engine.transaction() as uow:
    project = uow.projects.get_or_create(name="demo", repo_path="/repos/demo")
    analysis_id = uow.analyses.create(project_id=project.id, ...)
    run_id = uow.runs.create(analysis_id=analysis_id, ...)
    uow.run_metrics.create(run_id=run_id, ...)
    # ... every write shares the same connection
```

The `with` block *is* the transaction — there is no `uow.commit()`:

- **Clean exit → commit.** Every write in the block is committed at once.
- **Any exception → rollback.** The whole block is rolled back and the error re-raised.
- **Connection lifecycle.** A file database gets a fresh connection that is **closed**
  on exit (fixing a per-call leak); the shared `:memory:` connection is reused and
  **never** closed.

Repositories bound to a `UnitOfWork` do not commit — the block decides. Every
multi-table producer should write through this boundary.

The design also rejects the heavier alternatives on purpose: a full Fowler Unit of Work
(identity map + change-tracking) is over-engineering for immediate `INSERT`s, a dual
`engine | connection` constructor reintroduces a hidden mode, and an engine-held "active
connection" would be hidden, non-thread-safe mutable state.

## Data Models (DTOs)

??? "`ProjectRecord` - **The root record**: which repository a set of analyses belongs to."

      | Field | Type | Description |
      |---|---|---|
      | `id` | `int` | Auto-incrementing primary key. |
      | `name` | `str` | Human-readable project name. |
      | `repo_path` | `str` | Repository path on disk. |

??? "`AnalysisRecord` - **The replayable recipe**: resolved contracts, strategy mode, and execution config."

      | Field | Type | Description |
      |---|---|---|
      | `id` | `int` | Auto-incrementing primary key. |
      | `project_id` | `int` | Foreign key to `ProjectRecord.id`. |
      | `created_at` | `datetime` | When the analysis was created. |
      | `label` | `str \| None` | Optional human-readable label. |
      | `generated_against_repo_hash` | `str` | Hash of the repo the trace was generated against. |
      | `strategy_mode` | `str` | Hypothesis strategy mode used to generate it. |
      | `stateful` | `bool` | Whether the analysis runs stateful chains. |
      | `stateful_config` | `str \| None` | Stateful config, serialized as JSON. |
      | `execution_config` | `str` | Execution config as JSON (headers already sanitized). |
      | `engine_version` | `str \| None` | Engine version that produced the analysis (provenance only). |

??? "`AnalysisEndpointRecord` - A **filterable summary** of which endpoints an analysis targets."

      | Field | Type | Description |
      |---|---|---|
      | `id` | `int` | Auto-incrementing primary key. |
      | `analysis_id` | `int` | Foreign key to `AnalysisRecord.id`. |
      | `method` | `str` | HTTP method (e.g. `GET`, `POST`). |
      | `path` | `str` | URL (e.g. `/api/v1/users`). |

??? "`RunRecord` - A **run**: one concrete execution of an analysis."

      | Field | Type | Description |
      |---|---|---|
      | `id` | `int` | Auto-incrementing primary key. |
      | `analysis_id` | `int` | Foreign key to `AnalysisRecord.id`. |
      | `executed_at` | `datetime` | When the run started. |
      | `duration_ms` | `int \| None` | Total run duration, in milliseconds. |
      | `executed_against_repo_hash` | `str` | Hash of the repo it actually ran against. |
      | `status` | `str` | Final run outcome, from a closed vocabulary: `completed`, `truncated` (it met its own limits) or `aborted` (a fault stopped it: the target stopped responding, or a state link could not be honored). `failed` is reserved — a run that raises is never persisted. |
      | `ordinal` | `int` | Position of the run within its analysis (1 = original). |
      | `is_original` | `bool` | Whether this run generated and recorded the trace. |
      | `fidelity` | `str \| None` | Replay fidelity: `exact` / `reduced`, or `NULL` for an original run (only a replay has a fidelity to report). |
      | `truncation_reason` | `str \| None` | Why the run was cut short (engine reason token); `NULL` when it completed. |
      | `truncation_endpoint_id` | `str \| None` | Endpoint being explored when the run was cut short; `NULL` when it completed. |

      `truncation_reason` and `truncation_endpoint_id` are set together or not
      at all — enforced both by a schema `CHECK` and by a typed
      `IncompleteTruncationError` raised before the write.

??? "`RunMetricsRecord` - Aggregate **stats for a run**."

      *No coverage columns yet — the engine doesn't emit that data.*

      | Field | Type | Description |
      |---|---|---|
      | `run_id` | `int` | Foreign key (and primary key) to `RunRecord.id`. |
      | `total_requests` | `int` | Total requests sent during the run. |
      | `findings_raw` | `int` | Violations found during exploration, before shrinking. |
      | `findings_confirmed` | `int` | Representatives that still reproduced after shrinking. |
      | `findings_unique` | `int` | Distinct defects (`== len(crash_reports)`). |
      | `findings_flaky` | `int` | Representatives that failed to reproduce. |
      | `findings_collapsed` | `int` | Findings never shrunk: a representative of their signature stood for them. Zero for modes without a shrink phase. |
      | `findings_unverified` | `int` | Findings never attempted at all, because the run was cut before shrinking started (`TARGET_DOWN`). `findings_raw == findings_confirmed + findings_flaky + findings_collapsed + findings_unverified`. Zero for modes without a shrink phase. |
      | `requests_shrink` | `int` | Requests the shrinking phase put on the wire; not part of `total_requests`. Zero for modes without a shrink phase. |
      | `by_phase` | `str \| None` | Request breakdown by phase, as JSON. |
      | `by_category` | `str \| None` | Request breakdown by error category, as JSON. |

??? "`RunEndpointStatsRecord` - Per-endpoint **detail of a run's stats**."

      | Field | Type | Description |
      |---|---|---|
      | `id` | `int` | Auto-incrementing primary key. |
      | `run_id` | `int` | Foreign key to `RunRecord.id`. |
      | `analysis_endpoint_id` | `int` | Foreign key to `AnalysisEndpointRecord.id`. |
      | `requests` | `int` | Requests sent to this endpoint during the run. |
      | `findings_raw` | `int` | Violations found for this endpoint, before shrinking. |
      | `crash_count` | `int` | Materialized count of this endpoint's `crash_reports` rows (not a copy). |
      | `latency` | `LatencyRecord` | The endpoint's latency distribution, nested from seven flat columns. |

??? "`LatencyRecord` - An endpoint's **latency distribution**, in milliseconds."

      Stored as seven flat `latency_*` columns on `run_endpoint_stats` and re-nested
      into this value object on read. The engine emits zeros rather than absence, so
      the columns are `NOT NULL DEFAULT 0`: `count` is what tells "no samples timed"
      apart from genuinely zero latencies. Percentiles are nearest-rank (always an
      observed sample, never interpolated).

      | Field | Type | Description |
      |---|---|---|
      | `count` | `int` | Number of latency samples timed for this endpoint. |
      | `min_ms` / `max_ms` / `mean_ms` | `float` | Extremes and mean, in milliseconds. |
      | `p50_ms` / `p95_ms` / `p99_ms` | `float` | Nearest-rank percentiles, in milliseconds. |

??? "`CrashReportRecord` - A distinct **defect found** during a run."

      | Field | Type | Description |
      |---|---|---|
      | `id` | `int` | Auto-incrementing primary key. |
      | `run_id` | `int` | Foreign key to `RunRecord.id`. |
      | `analysis_endpoint_id` | `int \| None` | Foreign key to `AnalysisEndpointRecord.id`; `None` if the finding spans several endpoints (stateful). |
      | `method` / `path` / `phase` | `str` | Identity of the request that triggered the defect, and its phase (valid/boundary/invalid/attack/stateful). |
      | `invariant_violated` | `str` | Which invariant was violated. |
      | `status_code` | `int` | Status code of the failing response. |
      | `minimal_payload` | `str` | Minimal reproducible payload, as JSON. |
      | `sanitized_headers` | `str` | Headers as JSON, with secrets already redacted by the engine. |
      | `response_body` | `str` | Body of the failing response. |
      | `stack_trace` | `str \| None` | Filled in later by the Auto-Fixer; the engine leaves it `None`. |
      | `transition_sequence` | `str \| None` | Request chain as JSON, stateful findings only. |
      | `represented_findings` | `int` | Raw findings this report stands for: itself, its unshrunk group mates and the duplicates it absorbed. Always 1 for stateful findings. |
      | `identity_label` | `str \| None` | The identity the failing request was sent under; `None` when the run declared none. |

??? "`ArtifactRecord` - A **recipe-level artifact** or a **report-level one**"

      Belongs to exactly one of the two levels (analysis scope or run scope) — enforced
      by a `CHECK` in the schema, not just by the repository.

      | Field | Type | Description |
      |---|---|---|
      | `id` | `int` | Auto-incrementing primary key. |
      | `analysis_id` | `int \| None` | Set for analysis-level artifacts. |
      | `run_id` | `int \| None` | Set for run-level artifacts. |
      | `kind` | `str` | Artifact type: `execution_trace` at the analysis level; `report_json`/`report_html` at the run level (see [Run report](../core/reports.md)). |
      | `path` | `str` | Path on disk. |
      | `sha256` | `str` | Hash of the artifact's content. |
      | `size_bytes` | `int` | Size in bytes. |
      | `critical` | `bool` | Whether losing it breaks reproducibility. `execution_trace` is critical; the report pair is not — both are derivable from the run's other persisted data. |
      | `compressed` | `bool` | Whether it's stored compressed. |

## On-disk artifact persistence (`artifacts/`)

Heavy artifacts (specs, reports) don't live inside SQLite: they're written as files, and the `artifacts` table only stores path, hash, and metadata. The `storage/artifacts/` package exposes a single public function, which takes the `UnitOfWork` so the index row joins the caller's transaction:

```python
from storage.artifacts import save_artifact

with engine.transaction() as uow:
    record = save_artifact(
        uow,
        kind="report_html",
        filename="report.html",
        content=html_bytes,
        run_id=run_id,  # or analysis_id= for recipe-level artifacts
    )
```

- **Two folders, not one**: `data/artifacts/analyses/<analysis_id>/` for recipe artifacts (`openapi.json`, `semantic_contract.json`, `generated_test.py` — written once) and `data/artifacts/runs/<run_id>/` for run artifacts (`report.json`, `report.html` — one per execution). The root is configurable via `CORETEST_ARTIFACTS_ROOT` to isolate tests.
- **Exclusive level validated before touching disk**: passing both or neither of `analysis_id`/`run_id` raises `InvalidArtifactLevelError` without writing any file.
- **Deduplication by hash**: if an artifact of the same level and `kind` with identical content (same SHA-256) already exists, the existing record is returned without rewriting the file or inserting a new row.
- **Content-addressed on disk**: each file is written under a hash subdirectory (`.../<digest>/<filename>`), so a later save with different content under the same kind can never overwrite a previously recorded artifact's file.
- **File first, row inside the transaction**: the file is written before the row is inserted. A rollback discards the row but may leave the file as an orphan — harmless, since the content-addressed path can never corrupt a valid artifact and the unreferenced file is dead weight a future retention sweep can reclaim.

Reading back goes through `load_artifact(record)`, which verifies the bytes against the recorded SHA-256 **on every read** — this is what makes replaying a persisted recipe trustworthy: the bytes re-sent are provably the bytes recorded.

```python
from storage import load_artifact

content = load_artifact(record)  # bytes, verified against record.sha256
```

- A file altered on disk raises `ArtifactIntegrityError`, carrying both the expected and the actual hash; a deleted file raises `ArtifactFileMissingError`. Neither case is ever returned silently.
- It takes no `UnitOfWork`: content is immutable once written, so the read needs no transaction.

## Testing

The module has native support for **in-memory** databases for isolated testing:
repositories can be injected with an isolated engine and share the same connection
across a test. Prefer the context manager so no connection outlives the test:

```python
with StorageEngine(db_path=":memory:") as engine:
    ...
```

Both this module's suite and its consumers turn leaked connections into errors
(`filterwarnings` in `pyproject.toml`), so an unclosed engine is a red test, not a
warning.

The Docker test command is in
[Development & Testing](../../getting-started/development.md#module-commands).
