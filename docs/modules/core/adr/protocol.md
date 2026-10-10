# Core — Decision records — Protocol

Part of the [Core decision records](index.md). Decisions about the
core↔frontend wire: how the recorded fixtures stay honest, how versions are
matched, how every reader of a run names and omits the same facts, and how a
session ends.

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

**Status:** accepted · Superseded by [ADR-094](#adr-094) · `adapters/stdio/handshake.py`, `utils/constants.py`

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

---

## ADR-094 — Version negotiation within the series, from a floor { #adr-094 }

**Status:** accepted · Supersedes [ADR-074](#adr-074) · `adapters/stdio/protocol_version.py`, `adapters/stdio/server.py`, `utils/constants.py`

### Context

The shipped frontend is a separate program with its own releases, and the
protocol grows far more often by addition — an operation, an optional
parameter, a result field, an event kind, an error code — than by breaking
change. Under exact equality every addition would refuse every frontend built
against the version before it, although a frontend that ignores keys it does
not know reads an additive reply correctly. Equality on `major.minor` alone is
not safe either: one version inside the `0.1` series renamed keys, and a
client older than it would read the renamed keys as absent.

### Decision

The core serves any client of its own `major.minor` whose patch lies between a
declared floor and its own, comparing each part as a number. It always answers
with its own version; the frontend ignores the keys it does not know. An
additive change bumps the patch; a breaking change — a rename, a removal, a
type change, a parameter made required — bumps the minor. The floor is `0.1.5`,
the version that renamed keys inside the series, and returns to `.0` whenever
the minor moves. Anything outside the range, or a version that is not
`major.minor.patch`, is refused `PROTOCOL_VERSION_MISMATCH` carrying
`expected`, `oldest` and `received`.

### Rejected

Exact equality, which turns every addition into a refusal for every frontend
already released. Per-feature capability negotiation, or answering in the
client's older shape: the core would keep one serializer alive per version it
serves. Serving the whole series with no floor, which would hand a client older
than a rename keys it cannot find.

### Consequences

A frontend and the core release independently within a series. The core never
emits an older shape: an older client receives keys it ignores. A breaking
change has to move the minor, cutting off every older client at once, and the
floor is one constant (`PROTOCOL_OLDEST_SERVED_VERSION`) kept beside the
version. See [Handshake and versioning](../protocol/handshake.md#versioning).

---

## ADR-095 — `shutdown` drains: cancel, wait, answer last, exit { #adr-095 }

**Status:** accepted · `adapters/stdio/server.py`

### Context

A frontend ending a session needs one signal that it may drop the pipe. Work
still running at that moment has two bad endings: killed mid-way, it never
answers and never persists what it gathered; waited on to completion, a long
`fuzz` holds the exit for minutes. A frontend can also vanish without a word,
and the core has to end the same way then.

### Decision

`shutdown` cancels every operation still running, exactly as a
`$/cancelRequest` would, so each answers on its own — a cancelled run keeps and
persists its evidence ([ADR-072](core.md#adr-072)). The core waits for every one
to settle, then answers `{"ok": true}` and exits without reading another line.
EOF on stdin cancels and waits the same way before the core exits. An operation
that is not cancellable runs to its end before `ok`.

### Rejected

Exiting on `shutdown` at once, which loses the answers and the persistence of
everything in flight. Waiting for every operation to finish on its own, which
makes the exit as long as the longest run. Answering `ok` first and draining
afterwards, which tells the frontend to drop the pipe while answers are still
on their way.

### Consequences

The answer to `shutdown` is always the last line of a session, after every
cancelled operation's own reply. The exit takes as long as the slowest
operation that cannot be cancelled, or the slowest inference still in flight.
A script piped into the core keeps stdin open until its answers have arrived:
closing it early cancels what has not finished. See
[Lifecycle](../protocol/handshake.md#lifecycle).
