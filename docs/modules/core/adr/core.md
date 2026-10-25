# Core — Decision records — Core

Part of the [Core decision records](index.md). Decisions about the headless
core: how a run explains an endpoint it did not probe, how optional libraries
are owned, how the busy guard is scoped, what a cancelled or a safety-breached
run keeps, how a run's oracle scope bounds a comparison, how the engine options
resolve, when the inference gateway loads, how a finding's summary is told, and
how a replay judges the defects it re-sends.

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

**Status:** accepted · Superseded in part by [ADR-097](#adr-097) · `services/deps/`

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

**Status:** accepted · Superseded in part by [ADR-101](inference.md#adr-101) · `services/history/rules.py`, `domain/cancellation.py`

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

---

## ADR-096 — Engine options resolve request over project over default, and credentials never ride them { #adr-096 }

**Status:** accepted · `services/config/definitions.py`, `services/config/service.py`, `services/config/credentials.py`, `services/config/runtime.py`, `controllers/execution/plan.py`

### Context

A project fixes its engine settings in `specforge.toml`, and a single call may
want a different timeout or concurrency for one run. Both reach the same engine,
so a run needs one rule for which value wins. A value in the file is typed by
hand, and nothing guarantees it is of the option's type or inside its range;
read as written, a bad one surfaces deep in the engine as an unrelated error. A
header map applied to every request is also the easiest place to paste a token,
and a run records the headers it sent.

### Decision

A run resolves each `engine.*` option once, before anything is produced: the
request's own `timeout_s` and `max_concurrency` when given, else the project's
`specforge.toml`, else the code default; `max_retries`, `backoff_base` and
`headers` come from the file or the default. The file's values are checked by
the same coercion as a value in a call, on every operation that reads them, and a
failure is `INVALID_PARAMS` naming the key and `source: "specforge.toml"`.
`set_config` refuses `null` and checks the merged file before writing it;
`reset_config` never checks, so a broken file always has a way out.
`engine.headers` refuses a credential header by name, and a recording keeps
header names only; `replay` re-reads the values from the project it runs in.
Credentials go through the identities file.

### Rejected

Letting the file win over the request, which makes a one-off run impossible
without editing the project. Reading the file as written and failing in the
engine, which reports the wrong cause far from the bad key. Accepting credential
headers and redacting them on the way out, which keeps a secret in the project
file and in every recording that names it.

### Consequences

One precedence for every run, published on every `get_config` row as its
`layer`. A bad project file is refused at the first operation that reads it, with
the key and the reason. A replay of a recording made under other headers sends
the current project's values. See [Configuration](../configuration.md).

---

## ADR-097 — The `ai` gateway loads on first use, once, with a single owner { #adr-097 }

**Status:** accepted · Supersedes in part [ADR-070](#adr-070) · `services/deps/ai.py`

### Context

The gateways import their library when their module is imported, so the core's
start pays for all six. The semantic inference package pulls in the LLM stack,
a heavy import, and most sessions — opening a project, fuzzing from
the spec, reading results — never infer. Importing it on demand inside each
caller would bring back the scattered `try/except` imports the gateways exist to
remove.

### Decision

The `ai` gateway stays the only importer of the package, but loads it on the
first call to its `api()`, under a lock, and caches the answer — present or
absent with its reason — for the life of the process. Every caller still asks
the gateway; nobody else imports the package.

### Rejected

Keeping the import at module load, which makes every start pay for a library
most sessions never use. Per-call imports in each service that needs it, which
splits ownership again. A background warm-up after start, which spends the same
time and adds a race with the first caller.

### Consequences

The core starts without the LLM stack. The first inference, estimate or
`diagnose` pays for the import once. The answer is still cached per process, so
the doctor's "installed but not yet loaded" verdict keeps its meaning after that
first use.

---

## ADR-125 — The report names an accepted invalid input and an endpoint the engine could not explore { #adr-125 }

**Status:** accepted · Superseded in part by [ADR-148](../../specforge-engine/adr/findings.md#adr-148) · `utils/constants.py`, `services/report/constants.py`, `repl/views/formatting.py`, `repl/views/fuzz.py`, `adapters/stdio/engine_log.py`, `adapters/stdio/server.py`; `protocol/README.md`

### Context

The engine reports two facts a client must show. A 2xx that accepted a value
outside the declared schema of the field the request poisoned is an
`input_validation` finding whose rule id names that field
([ADR-118](../../specforge-engine/adr/engine.md#adr-118)). An endpoint whose
exploration raised inside the engine is cut with the truncation reason
`engine_failure`, and the run goes on `truncated`
([ADR-120](../../specforge-engine/adr/engine.md#adr-120)). The report labels a
contract-declared rule "Business rule", which is wrong for a schema the spec
declared.

### Decision

**The report document is `schema_version` 1.18, additive over 1.17.** It adds one
value to the invariant vocabulary and one to the truncation reasons. No key
changes, the protocol version does not move, and no stored column changes: neither
`findings.invariant_violated` nor a `truncation_reason` column constrains its
values.

**A declared rule is labelled by its invariant.** `DECLARED_RULE_LABELS` maps each
invariant whose rule the contract declares to its label: "Business rule" for
`semantic_property` and `access_control`, "Declared schema" for
`input_validation`. `DECLARED_RULE_INVARIANTS` is derived from that table, and a
test pins it to the engine's own set, so a new declared invariant without a label
fails the suite. The REPL shows the finding as `invalid input accepted · <zone>.<field>`.

**An engine failure is readable without the log.** The REPL's headline for
`engine_failure` names the endpoint, says it was isolated and points at the core's
stderr. While the server owns stdout, the engine's `specforge_engine` logger writes
its `ERROR` records, tracebacks included, to stderr.

### Rejected

- **A protocol version bump.** No message, operation or event changed shape; the
  run document's vocabularies grew.
- **Keeping one scalar label for every declared rule.** It would call a schema
  violation a business rule.

### Consequences

A client that reads the report shows the accepted field and the isolated endpoint
with the vocabularies it already renders. A client that branches on the truncation
reason meets one more value, listed with the others in the
[result vocabularies](../protocol/vocabularies.md#truncation-reason) and in the
[changelog](../protocol/handshake.md#changelog).

---

## ADR-139 — The report names five security findings and ranks them right after a server error { #adr-139 }

**Status:** accepted · Superseded in part by [ADR-148](../../specforge-engine/adr/findings.md#adr-148) · `utils/constants.py`, `services/report/ordering.py`, `repl/views/formatting.py`; `protocol/README.md`

### Context

The engine reports five security invariants: `information_disclosure`,
`sensitive_data_exposure`, `reflected_payload`, `mass_assignment` and
`input_induced_timeout` ([ADR-131](../../specforge-engine/adr/engine.md#adr-131)).
Each cites a rule the engine derives from the request it judged, so each is a
declared rule. The report ranks findings by `INVARIANT_SEVERITY`, and an invariant
missing from it ranks last, below a wrong `Content-Type`.

### Decision

**The report document is `schema_version` 1.19, additive over 1.18.** The
invariant vocabulary grows by five values. No key changes and the protocol
version does not move.

**Each invariant has its own label.** `DECLARED_RULE_LABELS` gives each one a rule
label of its own (Information disclosure, Sensitive data exposure, Reflected
payload, Mass assignment, Input-induced timeout), and `DECLARED_RULE_INVARIANTS`
is derived from that table, pinned to the engine's set ([ADR-125](#adr-125)). The
REPL gives each a short headline label.

**They rank right after `not_a_server_error`.** `INVARIANT_SEVERITY` lists them
after the crash and ahead of `state_transition` and the conformance checks: an
attack that leaks, exposes or takes a privileged key is more severe than a
response that drifts from its contract.

### Rejected

- **One "Security" label for the five.** The reader could not tell a leak from a
  reflected script without opening each finding.
- **Ranking them above a server error.** A crash is the one defect the engine
  reports on any request, attacked or not; it stays first.

### Consequences

A client that renders the invariant vocabulary shows the five findings with the
labels the report carries. A client that sorts by severity sees them near the top.
The change is listed in the [changelog](../protocol/handshake.md#changelog).

---

## ADR-146 — The run's URL is composed once, with the specification's server path, and a follow-up keeps its trigger's server { #adr-146 }

**Status:** accepted · `services/fuzz/target.py`, `controllers/execution/plan.py`, `services/fuzz/runner.py`, `services/fuzz/projection/transitions.py`, `controllers/execution/translation.py`; engine `runtime/fuzzers/stateful/transitions.py`, `runtime/fuzzers/stateful/probes.py`

### Context

An OpenAPI document can declare its server with a path, `servers: [{url:
http://host/api}]`, and its paths under it: `/users` lives at `/api/users`. The
user gives a target URL (`http://localhost:8000`, or `http://localhost:8000/api`).
Two paths lead to the engine, the protocol's `plan_run` and the integrated REPL's
`run_fuzzing`, and the engine's `EndpointSpec.base_url` already means "a full
override URL for this endpoint". Adding the prefix in one path leaves the other
without it; adding it per endpoint gives `base_url` two meanings. A stateful
transition's follow-up path may also be written with the prefix, and its probe
went to the run's URL even when its trigger had its own.

### Decision

**One pure function composes the run's URL, and both paths call it.**
`run_target_url(target_url, endpoints)` takes the server path the run's endpoints
share (`server_path_of`) and composes it into the target URL
(`compose_target_url`):

- the comparison is by whole path segments, never by string suffix: a target that
  already ends in the server path (`/api`, `/v1/api`) is left as given, and
  `/xapi` does not end in `/api`;
- scheme, credentials, host, port, query and fragment are kept;
- a target URL that cannot be split is handed to the engine as given, so the
  engine's own validation names what is wrong with it;
- endpoints that disagree on their server path are a contract the run cannot
  address. `ConflictingServerPathError` is refused over the protocol as
  `UNSUPPORTED_SCHEMA` at the location `servers`, and has its own report code,
  `fuzz_conflicting_server_path`.

`EndpointSpec.base_url` keeps its single meaning, a per-endpoint override, and
the core no longer sets it.

**A follow-up path is normalized once, where the transition is adopted.**
`merge_transitions` strips a leading server path from the follow-up path, by whole
segments, so the engine sees one spelling and its routing, its vetoes and its
injector agree without change.

**A follow-up goes to its trigger's server.** The probe of a transition inherits
the triggering endpoint's `base_url`, and falls back to the run's URL when the
trigger has none.

### Rejected

- **Composing in `plan_run` only.** The REPL path would run without the prefix.
- **Composing per endpoint in the engine's injector.** `base_url` would mean two
  things, and the engine's `BaseUrl` type rejects a bare path.
- **Stripping the prefix in each of the engine's three route readers.** The same
  rule in three places drifts apart; one normalization at the boundary does not.

### Consequences

`started` and `target_down` report `base_url` as the URL the run's requests go to,
the server path included. The recipe stores that URL without credentials, and a
replay re-sends the recorded URLs, so replay is unchanged. The inference cache key
leaves the server path out, so a cached contract stays valid.

---

## ADR-153 — A finding's one-sentence summary is told by the core when it reads the finding, by one strategy per invariant { #adr-153 }

**Status:** accepted · `services/finding_summary/`, `services/report/builder.py`, `services/fuzz/observer.py`, `services/explanation/`

### Context

A finding's fields say what broke, but a person reads a sentence first: which
endpoint, what it answered, to what. A frontend that composed that sentence
would need to know every invariant's observation ([ADR-149](../../specforge-engine/adr/findings.md#adr-149)),
and each frontend would tell it differently. The finding is read in four places,
from four sources: the live `finding` event, the report a run answers with, and
a stored confirmed or unconfirmed finding read back.

### Decision

**`finding_summary` tells the sentence from a `SummaryFacts`, when the finding is
read.** One adapter per source builds the facts; `SENTENCES` maps each invariant
to a `SentenceStrategy` over shared rendering helpers: the endpoint as
`` `METHOD /path` ``, a value as compact JSON clipped to 48 characters, the
request's poisoned field or trigger fields with the values the minimal payload
sent. A finding that did not confirm ends with its state, and one with no
observation, or of an invariant the core does not know, gets a fallback sentence
built from its label and status. The sentence is never stored. The report
document, `get_run`, `get_finding` and the `finding` event carry it as `summary`,
and the fixed explanation templates use the same builder.

### Rejected

- **Storing the sentence.** A better template would never reach the runs stored
  before it.
- **Telling it in the engine.** Presentation is the core's: the engine does not
  know the protocol's `METHOD /path` spelling, and the sentence is read from what
  the engine already recorded.

### Consequences

The sentence is built only from observed, already redacted values, and never
raises on a withheld or missing one. A new invariant reads the fallback sentence
until it has a strategy. Every reader of a finding shows the same words.

---

## ADR-154 — A replay is judged per recorded defect, and a defect its oracles cannot see is never ruled resolved { #adr-154 }

**Status:** accepted · `services/replay/rules.py`, `services/replay/service.py`, `services/report/builder.py`, `controllers/results.py`; engine `models/runtime/taxonomy.py`

### Context

A replay re-sends a recorded trace and judges the responses with contract-free
oracles only ([ADR-087](#adr-087)). It ruled each recorded request that had
violated something: `present`, `possibly_resolved` or `inconclusive`. Two things
followed. A request that no longer returned a 500 read `possibly_resolved` even
when the defect recorded there was a schema mismatch the replay cannot see at
all, so a comparison could report a fix nobody had verified. And counting per
request, a replay of a run with 26 defects reported hundreds of recorded
"defects", and `compare_runs` gave `after_count` values that could not be set
against `before_count`.

### Decision

**The engine says what a contract-free judgement can observe.** Each registry
entry declares `contract_free`, and the rules it is blind to:
`input_induced_timeout` on the whole request (`request`) needs a control request a
replay never sends. `observable_without_contract(invariant, rule_id)` answers it.

**A request verdict is `possibly_resolved` only where it could be seen.** A
recorded request is `present` when the replay reproduced it or still violates an
invariant, and `possibly_resolved` only when it changed and the recorded run kept,
at its method, path and status, a finding a contract-free judgement can observe;
`inconclusive` otherwise.

**Then one verdict per recorded defect.** `defect_verdicts` has one entry per
defect the recorded run confirmed: `present` when a recorded request at its
method, path and status is `present`; `possibly_resolved` only when every such
request is and the replay can observe the defect; `inconclusive` otherwise, also
when no request matches it. `judged` sums them under the replay's oracle scope.
`compare_runs` against a replay meets each defect with the verdicts on the
recorded defects of its own identity, and `after_count` counts those the replay
saw present.

### Rejected

- **Per-request verdicts only.** They count requests, not defects, and cannot be
  compared with the run they replay.
- **Trusting a changed status as a fix.** It turns a blind spot into a green.

### Consequences

A replay never reports a fix it could not have observed. A `present` verdict is
keyed on where a request was recorded, not on its invariant: a defect can read
present because another invariant at the same place still breaks, never resolved
by mistake. `replay.verdicts` still rules each recorded request on its own.
