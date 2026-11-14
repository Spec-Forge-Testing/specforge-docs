# Core — Decision records — Core

Part of the [Core decision records](index.md). Decisions about the headless
core: how a run explains an endpoint it did not probe, how optional libraries
are owned, how the busy guard is scoped, what a cancelled or a safety-breached
run keeps, how a run's oracle scope bounds a comparison, how the engine options
resolve, when the inference gateway loads, how a finding's summary is told, how
a replay judges the defects it re-sends, how a deleted resource is checked
without a model, and when a run is refused for lacking a requirement or for
verifying nothing.

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
- a target that names another server the contract declares is left as given too,
  so it is never sent to the first server's path under its own: the first server
  counts when the target's path starts or ends with it, any other only when the
  path ends with it;
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
segments, and only when what is left is one of the specification's paths and the
follow-up path is not. Any server the contract declares can lead it; when more than
one does, the longest goes first, so `/api/v1/users` loses `/api/v1`, not `/api`.
The engine then sees one spelling and its routing, its vetoes and its
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

---

## ADR-160 — Presets are catalog data a client chains, not a parameter { #adr-160 }

**Status:** accepted · `services/catalog/presets.py`, `services/catalog/fuzz_options.py`, `models/catalog.py`

### Context

A user picks a run by intent more often than by its parts: a quick check, a
contract audit, a security scan, a full pass. Some of those are more than one run:
a full pass explores the endpoints one by one, then in sequences. One protocol
operation is one run, with one cancellation, one persisted analysis and one
report.

### Decision

**A preset is data.** `PRESETS` is a tuple of `Preset(name, runs)`, each run a
`PresetRun(execution, strategy)` typed by `ExecutionKind` and `StrategyKind`, so a
preset cannot name a mode or a strategy the core does not accept. The catalog
publishes them in `fuzz_options.presets`: `quick-check`, `contract-audit`,
`security-scan`, `exposure-scan`, `load` and `full`.

**The client chains them.** No operation takes a `preset`. A client runs a
preset's entries in order, each as its own `fuzz` with the strategy's default
examples per endpoint.

### Rejected

- **A `preset` parameter on `fuzz`.** A preset can be several runs, so one call
  would start several runs, with no single analysis, report or cancellation to
  answer with.
- **Presets kept by each client.** Two clients would offer two different
  "security scans".

### Consequences

A new preset is one row. The protocol stays one operation per run, and the
client owns what happens between two runs of a preset: whether to stop after a
failure, and how to show progress across them.

---

## ADR-161 — Examples per endpoint resolve by one rule, and a count a runner ignores is refused { #adr-161 }

**Status:** accepted · `services/fuzz/examples.py`, `controllers/execution/checks.py`, `controllers/execution/plan.py`, `services/fuzz/adapter.py`, `services/fuzz/runner.py`, `services/compare/rules.py`; engine `runtime/runners/registry.py`, `strategy_compiler/planning.py`; storage `migrations/0006_strategy_canonical.sql`

### Context

The core passed the engine no example count. Two defaults competed: the endpoint
budget's 200 and the stateful runner's 100. A short strategy such as `smoke` needs
fewer, and a user wants to choose. Some runners send a fixed set of requests
whatever the count says: the `performance` ladder, `auth` and `resilience`.

### Decision

**One optional parameter.** `fuzz` and `run_pipeline` take
`examples_per_endpoint`, an integer of at least 1.

**One rule, in the core.** `resolve_examples_per_endpoint(requested,
strategy_default, traits)` reads the traits of the variant the run takes
(`runner_traits_for(mode, options)`): `null` when the runner honors no count;
the requested count when there is one, over the runner's cap too; otherwise the
strategy's `default_max_examples`, held under the runner's `examples_cap`.
`stateful` keeps its cap of 100, so no stateful run gets slower unless asked to.

**A count the runner would ignore is refused.** An explicit count for a runner
that honors none answers `INVALID_PARAMS`, as `load` outside `performance` does;
so does a count below 1.

**Resolved once, carried with its strategy.** The core resolves the count when it
configures the engine, keeps it with the strategy it was resolved for, and refuses
to run a production prepared for another strategy. The count reaches the engine as
the endpoint budget's `max_examples` and, in `stateful`, as
`StatefulOptions.max_examples`. The engine's own compile, without a count in the
budget, plans the profile's `default_max_examples`, the same default.

**Recorded and compared.** Schema version 6 adds `analyses.examples_per_endpoint`
(`NULL` for an earlier analysis); the analysis and the report carry it, and
`compare_runs` flags two runs that recorded different counts with
`examples_differs`.

### Rejected

- **Reading the count from `execution_options`.** Only `stateful` has one there;
  every reader would have to know where each mode keeps it.
- **Ignoring a count the runner cannot honor.** The run would report a number it
  never used.
- **Letting the strategy's default lift the stateful cap.** Every stateful run
  would double its length without anyone asking.

### Consequences

`smoke` runs 20 examples per endpoint and finishes in seconds. The resolved count
is persisted, so a replay or a comparison knows what a run asked. The endpoint's
risk score still weights its budget, so one endpoint can plan more or fewer than
the count.

---

## ADR-168 — A `DELETE` invalidates what it consumes, and a deleted-resource transition is derived from the contract where its probe can be built { #adr-168 }

**Status:** accepted · `services/fuzz/state_link.py`, `utils/constants.py`; engine `strategy_compiler/path_template.py`, `strategy_compiler/compiler.py`

### Context

A transition invariant (a follow-up read that must find the resource gone, or
changed) came only from a model-inferred contract. Without one, a soft delete, a
`DELETE` answered 204 after which the same `GET` still answers 200, went unseen.
And the stateful machine kept a deleted resource's value in its bundle, so later
steps drew an identifier that no longer existed.

### Decision

**A `DELETE` invalidates the bundle it consumes.** `INVALIDATING_METHODS` holds
`delete`. A state link sets `invalidates` on the consumption of a `DELETE`, through
a native OpenAPI link or the by-id sibling heuristic, and the engine removes the
value from the bundle when the step draws it. A nested consumption does not
invalidate: `DELETE /articles/{slug}/comments/{id}` removes the comment, not the
article.

**The deleted-resource transition is derived from sibling routes.** For a `DELETE`
whose path has exactly one placeholder, its last segment, and a `GET` on the
identical path template that declares `404` or `410`, each bundle the `DELETE`
consumes at that parameter gets a `TransitionInvariant`: follow up with that `GET`,
the parameter in the path, and expect the declared statuses among
`DELETED_RESOURCE_STATUSES` (404, 410). When a model-inferred contract states the
same transition, `merge_transitions` keeps the model's, which can also name
`echoed_fields`.

**The engine refuses a transition its probe cannot address.** At compile time,
`require_fillable_follow_ups` rejects an endpoint whose transition's follow-up path
names a placeholder other than the transition's own path field, with a
`StrategyCompilationError` that lists it in `excluded_endpoints`. The contract
boundary fails, not the run.

### Rejected

- **Deriving the transition when the read declares no 404 or 410.** An archived
  resource may legitimately stay readable; the finding would be false.
- **Deriving it on a nested path.** The probe cannot fill the parent's
  placeholder, so the first successful `DELETE` would cut the run as
  `engine_failure`.
- **Invalidating the parent of a nested consumption.** Deleting a comment does not
  delete its article.
- **Matching the read's path loosely.** Only the identical template reads the same
  resource.

### Consequences

On the lab API, the soft delete is confirmed as `state_transition` in every
repetition, with no model involved. On the RealWorld Go target nothing is derived:
its `GET /articles/{slug}` declares no 404. The invalidation acts when the step
draws the value, whatever the `DELETE` answers, so a `DELETE` that fails still
empties the bundle until a producer fills it again.

---

## ADR-190 — A run cut short, or one that left an endpoint's requests unanswered, is never clean { #adr-190 }

**Status:** accepted · `services/history/rules.py`, `services/history/models.py`, `services/fuzz/signal.py`, `services/report/builder/metrics.py`

### Context

A run's `signal` says whether its evidence covers what it was asked to cover. Two
runs read `clean` without doing so. A run cut short after it had sent requests to
every targeted endpoint left no endpoint unreached, so nothing degraded it; the
operation answered `completed` and a reader saw a whole run. An endpoint whose
requests timed out now and then, short of the streak that cuts a pass, also left
the signal untouched, although part of what the run says of it was never answered.

### Decision

**A truncated run is degraded.** `assess_signal` adds `run_truncated` whenever
`run.status` is `truncated`, beside `endpoints_unreached` when an endpoint was also
never reached. The operation's `status` keeps meaning that the run ended with a
document; the verdict is `run.status` and `run.signal`.

**An endpoint that leaves enough of its requests unanswered degrades the run.**
`requests_unanswered` is raised when one endpoint counts at least three requests
(`_FEWEST_UNANSWERED_THAT_DEGRADE`), and at least 5 % of its own
(`_UNANSWERED_SHARE_THAT_DEGRADES`), in the categories `timeout` and
`availability`. An unsendable request never left, so it does not count. The cause is
not raised beside `no_responses`, which already says more.

Both are derived from the run's facts, live and when a stored run is read, so the
store keeps no column for them.

### Rejected

- **Answering `truncated` as the operation's status.** A client would read a run
  with a document as a failed operation.
- **A share alone.** One lost request on an endpoint of few would read as a lot.
- **A count alone.** A large run loses a few requests on a healthy endpoint.

### Consequences

More runs read `degraded`, and each one says why. A `fuzz` reply carries the
`degraded_signal` warning for the new causes as for the others.

---

## ADR-194 — A finding's replay earns `possibly_resolved` behind witnesses, and says why when it cannot { #adr-194 }

**Status:** accepted · `services/replay/witnesses.py`, `services/replay/judgement.py`, `services/replay/staleness.py`, `services/replay/exchange.py`, `services/replay/finding.py`; engine `models/runtime/replay.py`

### Context

A finding's replay re-sends the one request the finding was reported from, to
check a fix. It read `possibly_resolved` whenever the answer changed. Many things
change an answer without fixing anything: a server that is down, a build from
before the fix, an expired token, a database a rebuild emptied. Each one produced a
green verdict, and with a fix in the tree, a `resolution` nobody had earned. A
client also had no way to tell an `inconclusive` that needed a restart from one
that needed a full run against the contract, and saw nothing of the answer itself.

### Decision

**Witnesses go first.** Up to two recorded reads (`GET` or `HEAD`, valid values,
answered 2xx, under the finding's identity), those naming the finding's resource
first, are sent before the finding's request. If none answers, the finding's
request is not sent.

**`present` stands; anything else must survive an ordered list of reasons.**
`judge_finding_replay` checks `no_answer`, `stale_target`, `credentials_refused`,
`witness_diverged`, `unwitnessed` and `not_observable_without_contract`, most
specific first, and the first that holds makes the verdict `inconclusive` and is
answered as `inconclusive_reason`. A `401` or `403` refuses the credentials only
while nothing proves them: behind witnesses of the same identity that answered as
recorded, it is an ordinary answer.

**Staleness is measured against every fix over the handler.** The newest fix
applied over the handler's files, the finding's own or another finding's, decides
whether the server predates the code; a stale `possibly_resolved` is
`inconclusive`.

**The answer shows what it judged and what it got.** `judged` states the oracle
scope and how many requests were sent; `exchange` carries the finding's request and
answer, redacted as the finding's evidence is. The engine captures it only on
request (`ReplayOptions.capture`), and the core does not ask when the stored
contract cannot be read, so no exchange leaves without its sensitive fields
redacted.

### Rejected

- **Trusting a changed status.** It turns every broken environment into a fix.
- **Re-running the whole recorded run.** It vouches for the environment at the
  cost of re-sending writes, and a run whose recorded requests all violated
  something still holds no read to trust.
- **One generic `inconclusive`.** A client cannot tell the user what to do next.

### Consequences

Fewer replays read `possibly_resolved`, and each `inconclusive` names its remedy.
A `resolution` follows the finding's newest replay, so an `inconclusive` one takes
an earlier one away. Witnesses compare statuses only: a state change none of them
reads, such as an emptied database seen only by a collection `GET`, can still let a
replay read `possibly_resolved`. A trace with a read on the finding's own resource
closes most of that gap.

---

## ADR-195 — A comparison rules each defect within the endpoints the later run exercised { #adr-195 }

**Status:** accepted · `services/compare/rules.py`, `services/compare/models.py`, `services/history/rules.py`

### Context

`compare_runs` read a defect the `after` run lacked as `possibly_resolved`. Set a
run of one endpoint after a run of many, and every defect of the other endpoints
read resolved, although nothing had been sent to them. `comparable` was also ruled
before the `replay` caveat was added, so a comparison against a replay could read
`comparable` beside a caveat.

### Decision

**Scope is the endpoints a run exercised.** An endpoint is exercised when the run
reached the wire for it and did not leave it unprobed, an endpoint reached by a
transition included; it is keyed on method and path. A defect the `after` run lacks,
on an endpoint it did not exercise, is `inconclusive`.

**Different scopes are a caveat that does not blank the comparison.**
`scope_differs` (side `pair`) says how many of the first run's endpoints the second
exercised. Unlike the other `pair` caveats, it leaves a defect on an exercised
endpoint ruled as usual, and a `new` one stays `new`.

**`comparable` is ruled last.** It is `true` only when `caveats` is empty, the
`replay` caveat included.

### Rejected

- **Making any scope difference blank every defect.** A focused re-run of the
  endpoint a fix touched is the common case, and it would tell nothing.

### Consequences

A focused re-run tells resolved from untested. Scope is kept per method and path,
not per identity: a defect recorded under one identity, on an endpoint the later
run exercised only under another, is ruled as usual and can read
`possibly_resolved`.

---

## ADR-213 — A run that lacks what its mode requires is refused before it is produced, and one that would verify nothing is refused with the endpoints and why { #adr-213 }

**Status:** accepted · Supersedes in part [ADR-102](../../specforge-engine/adr/engine.md#adr-102) · `controllers/execution/requirements.py`, `controllers/execution/translation.py`, `controllers/execution/producers.py`, `errors/execution.py`, `services/fuzz/exceptions.py`, `services/fuzz/runner.py`, `services/catalog/vocabulary.py`; engine `exceptions.py`, `runtime/facade.py`, `runtime/runners/auth/runner.py`

### Context

The catalog already said what each runner variant `requires`: `auth` needs
identities the target accepts and a producer whose contracts declare access
policies. A client showed it; the core did not enforce it. An `auth` run without
a valid identity paid for its inferences and then failed with a free-text
`EXECUTION_FAILED`; one with producer `none` ended `completed` without sending
anything. A run whose every endpoint the safety guard held back also ended
`completed`, its signal `degraded`, with nothing sent. Each read as a run that
had tested the API, and none told the client which parameter would fix it.

### Decision

**A requirement is checked before anything is traced, produced or sent.** For the
variant the run takes, each value of its `requires` is checked against the
request; the first unmet one refuses the run with `REQUIREMENT_UNMET` (`-32602`,
a parameter refusal), `data.requirement` naming it and `data.parameter` naming
the parameter that meets it: `identities_path` for `identities`, `producer` for
`access_policies`. No inference is paid for.

**A run that would verify no endpoint is refused.** With its contracts produced,
the core refuses with `NOTHING_VERIFIED` when the engine verifies nothing. `held_back`
is decided before any request; `access_uncrossable` once the `auth` walk has
crossed nothing, after any provisioning requests it sent:

| `data.cause` | When | Lifted by |
| --- | --- | --- |
| `held_back` | The safety guard holds back every endpoint of the run; the engine refuses before sending | `allow_side_effects`, in `data.parameter` |
| `access_uncrossable` | An `auth` run crossed no endpoint: none that is not public declares an access policy, or none it declares can be crossed; decided after the walk, so provisioning requests may already have been sent | A producer whose contracts declare crossable policies |

`data.endpoints` lists each endpoint with its reason: a `hold_reason` for
`held_back`, an `unprobed_reason` for `access_uncrossable`. Inferred contracts
stay in the cache, so asking again does not pay for them again.

### Rejected

- **Keeping `requires` informative.** A client that ignores it gets a run that
  costs money and says nothing; the core is the one authority that refuses.
- **A `completed` run with an empty plan.** It is indistinguishable from a run
  that tested everything and found nothing, which is the false green the core
  never reports.
- **Refusing every unmet run before production.** Whether anything can be
  verified depends on what the contracts declare, so `NOTHING_VERIFIED` can only
  be decided once they exist.

### Consequences

Two error codes a client handles by marking the parameter named. An `auth` run
whose endpoints declare no access policy is refused as `access_uncrossable`, like
one whose policies cannot be crossed, rather than completing with zero requests.

---

## ADR-215 — An LLM suspicion names the confirmed defect that already covers it, by the same request or the same field, and stays listed { #adr-215 }

**Status:** accepted · Builds on [ADR-202](../../specforge-engine/adr/findings.md#adr-202) · `services/report/suspicion_cover.py`, `services/report/builder/cover.py`, `services/report/builder/metrics.py`, `services/report/html.py`, `services/report/grounds_text.py`, `controllers/results/findings.py`, `controllers/results/browse.py`, `models/results/findings.py`

### Context

A run with a producer often reports the same problem twice: once as a defect,
against a rule the code states, and once as an LLM suspicion, against a rule the
model assumed for the same field or on the same request. A text past a stated
`maxLength` that also breaks an assumed `pattern` is one such pair. Read side by
side, the suspicions list repeats what the defects already say, and a reader
spends the time meant for the open questions on settled ones.

### Decision

**Each suspicion names the defect that covers it.** `covered_by` holds the
covering defect's `invariant_violated`, `rule_id` and `status_code`, plus its
`finding_id` where findings have ids (`get_run`, `get_finding`), or `null`.
`metrics.findings_llm_suspicions_covered` counts the suspicions covered.

**Same endpoint, then the same request or the same field.** A confirmed defect
of the same run, method and path covers a suspicion when its `minimal_payload`
is the suspicion's, else when both are about the same field: the `<zone>.<field>`
the `rule_id` names, else the poisoned field, else the only field the request
sets outside the path. A finding about no field is covered only by the same
request. Among several, the most severe, then the first in the order of
`defects`.

**A gap in the specification never covers.** A `contract_hygiene` defect says
the specification is incomplete, nothing about what the suspicion's rule
expects.

**Derived when read, and nothing leaves the list.** The cover is computed when
the report is built or `get_run` reads the run, never stored, so a run stored
before has it too. Every suspicion stays in `llm_suspicions` and `findings` with
its reproducer, and `findings_llm_suspicions` counts them all. The HTML report
folds the covered ones last, each naming its defect.

### Rejected

- **Dropping a covered suspicion.** Its rule is still the model's and may still
  be a separate problem; only a reader can tell, so it stays, shown second.
- **Covering by any field the two requests share.** Two findings that address
  the same resource by its id, or carry the same field without breaking it, are
  not the same problem; only the field each one is about counts, never a path
  parameter.
- **Letting every category cover.** A `contract_hygiene` defect on the same
  request, such as an undeclared status, would mark as settled a suspicion
  whose rule nothing in that defect checked.

### Consequences

A client shows the open suspicions first and the covered ones apart, each linked
to its defect by `finding_id`. The cover is a reading aid: a suspicion it
misses stays open, and one it covers is still listed and counted.

## ADR-217 — A run whose credentials a targeted endpoint refused on every response is never clean { #adr-217 }

**Status:** accepted · Builds on [ADR-190](#adr-190) · `services/history/rules.py`, `services/history/models.py`, `services/persistence/vocabulary.py`, `services/fuzz/signal.py`, `services/report/builder/metrics.py`

### Context

A run whose identities carry tokens the target no longer accepts gets a `401` on
every request. Each one is a response, so neither `no_responses` nor
`requests_unanswered` applies, and every request counts toward the endpoint being
reached. The run read `clean` while it had verified nothing behind the access
check of those endpoints: a reader takes a dead token for a healthy API.

### Decision

**The engine counts refusals per endpoint.** Each endpoint's `requests_refused`
counts its `requests` answered `401` or `403`, only on an endpoint that requires
authentication: a public endpoint's `401` or `403` (a login's wrong password) answers
the request, not the caller. Storage keeps it in
`run_endpoint_stats.requests_refused` (migration `0020`), nullable so a row
stored before reads `null`.

**A targeted endpoint refused throughout degrades the run.** `assess_signal`
adds `credentials_refused` when at least one targeted endpoint has
`requests_refused` above `0` equal to its requests that got a response, those
outside `availability`, `timeout` and `unsendable_request`. An endpoint that got
no response is left to the causes that already say so.

**Not in a mode that sends refused credentials.** `expects_refused_credentials`
names the modes whose healthy run can see every response refuse: `auth`, which
crosses each endpoint with the identities its access policy should refuse. Such
a run never raises the cause.

**Derived from the run's facts.** As the other causes, it is computed live and
when a stored run is read, so the store keeps no column for the cause itself; a
run stored before `requests_refused` was kept never raises it.

### Rejected

- **A share of refusals.** An endpoint that accepts a valid token and refuses
  some crafted requests is healthy; only a refusal of every response says the
  credentials opened nothing.
- **Counting `401` alone.** A token accepted for authentication but without the
  rights the endpoint asks for gets a `403` everywhere, and verifies as little.
- **Raising it in `auth`.** That mode is built to be refused; its signal would
  always read `degraded`.

### Consequences

A run against a target whose tokens expired reads `degraded` with
`credentials_refused`, and the endpoint's `requests_refused` shows how many were
refused. An endpoint that legitimately answers `403` to every generated
request also degrades the run, and the cause names it so a reader can tell.
