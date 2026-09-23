# Fixtures

The fixtures under `protocol/fixtures/` are recorded sessions — **one file per
scenario** — the shared record of a real conversation between core and client.
Keeping them separate is what makes them usable as a fake core's script; NDJSON
has no session separator.

## Captured, not hand-written

Every fixture a real session can reproduce is **captured**, not typed by hand. A
harness drives the real core over in-memory pipes against a small resident
project (three endpoints, one of which always answers `500`) and, where the
scenario needs it, an in-process HTTP target on a real loopback socket. The
transcript is written as-is, with the run's own values folded back to fixed
placeholders (the project root becomes `/home/dev/realworld-go`, the target
`http://localhost:8000`, timestamps and durations fixed, versions `0.0.0`).

What a scenario **sends** is therefore contract; what the core **answers** is
whatever it answers today. That split is what the manifest encodes.

## The manifest: how tightly each fixture is held

`fixtures/MANIFEST.toml` declares, per fixture, how the capture gate holds it.
The manifest is a partition: every file on disk has an entry, and every entry
has a file.

| `captured` | What the gate proves |
| --- | --- |
| `exact` | The committed file equals today's capture, line for line. |
| `shape` | The client lines are unchanged, the event kinds match the scenario's declared shape, every line validates, and every reply and event keeps the skeleton the core answers today — counts Hypothesis is free to vary. |
| `none` | Not reproducible by the harness; the entry carries the reason. |

The twelve scenarios: a short operation; a long one with events; a long one with
no token (so not a single event); a cancellation mid-run; domain errors; a
rejected project switch; the `analyze_endpoints` events; the four `run_pipeline`
stages; a build where the engine **does** raise `infra_failure` and
`target_down` (kept `none` — the harness cannot reproduce it cheaply); typed
parameters with a paginated result and a refused enum; a deadline-truncated run;
and an analysis over a repository with no controllers. The last three exist so
that **no event `kind` in the schema goes unexercised**.

## The invalid fixtures are derived, not written

The six sessions under `fixtures/invalid/` — the ones the validator **must
reject** — are each a **declared mutation of the long-with-events fixture**,
re-derived by the same command whenever that fixture is recaptured. A gate
checks both that they re-derive identically and that the validator still rejects
each one for its own reason: a bad `jsonrpc`, an extra envelope key, a missing
token, an unknown notification, an undeclared `kind`, and a reused `id`.

## Refreshing the fixtures

After the core's output changes, from `core/`:

```bash
python -m tests.protocol.regenerate            # every captured fixture
python -m tests.protocol.regenerate 04-cancel  # just one
```

Then run the validator and the capture suite:

```bash
python protocol/validate.py                              # every fixture
python protocol/validate.py fixtures/04-cancel.ndjson    # just one
```

The validator does three passes: each line against the schema (the envelope and,
for an event, the union branch its `kind` picks out, separately); the invariants
a JSON schema cannot express (that `hello` comes first, that every request gets
exactly one response, that no `id` is reused, that every event carries a
declared token and a declared `kind`, that a request with no token receives no
event, that notifications precede their response); and — only when validating
all of them — that every `kind` shows up in some fixture and that every invalid
fixture is rejected for its own reason.

## How a client uses them

There is **no direction marker** in a file: direction is inferred from a
message's shape, so a fixture is pure NDJSON — exactly the bytes on the wire —
and feeds either side with no preprocessing. Both sides consume them:

- The **shipped CLI** uses them as its fake core's script: it reads the expected
  requests and emits the recorded responses and notifications, so the client is
  built and tested with no core present.
- The **core** takes them as `--serve` input: the client's lines are injected and
  its output is compared against the core's own.
