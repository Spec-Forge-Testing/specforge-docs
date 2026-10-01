# Core — Decision records — Protocol

Part of the [Core decision records](index.md). Decisions about the
core↔frontend wire: how the recorded fixtures stay honest, how versions are
matched, and how every reader of a run names and omits the same facts.

---

## ADR-073 — Protocol fixtures are captured, not written { #adr-073 }

**Status:** accepted · `protocol/fixtures/MANIFEST.toml`, `core/tests/protocol/`

### Context

The core↔frontend protocol needs a shared record of real sessions both sides can
test against. Hand-written fixtures drift from what the core actually emits and
rot silently.

### Decision

Every reproducible fixture is captured by a harness driving the real core, with
the run's own values folded to fixed placeholders; a manifest holds each fixture
as `exact`, `shape` or `none`. The invalid fixtures are declared mutations of one
captured session, re-derived on every recapture. What a scenario sends is
contract; what the core answers is what the manifest permits to vary.

### Rejected

Freezing every byte (`exact` everywhere), which would make every incidental
change a fixture edit.

### Consequences

Fixtures stay honest against the code and refresh with one command; a `shape`
fixture absorbs benign churn while a `none` fixture documents what the harness
cannot reproduce.

---

## ADR-074 — Protocol versioning by exact equality, not negotiation { #adr-074 }

**Status:** accepted · `adapters/stdio/handshake.py`, `utils/constants.py`

### Context

A protocol usually needs version negotiation because client and server evolve
independently. Here every frontend ships with its own core inside, so they
cannot drift out of sync — and there is no supported way to point a frontend at
an external core.

### Decision

The handshake compares versions by **exact equality**: a mismatch answers
`PROTOCOL_VERSION_MISMATCH` and the frontend aborts. No negotiation, no
capability downgrade, no backward-compatibility promise across versions.

### Rejected

Semantic version ranges and capability negotiation — machinery for a drift that
cannot occur, and a surface for pointing at an untrusted external core.

### Consequences

The handshake is a cheap sanity check, and the protocol can make breaking
changes freely between versions (the changelog is honest about which are
breaking).

---

## ADR-085 — Every reader of a run says the same thing under the same name { #adr-085 }

**Status:** accepted · `models/results.py`, `services/report/models.py`, `protocol/README.md`

### Context

A stored run reaches a frontend through several readers: `list_runs` and
`get_run`, `list_analyses` and `get_analysis`, and the report document that
`fuzz`, `replay` and `run_pipeline` answer with. A frontend that shows more than
one of them — a history list beside an opened report — has to put the same fact
side by side without translating between names. It also has to tell "there is
nothing to say" from "the value is empty", which it cannot do when absence is
spelled as an empty string.

### Decision

One concept has one name in every reader, the name the store uses: an
analysis's `generated_against_repo_hash`, an endpoint's `findings_confirmed`, a
finding's `represented_findings`. A missing fact is `null`, never `""`; an empty
collection is `[]` or `{}`. The values a frontend branches on are closed
vocabularies, catalogued once in [Result vocabularies](../protocol/vocabularies.md):
a field takes only the values listed there, and a new value is a protocol change
with its own changelog entry.

### Rejected

Names tuned to each reader, which would make every frontend keep a translation
table and let a field drift from its twin in another reader. And `""` as
absence: an empty string is a real value on this wire — an unconfirmed finding's
`body_fingerprint` of `""` means the response had no body.

### Consequences

A frontend reads a fact with the same code wherever it appears, and branches on
`null` without a second test for `""`. The vocabularies page is the single
enumeration of those values; every other page links to it instead of repeating
it. The price of one name across readers is that changing a name is a breaking
change for all of them at once, recorded as such in the
[handshake changelog](../protocol/handshake.md) and in the report document's
`schema_version`.
