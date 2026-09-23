# Core — Decision records — Core

Part of the [Core decision records](index.md). Decisions about the headless
core: how a run explains an endpoint it did not probe, how optional libraries
are owned, how the busy guard is scoped, and what a cancelled run keeps.

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
