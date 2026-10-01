# Testing `storage`

The suite in `lib/storage/tests` checks each repository, the engine and the
artifact operations, and a handful of gates that hold the module's guarantees in
place. The commands to install and run it are in
[Contributing & Testing](../../developer-guide/contributing.md); they are not
repeated here.

## Gates

A gate is a test that fails when a guarantee this documentation states stops
being true.

| Gate | What it pins | Where |
| --- | --- | --- |
| **Schema and record parity** | for every table, the columns SQLite reports equal the columns derived from its record; a second test fails if a table has no mapping, or a mapping has no table | `tests/test_schema_parity.py` |
| **Public API** | the exact, ordered exported names of `storage`, `storage.models` and `storage.artifacts`; every exception class in `storage.exceptions` is a public name; each re-export from `storage` is the same object as in its home package, not a copy | `tests/test_public_api.py` |
| **Leaked resources** | an unclosed engine, connection or file fails the run | `filterwarnings` in `pyproject.toml` |
| **Disk boundary** | only the [filesystem gateway](artifacts.md#filesystem-gateway) touches the disk | `tests/artifacts/test_disk_boundary_gate.py` |
| **Windows long paths** | every artifact operation works on paths beyond 260 characters | `tests/artifacts/test_long_paths.py` |
| **Isolated artifacts root** | no artifact test writes under the user's real artifacts root | `tests/artifacts/conftest.py` |

### Schema and record parity

The [data model](data-model.md) is one record per table, with the columns
derived from the record's fields. The parity test is what makes that true: a
column added to `schema.sql` without a field, or a field without a column,
fails it by name.

### Public API

The test spells out the expected names, so adding or removing an export fails it
by name. The identity checks cover the records and vocabularies, the artifact
operations, the exceptions and `get_artifacts_root`. The groups are listed in
the [public API](index.md#public-api).

### Leaked resources

pytest turns `ResourceWarning` and unraisable-exception warnings into errors, so
an unclosed engine or file fails the run. The dev extras require pytest 8.4 or
later, which collects garbage at the end of the session, so a leak found that
late still fails.

The workflow runs the suite on Python 3.14 as well because there a leaked SQLite
connection fails the suite through that filter. The error is raised where the
connection is finalized, not where it leaked;
[Finding a leak](../../developer-guide/contributing.md#finding-a-leak) shows how
to find the line that opened it.

### Disk boundary

The test parses every artifact module except the gateway and fails on file I/O
through `pathlib`, on a bare `open()`, and on an import of `os` or `shutil`. Two
more tests keep it honest: the set of guarded modules is not empty, and the
detector does find the disk calls inside the gateway itself.

### Windows long paths

Eight tests build an artifacts root deep enough that every artifact path exceeds
260 characters, then save, load, compress, collide, scan, collect and reclaim
under it. They check the recorded path is in the ordinary form, without the
extended-length prefix. They are skipped on other platforms; the Windows CI job
runs them.

### Isolated artifacts root

Every artifact test runs against a throwaway artifacts root: the
`isolated_artifacts_root` fixture points `CORETEST_ARTIFACTS_ROOT` at the test's
temporary directory, and the artifact tests apply it automatically.

## CI jobs

Three jobs of the **Tests** workflow run the storage suite. Each installs the
package with its dev extras and requires at least 75 % coverage.

| Job | Runs on | Python | Why it exists |
| --- | --- | --- | --- |
| `storage_engine` | Ubuntu | 3.11 | the supported floor |
| `storage_engine (windows)` | Windows | 3.11 | runs the long-path tests |
| `storage_engine (python 3.14)` | Ubuntu | 3.14 | fails the suite on a leaked SQLite connection |

The full matrix, and the other workflows, are in
[Continuous integration](../../developer-guide/contributing.md#continuous-integration).
