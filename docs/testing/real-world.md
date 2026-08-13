# RealWorld corpus

Twelve implementations of the **same contract** (`openapi.yml`), one for each
language `core_ast` supports. They exist to verify that Spec Forge tolerates
all twelve languages: the spec is constant and the source code is the only
variable.

**Not used to measure bug-detection capability** — that's what
[EMB](emb.md) is for.

## Usage

```bash
general/up.sh                      # list the 12 targets
general/up.sh go                   # boot go/gin on port 8000
general/up.sh python fastapi       # disambiguate: python has django and fastapi
general/up.sh ruby --reset         # force a clean database
general/down.sh
```

Leaves the API on `http://localhost:8000`. Only one at a time.

## From Python: `corpus.py`

The same thing for tests, with one method per language. It doesn't
reimplement anything: it delegates to `general/up.sh`, which stays the single
source of truth for how each stack boots.

```python
from corpus import RealWorld

rw = RealWorld()
rw.go()                   # boots go/gin, returns once it answers
rw.ip                     # '127.0.0.1'
rw.host                   # 'http://localhost:8000'
rw.fuente                 # path to the source code, for core_ast
rw.sha, rw.repo, rw.framework
rw.bajar()
```

`rw.python()` boots Django, `rw.python('fastapi')` boots the other one; every
other language has a single implementation and takes no argument. Booting one
implementation tears down whichever was active, same as the script.

As a context manager it tears itself down even if the test blows up:

```python
with RealWorld() as rw:
    api = rw.java()
    requests.get(api.host + '/api/tags')
```

`rw.activa` (the active implementation) is read from `general/.active` on
every access, not cached on the instance — so it also sees whatever you
booted by hand from a terminal. `rw.catalogo` returns all 12 without booting
anything, which is exactly what's needed to parametrize a `core_ast` pass: it
never executes the code it analyzes.

## Status: all 12 boot

Verified in one pass, each one from a clean `--reset`:

| API | `GET /api/tags` | Startup |
| --- | --- | --- |
| `python/django` | 200 | 3 s |
| `python/fastapi` | 200 | 4 s |
| `javascript/koa` | 200 | 3 s |
| `typescript/nestjs` | 200 | 5 s |
| `go/gin` | 200 | 1 s |
| `java/spring` | **401** | 10 s |
| `c_sharp/aspnet` | 200 | 4 s |
| `ruby/rails` | 200 | 5 s |
| `php/laravel` | 200 | 1 s |
| `rust/axum` | 200 | 1 s |
| `kotlin/spring` | 200 | 11 s |
| `swift/vapor` | **404** | 1 s |

`java/spring` answers 401 because Spring Security protects every route, and
`swift/vapor` answers 404 on that particular endpoint. **Both are alive**:
the liveness probe accepts any HTTP response and only treats a refused
connection as "not up yet".

## Rules of the stack

The ones that keep `up.sh` from needing twelve special cases. Breaking any of
these breaks something with no visible error.

**One `compose.specforge.yml` per API.** The upstream `docker-compose.yml` is
never touched — it's part of the corpus, pinned to its SHA. Always invoked
with `-f`.

**Explicit project name: `-p <language>_<impl>`.** Compose infers the project
name from the directory, and `java/spring` and `kotlin/spring` are both
called `spring`. Without `-p` they'd share a project, both generate the
`spring-api` image, and the second build silently overwrites the first — you
boot Kotlin believing you booted Java, with no visible error.

**Port 8000 on the host**, mapped to whatever each API uses internally.
Since only one runs at a time, everything downstream always points at the
same place, and booting a second one fails on a busy port.

**State is ephemeral, on purpose.** No named volumes and no bind mounts over
the data directory: container-based databases go on **tmpfs**, SQLite lives
in the container's writable layer. A fuzzer mutates state; if the database
persists, the second run doesn't reproduce the first and the metrics stop
being valid. Reset = `down` + `up`.

**Healthcheck only on the database.** The app itself carries no healthcheck
in the compose file: the `c_sharp/aspnet` image has no `curl`, `wget` or
`nc`, and adding an HTTP client to every image would move each one twelve
steps further from upstream. The probe runs from the host, inside `up.sh`.
The database does carry one, because that image is ours to control and
`pg_isready` exists there — and `depends_on` alone does **not** wait for the
service to accept connections, only for the container to start.

**`--wait` isn't enough.** With no healthcheck defined, compose reports
`Healthy` immediately: it was measured reporting healthy while the API still
took 3 more seconds to actually respond. It's an optimization, not a
guarantee.

**`up.sh` registers `.active` before booting, not after.** With the reverse
order, a failed `up --wait` aborted the script via `set -e` without leaving a
record, and `down.sh` had nothing to tear down — every failed attempt left an
orphaned database running.

## What each API cost

Almost none of the blockers were the legacy code itself — it was the
infrastructure around it. The full detail lives in the comments of each
`Dockerfile.specforge`; summary:

| API | Real blocker |
| --- | --- |
| `ruby/rails` | Debian 9 is archived (404s on its repos) **and its GPG keys expired** → `[trusted=yes]`; plus `nodejs`, because `uglifier` requires a JS runtime |
| `php/laravel` | Debian 10 is archived; missing `unzip`/`git`/the composer zip extension meant composer couldn't extract anything; and `--no-dev` broke because `config/app.php` registers a `require-dev` provider. Its original Dockerfile was `php-fpm` with no web server — nothing was listening |
| `typescript/nestjs` | `src/config.ts` is in the repo's `.gitignore` (only the `.example` is published) and exports `SECRET`; and `yarn.lock` was out of sync with `package.json` |
| `python/fastapi` | `poetry==1.1` with its transitive `poetry-core` unpinned; and missing `setuptools`, because `aiosql` imports `pkg_resources` |
| `javascript/koa` | `sqlite3 4.0.9` ships no binaries beyond Node 12's ABI |
| `rust/axum` | `sqlx` validates queries **at compile time** against a live database and the repo ships no offline cache: the build boots a Postgres inside itself, migrates, and compiles against it |
| `swift/vapor` | The Dockerfile pinned Swift 5.4.2 against a `Package.swift` requiring tools 5.6 — it couldn't even parse the manifest; and `SECRET_FOR_JWT` was missing |
| `python/django` | Django 1.10.5, from 2017: requires Python 3.5 |
| `java/spring` | Gradle 7.4 doesn't run on JDK 21+ |
| `go/gin` | gorm's SQLite driver is cgo: needs gcc at build time and libc at runtime |

## Provenance

`MANIFEST.tsv` maps every folder to its repo and **SHA**. It isn't
documentation: `up.sh` reads it to resolve language → folder, and since the
clones ship without `.git`, it's the only record of which version each API
is. Without it the corpus stops being reproducible.

The language folder names are the keys of `core_ast`'s
`EXTENSION_TO_LANGUAGE` (hence `c_sharp`), so the mapping is direct. `tsx`
doesn't appear: it's frontend grammar and RealWorld has no `.tsx` backends.

## Consumers

[`tests/core_ast/`](suite.md) tests the pipeline against all 12: the same
contract × 12 sources, 228 pairs. **It never boots them** — `core_ast` reads
source code, it never executes it — so it uses `rw.catalogo` and
`api.fuente` and nothing else. Booting these is only needed once the fuzzing
stage exists.

`corpus.py` also serves as the template for the class EMB is still missing:
its own tests talk to a class, not to shell scripts.
