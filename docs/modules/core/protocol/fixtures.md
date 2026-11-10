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

The seventeen scenarios:

| File | Scenario | Captured |
| --- | --- | --- |
| `01-short` | A short operation | `exact` |
| `02-long-with-events` | A long operation with events | `shape` |
| `03-long-no-token` | A long operation with no token, so not a single event | `shape` |
| `04-cancel` | A cancellation mid-run: the run keeps and persists what it had | `shape` |
| `05-domain-error` | Domain errors: no project, a value outside its enum, an unknown operation | `exact` |
| `06-project-switch-rejected` | A project switch rejected by operations still alive | `shape` |
| `07-analyze-endpoints` | The `analyze_endpoints` events, plus an inline payload | `shape` |
| `08-run-pipeline` | The four `run_pipeline` stages; with no producer, `inference` ends `skipped` | `shape` |
| `09-engine-events` | A build where the engine **does** raise `infra_failure` and `target_down`: the API goes down, the result is `status: failed` and the document's `run.status` is `aborted` (the harness cannot reproduce it cheaply) | `none` |
| `10-typed-parameters` | A `fuzz` with a fixture producer, whose `contract_*` events all precede the engine's, with typed parameters, a paginated `get_run` and a refused enum | `shape` |
| `11-deadline-truncated` | A `fuzz` under a per-endpoint deadline nothing can meet: `truncated`, and the run still ends with a result | `shape` |
| `12-analysis-unresolved` | An analysis over a repository with no controllers: every endpoint fails, and the payload request is refused | `shape` |
| `13-contract-production` | A `fuzz` whose fixture contract the core cannot project: `contract_failed` (`aborted`) before the engine, and the run fails `CONTRACT_PRODUCER_FAILED` | `shape` |
| `14-flaky-generation-truncated` | A stateful run cut by `flaky_generation`: a `truncated` event with no `endpoint`, and `run.truncation.endpoint_id` `null` | `none` |
| `15-replay-run` | A `fuzz`, then a `replay` of its whole analysis, read back through `get_run`, `list_runs` and `get_finding` | `shape` |
| `16-stateful-finding` | A stateful `fuzz` whose finding's `replay_alone` is refused with `reason` `stateful` | `shape` |
| `17-regional-locale` | A `hello` that asks for `es-AR` is served `es`: its vocabulary and fuzz options come in Spanish | `exact` |

`11`, `12` and `13` exist so that **no event `kind` in the schema goes
unexercised**.

No fixture records `estimate_inference` or the approval flow: an estimate
carries a model's price, which no placeholder can hold still, so the core's own
tests cover that flow.

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

The envelope does not type a `result`'s content. The validator types three results
by correlating on `id`: `hello`'s, `list_endpoints`' and `get_endpoint`'s, against
`hello_result`, `list_endpoints_result` and `get_endpoint_result`. What keeps a
captured fixture's other results honest is the `shape` check above.

## How a client uses them

There is **no direction marker** in a file: direction is inferred from a
message's shape, so a fixture is pure NDJSON — exactly the bytes on the wire —
and feeds either side with no preprocessing. Both sides consume them:

- The **shipped CLI** uses them as its fake core's script: it reads the expected
  requests and emits the recorded responses and notifications, so the client is
  built and tested with no core present.
- The **core** takes them as `--serve` input: the client's lines are injected and
  its output is compared against the core's own.
