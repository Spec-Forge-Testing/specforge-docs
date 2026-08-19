# Core AST — Decision records

Decisions taken while building `core_ast` that are not obvious from reading the
code, and that someone would otherwise be tempted to undo. Each record states the
situation that forced the decision, what was decided, and what it costs.

They are append-only and numbered in the order they were written down. A record
is never edited to reflect a later change of mind — a new record supersedes it.

!!! info "The rule these decisions answer to"
    **Being wrong is worse than not finding.** If the pipeline hands back the
    wrong handler, the LLM infers another endpoint's business rules, and those
    false invariants become false findings against the endpoint under test. A
    miss costs five minutes; a confident wrong answer poisons everything
    downstream. When in doubt, raise.

---

## ADR-001 — Build output and dependency directories are excluded from the scan

**Status:** accepted · `locator/scanner.py`

### Context

`scan_repository` walks the whole repository and hands the locator a list of
candidate files. A project that commits its build output — the NestJS
implementation of the RealWorld corpus publishes its `dist/` — has **two copies
of every controller**: the source and the compiled artefact. Both contain the
route declaration, so the locator matched the endpoint twice, reported an
ambiguity and returned nothing. The endpoint was untestable because the project
was well organised.

### Decision

Paths under any directory named in `LOCATOR_EXCLUDE_DIR_PATTERNS` are dropped
during the scan: `node_modules`, `vendor`, `dist`, `build`, `out`, `target`,
`bin`, `obj`, `.git`, `.venv`, `venv`, `__pycache__`, `.next`, `.nuxt`,
`coverage`.

The tracer already excluded a similar set through `TRACER_EXCLUDE_DIR_PATTERNS`;
this puts the locator in agreement with it rather than leaving each stage with
its own idea of what counts as source.

### Consequences

A project whose only source genuinely lives under one of those names is
invisible to the locator, and the endpoint fails with `ControllerNotFoundError`.
That is accepted: the alternative is an ambiguity that returns nothing anyway, or
worse, silently picking the compiled copy — which is the wrong answer the
governing rule exists to prevent.

---

## ADR-002 — The repository scan is cached per repository, and what is cached is immutable

**Status:** accepted · `locator/scanner.py` · closes [AI-132](https://linear.app/ai-pbt/issue/AI-132)

### Context

`locate_controller` scans the repository once per endpoint, so analysing a
contract walked the same tree once per route. Measured against EMB's
`familie-ba-sak` (Kotlin/Spring, 7 410 files): 0.24 s per walk, and 5.1 s to
locate eight endpoints.

### Decision

`scan_repository` became a thin wrapper over `_scan_cached`, an `lru_cache`d
function keyed by `repo_root` and bounded by `LOCATOR_SCAN_CACHE_SIZE` (16).

Two details are deliberate:

- **`_scan_cached` returns a tuple, and `scan_repository` copies it into a
  list.** Handing callers the cached container would let any one of them mutate
  it and corrupt the result for everyone after. The public signature still
  returns `list[Path]`; the copy is what makes that safe.
- **The bound is 16, not a handful.** A normal run analyses one repository, but
  the corpus suite walks the twelve RealWorld implementations in a single
  process; with a smaller cache they would evict each other and the cache would
  do nothing exactly where it is exercised most.

### Consequences

Eight endpoints over `familie-ba-sak` went from 5.1 s to **3.4 s** — one walk
instead of eight. The corpus suite went from 47 s to 42.6 s.

Two known deviations from the ticket that asked for this:

- It asked for the index to live *in the orchestrator or the session, not as
  hidden global state*. What exists is module-level state. Honouring the request
  would change `locate_controller`'s signature and reach into `core/`, outside
  this package's boundary.
- The ticket's stated problem is O(N·M) in **both** the tree walk and the regex
  pass over candidate files. Only the walk is cached; every endpoint still reads
  and matches all candidates, which is the larger half of the cost.

---

## ADR-003 — The scan cache is invalidated explicitly, never automatically

**Status:** accepted · `locator/scanner.py`

### Context

An `lru_cache` lives as long as the process. A one-shot CLI invocation never
notices, but the REPL is long-running: run `trace`, edit a source file, run
`trace` again in the same session, and the second run would still see the file
list from the first.

Detecting that the repository changed would mean walking the tree to compare it —
which is precisely the cost the cache exists to avoid.

### Decision

`clear_scan_cache()` is public, and freshness belongs to the caller. A
long-running host calls it between runs; a one-shot process never has to.

### Consequences

The package cannot guarantee on its own that its answer reflects the current
state of disk — it guarantees that it reflects the state at the first scan of
this process. Any host that keeps a session open across edits is responsible for
saying when to forget.
