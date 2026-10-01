# Storage — Decision records — Artifacts

Part of the [Storage decision records](index.md). Decisions about the files
storage keeps on disk: the order in which a file and its row are written, how
retention removes files without leaving a dangling row, and why one module owns
every disk call.

---

## ADR-082 — An artifact file is written before its row, at a content-addressed path { #adr-082 }

**Status:** accepted · `artifacts/store.py`, `artifacts/paths.py`, `artifacts/layout.py`

### Context

The row lives in a transaction that may roll back; the file on disk cannot be
rolled back. One of the two must be able to outlive the other.

### Decision

`save_artifact` writes the file first, at `<entity>/<id>/<sha256>/<filename>`
under the artifacts root, then inserts the row in the caller's transaction. A
rollback leaves a file no row names — an orphan, found and removed by
`collect_orphans`; it never leaves a row naming no file. The same content saved
again with the same kind at the same level returns the existing row without
writing anything.

### Rejected

Row first, file after: a failure between the two leaves a row pointing at
nothing, which breaks replay. Writing files after the commit: it needs a second
phase that can itself fail after the data is committed.

### Consequences

The invariant is "a file may outlive its row; a row never outlives its file".
An orphan left by a rollback is harmless and is removed by `collect_orphans`.

---

## ADR-083 — Retention checks the transaction guard before any side effect and unlinks only after its own commit { #adr-083 }

**Status:** accepted · `artifacts/compression.py`, `artifacts/reclamation.py`, `artifacts/orphans.py`

### Context

Compressing, reclaiming and collecting mix row updates with file writes and
deletions. A deletion made before the commit that justified it cannot be undone
if that commit fails.

### Decision

Each operation takes the engine and calls `ensure_can_begin_transaction()`
before touching anything. It does its database work in a transaction of its
own, and removes a file only after that transaction has closed and only if no
row still names the file. Compression writes the `.gz` first, then repoints the
row, then removes the plain file.

### Rejected

Taking a Unit of Work, which would make the operation join the caller's scope
and unlink before that scope commits; and deleting inside the transaction.

### Consequences

Retention cannot be composed into a caller's transaction. A removal that fails
leaves an orphan — reported as `uncollected`, or left for the next collection —
never a dangling row.

---

## ADR-084 — One filesystem gateway touches the disk, with the Windows extended-length prefix { #adr-084 }

**Status:** accepted · `artifacts/filesystem.py`, `tests/artifacts/test_disk_boundary_gate.py`, `tests/artifacts/test_long_paths.py`

### Context

An artifact path is the root, the entity, its id, a 64-character digest and the
filename; under a long artifacts root that passes, on Windows, the 260-character
limit of the classic API. Disk calls spread across modules would each need the
fix, and each would translate `OSError` on its own.

### Decision

One module performs every disk operation of the artifact store. On Windows it gives every path the
extended-length prefix (`\\?\`, or `\\?\UNC\` for network shares) and strips it
from what it returns. It turns every `OSError` into `ArtifactReadError` or
`ArtifactWriteError`, naming the plain path; a batch removal instead reports
each path it could not remove. A test forbids direct disk I/O anywhere else in
the artifact package.

### Rejected

Requiring the long-paths setting on the user's machine, which is outside the
product's control; and shortening the layout, which gives up content
addressing.

### Consequences

Paths stored and returned are in their ordinary form. A Windows CI job runs the
long-path tests, which build paths beyond 260 characters and are skipped on
other platforms.
