# Artifacts

An artifact is a file a run produces, such as a trace or a report, stored on disk
and indexed by one row of the [`artifacts` table](data-model.md#artifacts). The
row names the file and records the SHA-256 of its content, so every read can be
verified. This page covers where the files live, how they are saved and loaded,
the one module that touches the disk, and how retention removes rows and files
without ever leaving a row that names a missing file.

## Layout { #layout }

An artifact file lives at:

```text
<root>/<analyses or runs>/<id>/<sha256>/<filename>
```

`<root>` is the artifacts root ([where the data lives](index.md#where-the-data-lives)),
`<id>` is the analysis or run id, and `<sha256>` is the hex SHA-256 of the file's
content. Two saves with different content never share a path, so a new save can
never overwrite the file behind an earlier row.

| Level | Directory | Belongs to |
| --- | --- | --- |
| analysis | `analyses/<id>/` | the recipe; shared by every run of the analysis |
| run | `runs/<id>/` | one run |

Storage creates the entity directory, and any missing parent, when it saves.
Resolving the root does not create it.

## Saving

`save_artifact` writes a file and inserts its row inside the caller's Unit of
Work, so the row commits or rolls back with the rest of the caller's
transaction ([transactions](transactions.md)). It returns the stored
`ArtifactRecord`. Every parameter after `uow` is keyword-only:

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `uow` | `UnitOfWork` | required | the open transaction the row joins |
| `kind` | `str` | required | what the file is ([kinds](#kinds)) |
| `filename` | `str` | required | the file name inside the digest directory |
| `content` | `bytes` | required | the file's content |
| `analysis_id` | `int` or `None` | `None` | set for an analysis-level artifact |
| `run_id` | `int` or `None` | `None` | set for a run-level artifact |
| `critical` | `bool` | `False` | whether losing the file breaks reproducibility |

Exactly one of `analysis_id` and `run_id` must be set; otherwise
`InvalidArtifactLevelError` is raised before anything is written.

Saving the same content with the same `kind` at the same level returns the
existing row and writes nothing. Otherwise the file is written first and its
row is inserted after, with `size_bytes` set to the content length and
`compressed` set to false. If the transaction then rolls back, the file stays
behind as an orphan: a file without a row, never a row without a file
([ADR-082](adr/artifacts.md#adr-082)). [Retention](#retention) collects
orphans.

Save a trace at analysis level, save it again, and load it back:

```python
import os
import tempfile
from pathlib import Path

from storage import AnalysisRecord, ProjectRecord, StorageEngine, load_artifact, save_artifact

with tempfile.TemporaryDirectory() as tmp:
    os.environ["CORETEST_ARTIFACTS_ROOT"] = os.path.join(tmp, "artifacts")
    with StorageEngine(os.path.join(tmp, "store.db")) as engine:
        with engine.transaction() as uow:
            project = uow.projects.get_or_create(
                ProjectRecord(name="demo", repo_path="/repos/demo")
            )
            analysis = AnalysisRecord(
                project_id=project.id,
                generated_against_repo_hash="abc123",
                strategy_mode="default",
                execution_mode="stateless",
                execution_config="{}",
            )
            analysis_id = uow.analyses.create(analysis)
            trace = b'{"requests": []}'
            record = save_artifact(
                uow,
                kind="execution_trace",
                filename="trace.json",
                content=trace,
                analysis_id=analysis_id,
                critical=True,
            )
            again = save_artifact(
                uow,
                kind="execution_trace",
                filename="trace.json",
                content=trace,
                analysis_id=analysis_id,
            )
        print(Path(record.path).parts[-4:-2], record.size_bytes, record.critical)
        print("same row:", again.id == record.id)
        print(load_artifact(record))
```

```text
('analyses', '1') 16 True
same row: True
b'{"requests": []}'
```

## Loading

`load_artifact(record)` returns the artifact's content as `bytes`. It needs no
Unit of Work: it reads the file, gunzips it when the record is `compressed`, and
hashes the content again before returning it. Each failure has its own
exception:

| What went wrong | Raised |
| --- | --- |
| the file is missing | `ArtifactFileMissingError` |
| a compressed file does not decode | `ArtifactDecompressionError` |
| the content's SHA-256 differs from the row | `ArtifactIntegrityError` |
| any other read failure | `ArtifactReadError` |

All four derive from `StorageError` ([errors](errors.md)).

## Compression on disk

Compression is gzip with a fixed timestamp, so the same content always
compresses to the same bytes. A compressed file keeps its directory and takes
the `.gz` suffix. Once a row is compressed, its `size_bytes` is the size of the
compressed file and its `sha256` still addresses the uncompressed content.
`compress_artifact` is the operation that compresses an artifact; it is a
[retention](#retention) operation.

## The filesystem gateway { #filesystem-gateway }

One module touches the disk. Every other artifact module goes through it, and a
test fails if one does not ([testing](testing.md)). The gateway translates every
`OSError` into a storage error, so no operating-system exception leaves storage
([ADR-084](adr/artifacts.md#adr-084)):

| Operation | Raised on an `OSError` |
| --- | --- |
| creating, writing or removing | `ArtifactWriteError` |
| reading, measuring, resolving or walking | `ArtifactReadError` |

Both are `ArtifactDiskError` and carry `path`, `errno` and `reason`. A symlink
loop while resolving a path raises `ArtifactReadError` too.

### Windows: long paths

Every path the gateway hands to the operating system carries the
extended-length prefix: `\\?\`, or `\\?\UNC\` for a network share. Deep artifact
paths are therefore not limited to 260 characters.

The prefix never leaves the gateway. Paths recorded in the database, carried by
an exception, or returned to a caller are in the ordinary form, without it.

## Kinds { #kinds }

Storage does not define artifact kinds: `kind` is free text, and storage
compares it only to deduplicate a save and to count artifacts of a kind. [Core](../core/index.md) writes four:

| Kind | Level | Critical | What it holds |
| --- | --- | --- | --- |
| `execution_trace` | analysis | yes | the trace of requests the original run sent |
| `replay_trace` | run | no | the trace a replay sent |
| `report_json` | run | no | the run's JSON report |
| `report_html` | run | no | the run's HTML report |

## Retention { #retention }

Retention keeps one invariant:

> A file may outlive its row; a row never outlives its file.

Saving honours it by writing the file before the row. Every retention operation
honours it by removing a file only once no row names it
([ADR-083](adr/artifacts.md#adr-083)).

Each retention operation takes the engine, not a Unit of Work, and opens its own
transaction. Before any side effect it calls
`ensure_can_begin_transaction()`, so inside an open scope of the same engine it
raises
`NestedTransactionError`, and on a closed engine `EngineClosedError`, without
touching the disk or the database. Call them outside any open scope
([scopes do not nest](transactions.md#scopes-do-not-nest)).

| Operation | Takes | Order of effects | Returns |
| --- | --- | --- | --- |
| `compress_artifact` | `engine`, `record` | load (and so verify) the content; write `<path>.gz`; in its own transaction, mark the row compressed with the new path and size; remove the plain file unless another row still names it | the updated `ArtifactRecord` |
| `reclaim_artifacts` | `engine`, `records` | in one transaction, delete the rows; after the commit, unlink only the files no remaining row names | `ReclaimOutcome` |
| `scan_orphans` | `engine` | list the files under the root; then, in its own transaction, read which files the rows name | `OrphanScan` |
| `collect_orphans` | `engine` | as `scan_orphans`, then unlink the orphans and remove the digest directories it emptied | `CollectOutcome` |

### Compressing

`compress_artifact` returns the record unchanged when it is already compressed,
when it is smaller than `MIN_COMPRESSIBLE_BYTES` (1024 bytes), or when gzip
would not make it smaller. If `<path>.gz` already exists with different bytes,
it raises `ArtifactWriteCollisionError` and changes nothing. A failure to remove
the plain file after the commit is ignored: the row already names the `.gz`, and
the plain file is an orphan.

### Reclaiming

`reclaim_artifacts` deletes the given rows in one transaction. Duplicate records
collapse into one, and an empty batch does nothing. A row that no longer exists
raises `ArtifactNotFoundError` and rolls back the whole batch, and nothing is
unlinked. Two rows can name the same file, so a file is unlinked only when no
remaining row names it.

### Orphans

An **orphan** is a file under the artifacts root that no row names: the file of a
rolled-back save, or a plain file left behind by compression. `scan_orphans`
reports them; `collect_orphans` removes them. Both read the disk first and the
index after, and a missing root gives an empty result. Do not run
`collect_orphans` while another process writes artifacts.

Files outside the [layout](#layout), and symlinks, are reported as
`unrecognized` and never touched, so a root that shares a directory with other
files stays safe.

The reverse case, a row whose file is gone, is not found by any sweep. It
surfaces when `load_artifact` raises `ArtifactFileMissingError`.

### Outcomes

The three outcomes are immutable records exported from `storage`:

| Record | Field | Meaning |
| --- | --- | --- |
| `ReclaimOutcome` | `deleted_ids` | ids of the rows removed |
| | `freed_bytes` | bytes of the files this batch unlinked, each counted once |
| | `unlinked` | paths removed from disk, as their rows named them |
| | `uncollected` | paths no row names any more whose unlink failed; left for a later pass |
| `OrphanScan` | `orphans` | orphan files as found on disk, sorted |
| | `total_bytes` | total size on disk of the orphan files |
| | `unrecognized` | paths under the root outside its layout, sorted; never touched |
| `CollectOutcome` | `collected` | paths removed from disk, sorted |
| | `freed_bytes` | bytes of the files this sweep unlinked, each counted once |
| | `uncollected` | orphan paths whose unlink failed, sorted; left for a later pass |
| | `unrecognized` | paths under the root outside its layout, sorted; never touched |
