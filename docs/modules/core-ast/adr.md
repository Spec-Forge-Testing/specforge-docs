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

---

## ADR-004 — Constants live with the stage that uses them

**Status:** accepted · every stage · supersedes the single `cte/constants.py`

### Context

Every constant in the package lived in one 155-line `cte/constants.py`, and the
only namespace was a prefix in the name (`LOCATOR_`, `TRACER_`, `AST_BUILDER_`).

Measuring which stage actually imports which constant showed two things:

- **Of twenty constants, exactly one is used by more than one stage.**
  `EXTENSION_TO_LANGUAGE` is read by `ast_builder`, `locator`, `quality` and
  `tracer`. Every other constant had a single consumer.
- **The prefixes were lying.** Eight of the nine `TRACER_*` constants are
  consumed by `quality`, not by the tracer — thresholds, budget limits, the
  critical-keyword list. Only `TRACER_NON_TRACEABLE_CALLS_BY_LANGUAGE` belongs to
  the tracer. `models/tracer_result.py` appeared to be a second consumer of the
  thresholds, but only names them in a docstring; it does not import them.

A shared module that is 95% private to one consumer is not a shared module. It
just makes every stage's constants look like everyone's business, and lets a
prefix drift away from the code it names.

### Decision

One `constants.py` per stage, holding what only that stage uses.
`cte/constants.py` keeps what **two or more** stages share — today
`EXTENSION_TO_LANGUAGE` and the `words()` helper that builds the vocabularies,
and nothing else.

Names lose the stage prefix, because the module now provides it:
`TRACER_MAX_FILES` becomes `quality.constants.MAX_FILES`.

A data file moves with the constant that points at it: `patterns.toml` now lives
in `locator/`, its only reader, which also removes the `parent.parent` walk that
`PATTERNS_PATH` and `AST_BUILDER_TAGS_DIR` needed to climb out of `cte/`.

### Consequences

`cte/constants.py` went from 155 lines to 22. Each stage's table is small enough
to read whole, and a constant's blast radius is visible from where it is
declared.

Promoting a constant to `cte/` is now a deliberate step rather than the default.
That is the point: it forces the question of whether both stages really mean the
same thing by it.

The cost of dropping the prefixes is that two stages now declare
`EXCLUDE_DIR_PATTERNS` with **different contents** — the locator excludes build
output and dependencies, `quality` also excludes tests, migrations and generated
code. Same name, different meaning, which the old prefixes hid rather than
solved. No module imports both today; one that needs to will have to alias.
