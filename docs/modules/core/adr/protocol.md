# Core — Decision records — Protocol

Part of the [Core decision records](index.md). Decisions about the
core↔frontend wire: how the recorded fixtures stay honest, and how versions are
matched.

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
