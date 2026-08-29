# Contract Engine — Decision records — Ingestion

Part of the [Contract Engine decision records](index.md). Ingestion-stage
decisions: how a spec file becomes a `ResolvedContract` — which `$ref` pointers
are followed, what happens to the ones that cannot be, and what it means when
the conformance validator itself fails to run.

---

## ADR-052 — A `$ref` that names nothing is pruned and reported, not raised over { #adr-052 }

**Status:** accepted · `ingestion/references.py`, `ingestion/facade.py`

### Context

A generated spec can reference a schema its generator never emitted. Four of the
36 EMB contracts do: `ocvn` points at `#/definitions/TextSearchRequest`,
`ohsome-api` at `#/definitions/LngLatAlt`, `proxyprint` at three of them, and
`quartz-manager` at `#/components/schemas/SchedulerDTO`. The schemas are simply
absent from the documents.

The resolver follows the pointer, finds nothing, and gives up on the **whole
document**. One broken reference cost those four contracts every endpoint they
describe correctly — 192, 134, 115 and 11 of them — and the pipeline stopped
before static analysis ever saw them.

The conformance validator is no better: it follows a Reference Object despite
judging validity over the object itself rather than its target, so a broken
pointer stops it from reporting anything at all about the rest of the document.

### Decision

Before resolution runs, every same-document `$ref` naming no node has its
`$ref` key dropped and becomes one `DANGLING_REFERENCE` deviation, anchored
where the broken pointer sits rather than at the destination that does not
exist.

Dropping the key rather than the node leaves `{"$ref": "#/x"}` as `{}` — the
empty schema it already effectively means — and keeps any siblings. The document
is copied, not edited, so conformance still judges it as written; the copy is
only made when there is something to prune, so the common path pays nothing.

The conformance validator gets the pruned copy for the same reason the resolver
does. The pointers it no longer sees are already reported by their own
deviation, so nothing is lost and every other defect in the document is still
found.

`DANGLING_REFERENCE` is classified as a document defect: the pointer really is
wrong, and the document really is the thing that is wrong.

### Consequences

A contract with a broken pointer now ingests with a schema weaker than its
author intended — `{}` accepts anything, so an endpoint whose body referenced
the missing schema is fuzzed without that constraint. That is accepted: the
alternative was not a stricter contract but no contract at all.

The four contracts ingest with zero unresolved references, and their endpoints
match expectations derived by hand from the sources long before this change.

---

## ADR-053 — A truncated cycle's marker carries `x-recursive` { #adr-053 }

**Status:** accepted · `ingestion/resolution.py`

### Context

A recursive schema is legal and common. The resolver inlines it once and then
truncates, leaving a `$ref` behind in the resolved spec. prance flags its own
truncation markers with `x-recursive: true`, and the repository's environment
tests record that shape as the convention.

The handler was replaced with one of our own so the marker names a location
relative to the document instead of prance's absolute URL, which would write the
machine's filesystem path into the contract. In the process the marker was
dropped: all three of the handler's return paths emitted a bare `$ref`.

Nothing distinguished the two kinds of surviving `$ref` any more. A pointer left
by a truncated cycle is expected; a pointer left by anything else is a defect.
Reading the resolved spec, 129 cycle markers across six EMB contracts and 343 in
one polyglot contract were indistinguishable from unresolved references.

### Decision

All three return paths build the marker through one constructor that sets
`x-recursive: true` alongside the `$ref`. `TRUNCATION_MARKER` is public, because
consumers of a resolved spec need to name the flag to tell the two cases apart.

### Consequences

A `$ref` node in a resolved spec now carries a sibling key. Anything matching on
the node's exact shape — rather than on the presence of `$ref` — sees a
different object; the tests that did were asserting a shape, not the property
their own docstrings described, and now assert the marker as well.

---

## ADR-054 — A validator that cannot run reports instead of deciding the verdict { #adr-054 }

**Status:** accepted · `ingestion/facade.py`, `ingestion/conformance.py`

### Context

The Ktor contract in the polyglot corpus was rejected with
`SchemaComplexityError: Spec is too deeply nested to validate`. The diagnosis was
false: the document is 10 levels deep and its resolved form 22.

The real cause is twelve cycles between its schemas — `SearchOperatorDate` to
`SearchOperatorIsNotNull` and back, among others — which
`openapi_spec_validator`'s property collection follows without a cycle guard. It
is an infinite loop, not a deep chain: raising the recursion limit to 3 000 and
to 12 000 fails identically. Validating the resolved spec instead does not help
either, because `components/schemas` still holds the cycles.

Meanwhile the contract resolves cleanly, with zero unresolved references, and
its 174 endpoints extract whole. What failed was a **reporting** step, and the
module's own entry point already states that a finding which does not prevent
building the contract is reported rather than rejecting the spec.

### Decision

A `SchemaComplexityError` raised while *validating* becomes one
`CONFORMANCE_NOT_ASSESSED` deviation and the contract is delivered. The same
exception raised while *resolving* still rejects, because there no spec exists to
deliver.

Saying so is not optional. An empty deviation list means "validated, nothing
found" — the CLI counts document defects off it — and here nobody looked. The
code is classified as a finding rather than a document defect: the spec that
could not be read may well be flawless, and the component that failed is ours.

The exception's reason no longer names deep nesting alone. From inside a
`RecursionError` the two causes are indistinguishable, and naming only one
states a cause nobody measured.

### Consequences

A contract can now reach fuzzing without ever having been checked for
conformance. That is honest degradation, not a fix: the underlying defect
belongs to `openapi_spec_validator`, and the deviation is what keeps the gap
visible instead of silent.

A test for this behaviour must use a cycle, not depth. A document deep enough to
exhaust the stack does so only relative to the frames already on it, so a
depth-based fixture passes alone and fails inside a full suite run. The cyclic
shape defeats the validator whatever margin is left.
