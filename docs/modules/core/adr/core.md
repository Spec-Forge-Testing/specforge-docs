# Core — Decision records — Core

Part of the [Core decision records](index.md). Decisions about the headless
core: how a run explains an endpoint it did not probe, how optional libraries
are owned, how the busy guard is scoped, what a cancelled or a safety-breached
run keeps, and how a run's oracle scope bounds a comparison.

---

## ADR-069 — A targeted endpoint records why the run had nothing to probe { #adr-069 }

**Status:** accepted · `services/history/models.py`, `services/persistence/vocabulary.py`, `services/report/html.py`

### Context

An auth run crosses declared identities against each endpoint's access policy,
but a `public` endpoint (nothing to cross) and one with no declared access
policy both send zero requests — indistinguishable, at the wire, from an
endpoint the run never reached.

### Decision

The endpoint's zero-request stats carry a typed reason (`declared_public` /
`access_undeclared`), which travels through storage into the report as
`unprobed_reason`. A public skip is complete evidence and never degrades the
run's signal; a missing access policy degrades it as `access_policy_undeclared`.

### Rejected

Inferring the reason downstream from the access section alone, which cannot see
what the runner actually chose to do.

### Consequences

Every "silent" endpoint is now explained; the report gains `unprobed_reason` and
the signal gains a cause. The distinction is made where the run happens and
carried forward, never reconstructed.

---

## ADR-070 — One importer per optional library: the dependency gateways { #adr-070 }

**Status:** accepted · `services/deps/`

### Context

The core depends on six libraries that may be absent, and several services need
the same one. Scattered `try/except` imports let two services answer differently
about the same library, and made "is it installed?" a question with many owners.

### Decision

A gateway per library under `services/deps/` is the sole runtime importer of its
own; it returns a `Dependency` value object (present, or absent with the import
failure's reason) and the symbols the core uses. Callers ask the gateway and
raise their own typed error. A library that raises on import counts as absent. An
AST test enforces single ownership.

### Rejected

A central plugin registry, heavier than six leaf modules; and lazy per-call
imports, which reintroduce scattered ownership.

### Consequences

One truth per library; a graceful boot without any of them; `doctor` can name
the reason and tell "installed but not yet loaded" from "missing".

---

## ADR-071 — The busy guard registers only the operations that use the session { #adr-071 }

**Status:** accepted · `adapters/stdio/server.py`, `domain/operations.py`, `errors/session.py`

### Context

Switching or closing the active project while work is in flight would corrupt
that work, so a switch must be refused while anything runs. But not every
operation touches the session, and the two operations that *are* the switch
(`open_project`, `close_project`) would deadlock if they counted themselves as
in-flight.

### Decision

The guard registers an operation under its request id only when it takes the
session and does not itself switch the project; a project-switching or
session-free operation is invisible to the guard. A switch attempted while the
registry is non-empty is refused with `PROJECT_SWITCH_REJECTED`, listing what is
still alive.

### Rejected

A single global lock, which would serialize unrelated reads; and counting every
operation, which would deadlock the switch.

### Consequences

A switch is safe and self-describing, and the switch operations never block
themselves.

---

## ADR-072 — A cancelled run keeps and persists its evidence { #adr-072 }

**Status:** accepted · `services/history/rules.py`, `domain/cancellation.py`

### Context

A run cancelled mid-flight has already gathered findings and stats; discarding
them on cancellation throws away real evidence.

### Decision

Cancellation seals what the run had and persists it; the run ends `cancelled`
with a non-null report, and its signal degrades with `run_cancelled` rather than
claiming completeness. A cancelled `run_pipeline` answers with the stages that
had already finished.

### Rejected

Treating cancellation as failure and dropping the partial run, which would make
Ctrl+C destroy evidence the user paid for.

### Consequences

`inspect` and `report` show what a cancelled run reached; `compare` and the
signal treat it as incomplete-but-real.

---

## ADR-087 — A run declares its oracle scope, and a comparison across scopes is inconclusive { #adr-087 }

**Status:** accepted · `services/compare/rules.py`, `services/persistence/mapper.py`; engine `EngineRunResult.oracle_scope`

### Context

Not every run judges its responses with the same oracles. A replay re-sends a
recorded trace and applies only the checks that need no contract, such as the
server-error one. Comparing its defects against a run judged by the full
contract would report as `possibly_resolved` every contract violation the replay
simply did not look for.

### Decision

The engine result states which oracles judged the run: `oracle_scope` is
`contract` unless the mode says otherwise, and the replay runner sets
`contract_free`. The core copies it onto every run it persists, original or
replay, and the run record requires it: the column has no default and the store
rejects any value outside the two. `compare_runs` adds the pair caveat
`oracle_scope_differs` when the two scopes differ; like every pair caveat, it
turns a defect missing from the later run into `inconclusive` instead of
`possibly_resolved`.

### Rejected

Inferring the scope from the run's origin, replay or original: it ties a fact
about judging to a fact about provenance, and a mode that judges without the
contract without being a replay would be misread. A nullable column, or one with
a default: a write path that forgot the scope would record `contract` silently,
and the comparison would trust it.

### Consequences

Every run carries its scope in `list_runs`, `get_run` and the report document
(values in [`run.oracle_scope`](../protocol/vocabularies.md#oracle-scope)); a
cross-scope comparison says so with its own
[caveat](../protocol/vocabularies.md#caveats) instead of guessing. The engine
keeps `contract` as its default, so a new mode that judges without the contract
must set the scope itself; the store guarantees only that every run states one.

---

## ADR-088 — A run that breached the safety guard is persisted with its evidence { #adr-088 }

**Status:** accepted · `services/fuzz/runner.py`, `controllers/execution.py`, `services/history/rules.py`

### Context

The safety guard holds back routes a run must not exercise: a route flagged as a
write or as having external side effects, in a mode that holds that flag, or a
follow-up outside the run whose method is not a safe one. If
requests still reach one of them, the engine fails loud: it raises
`SafetyGuardBreachError` naming the held routes that were reached and how many
requests reached them, with the run's result attached and marked
`safety_breached`. Treating that error as a failure would discard the run's
findings, its stats and the proof of which held routes were hit — exactly what
the user needs to see.

### Decision

The core catches the breach, takes the attached result and persists the run
like any other, with the stored status `safety_breached`. The operation that ran
it answers `status` `safety_breached`. Inside `run_pipeline`, the execution stage
ends `failed` and the pipeline answers `safety_breached`: a breach outranks a
cancellation, which outranks a failure. The run's comparability is
`safety_breached`.

### Rejected

A failed, unpersisted run, which loses the evidence. Recording it as
`completed`, which hides the breach behind a clean status. Storing it as
`failed`: a failed run is by definition one that never reached persistence, so
the stored vocabulary keeps `failed` out.

### Consequences

History, `inspect` and the report show the breach and what the run gathered;
`compare_runs` treats the run as not comparable and names the reason. This is
the sibling of [ADR-072](#adr-072): a run that stops abnormally keeps its
evidence, and its status says why. The cost is one more terminal value every
frontend branches on, in [`run.status`](../protocol/vocabularies.md#run-status),
[operation status](../protocol/vocabularies.md#operation-status) and
[comparability](../protocol/vocabularies.md#comparability).
