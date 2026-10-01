# Errors

Storage answers in its own vocabulary. Every exception it defines derives from `StorageError`,
and all 32 classes are exported from `storage` (and from `storage.exceptions`). A failure of
the SQLite driver or of the disk is translated at the boundary into one of them, so a domain
failure never reaches a caller as a `sqlite3` or `OSError` type ([ADR-075](adr/foundations.md#adr-075)).

Every class carries the attributes listed below, plus a readable message as its `str()`.

## Hierarchy

| Class | Parent | Attributes | Raised by |
| --- | --- | --- | --- |
| `StorageError` | `Exception` | — | Never raised itself: the base to catch. |
| **Engine and transactions** | | | |
| `EngineClosedError` | `StorageError` | `db_path` | Any use of a `StorageEngine` after `close()`, memory- or file-backed. |
| `SchemaMismatchError` | `StorageError` | `db_path`, `expected_fingerprint`, `actual_fingerprint` | `StorageEngine(...)`, opening a file built from a different `schema.sql` ([fingerprint](data-model.md#fingerprint)). |
| `NestedTransactionError` | `StorageError` | `db_path` | `transaction()` or `ensure_can_begin_transaction()` while the same engine has a scope open on the same thread ([ADR-077](adr/foundations.md#adr-077)). The retention operations check it before any side effect. |
| **Writes** | | | |
| `PersistedRecordError` | `StorageError` | `record_type`, `assigned` | Any `create()` given a record that already carries a database-assigned field (`id`, `created_at`, `executed_at`). |
| `ConstraintViolationError` | `StorageError` | `table`, `detail`, `error_name` | A statement or a commit that breaks a schema constraint and is not a duplicate. `table` is `None` when the violation surfaced away from one INSERT: at commit, or in SQL run on the scope's connection. |
| `DuplicateRowError` | `ConstraintViolationError` | inherited | An INSERT that breaks a UNIQUE or PRIMARY KEY constraint. |
| `DuplicateRunError` | `DuplicateRowError` | `analysis_id`, `ordinal`, plus inherited | `uow.runs.create()` when the analysis already has a run with that ordinal. |
| `IncompleteTruncationError` | `StorageError` | `truncation_reason`, `truncation_endpoint_id` | `uow.runs.create()` with only one of the truncation pair. |
| `TruncationQualifierWithoutReasonError` | `StorageError` | `column`, `value` | `uow.runs.create()` and `uow.run_endpoint_stats.create()` when a qualifier of a cut comes without a `truncation_reason`. |
| `InvalidRunStatusError` | `StorageError` | `status` | `uow.runs.create()` with a status outside `RUN_STATUSES`. |
| `InvalidOracleScopeError` | `StorageError` | `oracle_scope` | `uow.runs.create()` with a scope outside `ORACLE_SCOPES`. |
| `IncompleteExclusionError` | `StorageError` | `disposition`, `exclusion_reason` | `uow.analysis_endpoints.create()` when `exclusion_reason` does not match an `excluded` disposition. |
| `InvalidDispositionError` | `StorageError` | `disposition` | `uow.analysis_endpoints.create()` with a disposition outside `ENDPOINT_DISPOSITIONS`. |
| **Database** | | | |
| `DatabaseOperationError` | `StorageError` | `db_path`, `detail`, `error_name` | The database could not open, read, write or commit; also a default data directory that cannot be resolved. |
| `DatabaseBusyError` | `DatabaseOperationError` | inherited | Another connection held the lock past the busy timeout (5 seconds). Retry the operation. |
| **Not found** | | | |
| `ProjectNotFoundError` | `StorageError` | `project_id` | `uow.projects.get_by_id()`. |
| `AnalysisNotFoundError` | `StorageError` | `analysis_id` | `uow.analyses.get_by_id()`. |
| `AnalysisEndpointNotFoundError` | `StorageError` | `analysis_endpoint_id` | `uow.analysis_endpoints.get_by_id()`. |
| `RunNotFoundError` | `StorageError` | `run_id` | `uow.runs.get_by_id()`. |
| `RunMetricsNotFoundError` | `StorageError` | `run_id` | `uow.run_metrics.get_by_run_id()`. |
| `RunEndpointStatsNotFoundError` | `StorageError` | `run_endpoint_stats_id` | `uow.run_endpoint_stats.get_by_id()`. |
| `FindingNotFoundError` | `StorageError` | `finding_id` | `uow.findings.get_by_id()`. |
| `ArtifactNotFoundError` | `StorageError` | `artifact_id` | `uow.artifacts.get_by_id()`, `mark_compressed()` and `delete()`; `compress_artifact` and `reclaim_artifacts` when a row is gone. |
| **Artifacts** | | | |
| `ArtifactIntegrityError` | `StorageError` | `artifact_id`, `path`, `expected_sha256`, `actual_sha256` | `load_artifact` when the content's SHA-256 differs from the row. |
| `ArtifactFileMissingError` | `StorageError` | `artifact_id`, `path` | `load_artifact` when the row exists and its file does not. |
| `ArtifactDecompressionError` | `StorageError` | `artifact_id`, `path` | `load_artifact` when a compressed file is not valid gzip. |
| `ArtifactWriteCollisionError` | `StorageError` | `artifact_id`, `path` | `compress_artifact` when `<path>.gz` already holds different content. |
| `ArtifactDiskError` | `StorageError` | `path`, `errno`, `reason` | Never raised itself: the base of the two disk errors. |
| `ArtifactReadError` | `ArtifactDiskError` | inherited | The disk refused to read, measure, resolve or walk a path. |
| `ArtifactWriteError` | `ArtifactDiskError` | inherited | The disk refused to create, write or remove a file or directory. |
| `InvalidArtifactLevelError` | `StorageError` | `analysis_id`, `run_id` | `save_artifact` given zero or both levels, before any file is written. |

`error_name` is SQLite's extended result name (for example `SQLITE_CONSTRAINT_UNIQUE`) when
the driver reported one, `None` otherwise.

## How driver errors are classified

A database failure inside `transaction()`, while opening an engine, or in a repository write
is classified by SQLite's primary result code:

| The driver reported | Storage raises |
| --- | --- |
| A constraint failure, `SQLITE_CONSTRAINT_UNIQUE` or `SQLITE_CONSTRAINT_PRIMARYKEY`, on an INSERT into a known table | `DuplicateRowError` |
| Any other constraint failure (a CHECK, NOT NULL, a foreign key, or a duplicate at commit) | `ConstraintViolationError` |
| `SQLITE_BUSY` or `SQLITE_LOCKED` | `DatabaseBusyError` |
| Anything else | `DatabaseOperationError` |

A repository that knows what a duplicate means narrows it further: a duplicate
`(analysis_id, ordinal)` on `runs` becomes `DuplicateRunError`.

Three things are deliberately left untranslated:

- **`sqlite3.ProgrammingError`.** Misuse of the driver, such as a closed connection or a
  wrong parameter count, is a bug and reaches the caller as is.
- **SQL on a raw connection.** A connection from `engine.get_connection()` is the caller's;
  statements run on it raise the driver's own errors. Only `transaction()` and the
  repositories translate.
- **Record validation.** Building a record that breaks its own model, such as a
  `confirmed` `FindingRecord` without its reproducer, raises pydantic's `ValidationError`
  when the record is constructed, before storage is involved. It is not a `StorageError`.

## Catching

Catch `StorageError` once, at the boundary where your code meets storage: a composed write
that fails anywhere rolls back as a whole (see [transactions](transactions.md)), so there is
nothing to clean up per step. Below
that boundary, act only on the subclasses that change what a reader can show:

| Catch | When it is actionable |
| --- | --- |
| The `*NotFoundError` classes | A lookup by id whose target was deleted or never existed: report "not found" instead of failing. |
| `ArtifactFileMissingError`, `ArtifactIntegrityError`, `ArtifactDecompressionError` | An artifact that is gone or corrupt: show the row without its content. |
| `DatabaseBusyError` | Another process holds the database: retry or ask the user to wait. |
| `SchemaMismatchError` | A local database built from another schema: delete the file and let storage create it again. |

Everything else is a failed write or an unusable database, and belongs to the boundary
handler. Core is that boundary for persistence: it wraps a storage failure during a write
into its own `PersistenceError` (see [Core](../core/index.md)).
