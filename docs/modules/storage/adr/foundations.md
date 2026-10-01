# Storage — Decision records — Foundations

Part of the [Storage decision records](index.md). Decisions about the engine
itself: what a caller can catch, how a database built from another schema is
recognised, and why transaction scopes refuse to nest.

---

## ADR-075 — Every driver and OS error is translated at the boundary: only `StorageError` leaves storage { #adr-075 }

**Status:** accepted · `exceptions.py`, `db.py`, `artifacts/filesystem.py`

### Context

SQLite raises `sqlite3.IntegrityError`, `OperationalError` and their siblings;
the disk raises `OSError` with platform-specific details. A caller that catches
those has to know the driver and the operating system, and cannot tell a
duplicate row from a locked database without reading error codes.

### Decision

Storage classifies every driver error by its primary SQLite result code into a
typed exception: a duplicate on a named table becomes `DuplicateRowError`, any
other constraint failure `ConstraintViolationError`, a busy or locked database
`DatabaseBusyError`, and everything else `DatabaseOperationError`. Each carries
the table or the database path, and SQLite's error name. Opening the engine,
every transaction scope and its commit are wrapped this way. Every disk call of
the artifact store goes through one gateway that raises `ArtifactReadError` or
`ArtifactWriteError`. A driver *misuse* error (`sqlite3.ProgrammingError`) stays
untranslated: it is a bug, not a domain failure.

### Rejected

Letting driver errors through and documenting them, which couples every reader
to SQLite; and a single `StorageError` with no subclasses, which leaves a reader
unable to react differently to "busy" and "duplicate".

### Consequences

A caller catches `StorageError`, or the subclass it can act on; the core's source
does not import `sqlite3` at all. The one documented hole is the raw connection
returned by `get_connection()`: SQL run on it raises the driver's own errors.

---

## ADR-076 — The schema carries a fingerprint in `user_version`; a mismatched file is refused, not migrated { #adr-076 }

**Status:** accepted · `db.py`, `schema.sql`

### Context

The schema is applied with `CREATE TABLE IF NOT EXISTS` every time a database is
opened, which silently keeps an older table shape. The first query against a
missing column then fails far from the cause, with a driver message.

### Decision

The fingerprint is a CRC32 of the text of `schema.sql`, masked to 31 bits and
stamped in SQLite's `user_version`. Opening a database that already has tables
and carries a different fingerprint raises `SchemaMismatchError`, naming the
file and both values; a database without tables is stamped and the schema is
created.

### Rejected

A hand-maintained version number, which is forgotten on exactly the edit that
matters — a value derived from the text cannot be forgotten. A migration
framework, which is machinery for a store whose schema is still changing and
whose local files are recreated, not upgraded.

### Consequences

Any edit to `schema.sql`, even to a comment, changes the fingerprint and makes
existing local databases refuse to open until they are deleted. Line endings do
not count: the text is read with them normalized, so a CRLF checkout and an LF
one produce the same fingerprint.

---

## ADR-077 — Transaction scopes do not nest, per engine and per thread { #adr-077 }

**Status:** accepted · `db.py`, `artifacts/compression.py`, `artifacts/reclamation.py`, `artifacts/orphans.py`

### Context

Retention removes files only after its own transaction commits, so a file never
disappears while a row that names it might survive a rollback. If retention
joined a caller's open transaction, it would unlink files before that caller
committed.

### Decision

`transaction()` refuses to open while the same engine already has a scope open
on the same thread, raising `NestedTransactionError`. The marker is a
thread-local held by each engine, so other threads and other engines are not
affected. `ensure_can_begin_transaction()` lets an operation that takes the
engine check the same condition before any side effect.

### Rejected

Nesting through SAVEPOINTs, because a nested scope joins the caller's — exactly
what breaks the retention order. Silently joining an open scope, for the same
reason. One lock across threads, which serializes unrelated work that SQLite's
busy timeout already arbitrates.

### Consequences

Operations that take the engine instead of a Unit of Work are called after the
caller's block closes. The error message says so: transactions do not nest, and
such operations open their own.
