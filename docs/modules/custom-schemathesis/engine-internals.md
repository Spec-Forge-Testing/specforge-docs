# Engine internals

`engine/` executes a compiled `EngineInput` against a live API and turns what
comes back into findings, statistics and a replayable trace. It is the deep
machinery the [runners](execution-modes.md) drive: an HTTP transport, the
Hypothesis harness, the response oracles, the finding pipeline, the two
fuzzers, and the trace and replay layers. This page follows those layers in the
order a request travels through them.

The [modes page](execution-modes.md) covers the runners and how they compose
these layers; this page is the layers themselves.

## Safety guard

Before a single request leaves the engine, `engine.run()` partitions the
endpoints into the ones this run may probe and the ones it must hold back. The
split is `partition_by_safety`, applied once — after the risk ordering, before
the shared HTTP client opens — so the runners never see a held endpoint and stay
untouched.

The decision reads each endpoint's `EndpointRisk` and the run's `ExecutionMode`.
Two risk flags hold an endpoint back, each in the modes where sending a probe
would do real, irreversible harm:

| Risk flag | Held out of | Why |
|---|---|---|
| `external_side_effects` | every request-generating mode — `stateless`, `performance`, `resilience`, `auth`, `stateful` | a probe reaches past the API (sends mail, charges a card, calls a third party) and cannot be undone |
| `write_operation` | `performance`, `resilience` only | the load and malformed-transport batteries would hammer a mutating endpoint; the correctness modes still probe it |

`replay` is exempt from both: it re-sends a recorded trace verbatim, never a
fresh probe. `RiskFlag`'s declaration order is precedence —
`external_side_effects` outranks `write_operation` — so an endpoint carrying
both is held for the stronger, less reversible reason.

The guard is off by **policy**, not by engine stability:
`ExecutionConfig.allow_side_effects` (default `False`, set by the CLI's
`--allow-side-effects`) lifts it and probes every endpoint.

A held endpoint is not dropped from the accounting. `record_held_endpoints`
folds each one into `RunStats.by_endpoint` as a zero-request `EndpointStats`
whose `held_back_by` names the flag that held it (empty for a probed endpoint),
so the report, the storage row and the live summary all show which endpoints the
run declined to touch and why.

!!! note "Auth mode and a held producer"
    In `auth` mode, holding back an endpoint that produces the state another
    endpoint's owner-only check needs leaves that check with no producer, and the
    run fails with a typed `AccessLinkError` naming the missing producer rather
    than silently skipping the check. `--allow-side-effects` is the way to
    complete such a run.

## HTTP transport

`engine/http/` owns everything the wire needs. One `AsyncOrchestrator` is
opened for a whole run — a single `httpx.AsyncClient`, a concurrency
`asyncio.Semaphore(max_concurrency)`, and a retry policy — and every request of
the run passes through it.

`execute(blueprint)` sends one request through the retry wrapper;
`send_chaos(blueprint, content, extra_headers)` sends one deliberately broken
attempt with no retry; `probe_liveness()` sends a single retry-free `HEAD` to
`base_url` to tell a live target from a dead one. `wire_requests` counts the
attempts that reached the wire — each retry counts, a refused request does not —
so a runner can price a phase by difference.

`dispatch_raw(send)` is the seam for a wire attempt that does not go through
httpx at all: it takes the same concurrency slot and stamp as any other request,
runs the caller's `send` inside it, and counts the attempt if it was sent — but
opens no httpx client. The raw-socket chaos transport uses it to lay a request
on a bare socket while still passing through the run's one concurrency cap.

**Retries cover only transient infrastructure faults.** A response with status
`429`, `502` or `503`, or an `httpx.ConnectTimeout`, is retried up to
`max_retries` times; the backoff is exponential (`2**attempt * backoff_base`)
with jitter, capped at `MAX_BACKOFF_S`, and it is slept **outside** the
concurrency slot so a waiting retry frees its slot for other work. Every other
transport error is returned on the first attempt: a 4xx or 5xx is the API's
answer, not a fault to paper over, and a malformed URL will never succeed.

`error_classifier.py` maps outcomes to an `ErrorCategory`. `classify_response`
turns a status into `SERVER_ERROR` / `CLIENT_ERROR` / `None` (a clean 2xx/3xx);
`classify_exception` walks `type(exc).__mro__` against a small table so a
transport exception resolves to the nearest matching category — a subclass need
not be listed to be classified.

`CONNECTION_DROPPED` sits apart from the infrastructure categories on purpose. A
peer that refuses the connection or never answers is `AVAILABILITY` or
`TIMEOUT` — evidence about the target's health, recorded in stats but never a
finding. A peer that *accepted* the connection and then dropped it before a
complete response has crashed mid-response, so `CONNECTION_DROPPED` is deliberately
outside `INFRA_CATEGORIES`: it reaches the resilience oracle and counts as a
degradation, on the same footing as a 5xx. The raw-socket chaos transport is
what produces it — it distinguishes a failure before the socket connected
(`AVAILABILITY`) from one after (`CONNECTION_DROPPED`).

### From payload to request: `ContextInjector`

`ContextInjector.build` turns a `ZonedPayload`, a compiled endpoint, the run
config and an optional `Identity` into an immutable `RequestBlueprint`. It:

- **interpolates the path** by percent-encoding each path value
  (`quote(..., safe="")`) and recording which segments the template actually
  consumed;
- **layers headers** in three coats, each overriding the one below it —
  config headers, then the identity's credential headers
  (`merge_credential_layer`, case-insensitive, the identity winning), then the
  fuzzer's generated headers on top — and records the credential header *names*
  in `config_header_names` so their values are never persisted;
- **sets the content type** from the endpoint's first declared `content_type`
  when a body is present and nothing already set one;
- **flags an unsendable request** when a percent-encoded path segment is one
  URL normalization would strip (`""`, `"."`, `".."`), because a request whose
  path silently re-routes tests nothing. The blueprint carries an
  `unsendable_reason` and the orchestrator refuses it rather than send it.

The identity's `label` rides on the blueprint — unless a generated header
overrode one of the identity's own, in which case the request does not speak
for that identity and the label is dropped.

## The zoned payload

`ZonedPayload` is the value object a strategy draws and the injector reads: the
values for one request, keyed by `Zone` (`path`, `query`, `header`, `body`),
plus the `Phase` they were drawn for. It is frozen; `with_field` returns a copy
with one field written, never mutating the original
([ADR-033](adr/engine.md#adr-033)).

Its `body` has **three** states, and the type keeps them apart with a private
`_NO_BODY` sentinel: absent (no body zone at all), an explicit `None` (a body
drawn as JSON `null`), and a value. `has_body` is true for the last two.
`from_mapping` builds one from the zone-keyed dict Hypothesis draws;
`as_mapping` renders it back, omitting empty zones and an absent body.

## The Hypothesis harness

`engine/harness/` is the seam between Hypothesis's synchronous callbacks and the
engine's async HTTP. There is exactly one event loop for the whole process,
started eagerly in a daemon thread when `harness/bridge` is imported; `run_sync`
hands a coroutine to it and blocks for the result. Every async call the fuzzers
make — one request, a whole batch, a liveness probe — goes through that one
loop, so the single `AsyncClient` is only ever touched from one thread.

Three `settings` presets shape every Hypothesis search, and all three share the
non-negotiables: **no deadline** (a real HTTP call under load must not trip
Hypothesis's timer), **no example database** (a run is reproduced by replaying
its trace, not by a local corpus), and the `too_slow` / `filter_too_much`
health checks suppressed.

| Preset | For | Also sets |
|---|---|---|
| `exploration_settings(max_examples)` | one endpoint-phase pass | phases restricted to `explicit` + `generate` |
| `shrink_settings()` | one finding's minimization | a fixed shrink example cap |
| `stateful_settings(options, reserved_steps)` | one state-machine pass | `stateful_step_count`, `report_multiple_bugs=False` |

`identity_strategy(identities)` is `st.sampled_from` over the declared
identities — the one place a run draws which caller a request is sent under.

## Response oracles

`engine/oracles/` judges one response. Oracles form an **ordered pipeline**, a
Chain of Responsibility, not a keyed lookup. Each satisfies the `ResponseOracle`
Protocol — a `name`, an `order: OraclePrecedence`, and `check(context) ->
OracleVerdict` — and precedence is a named `IntEnum` value, never a magic gap
([ADR-036](adr/engine.md#adr-036)):

| Precedence | Oracle `name` | Fires on |
|---|---|---|
| `INFRA` (10) | `infra` | an infrastructure failure — suppresses everything below it |
| `RESILIENCE` (15) | `resilience_degradation` | a 5xx under a chaos request |
| `SERVER_ERROR` (20) | `server_error` | any 5xx |
| `ACCESS_CONTROL` (25) | `access_control` | a 2xx a caller should not have obtained, judged against the auth runner's expectation (non-terminal) |
| `STATUS_CODE` (30) | `status_code` | a status no response contract declared |
| `CONTENT_TYPE` (40) | `content_type` | a body whose `Content-Type` misses the declared one |
| `SCHEMA` (50) | `schema` | a body that fails the declared schema |
| `SEMANTIC` (55) | `semantic_property` | a 2xx that breaks a declared business rule (non-terminal) |
| `LATENCY` (60) | `latency_sla` | a clean 2xx/3xx slower than the run's SLA |

The `OracleVerdict` shape lives in its own leaf module, `engine/oracles/verdict.py`
(with the shared `CONTINUE` verdict), so the verdict depends on nothing else in the
oracles package and the package stays free of import cycles. A verdict carries the
`violation` an oracle decided, whether it is `terminal`, and an optional `rule: ViolatedRule | None`
naming the rule the response broke (a verdict that decides no violation —
`CONTINUE`, or an infrastructure suppression — carries no rule). **Every finding
names its rule.** For a
`semantic_property` or `access_control` finding the rule is *declared* by the
contract — the business rule's own id and text, or the enforced access policy. For
every other invariant the rule is *intrinsic*: `intrinsic_verdict(invariant)`
(built on `engine/oracles/rules.py`) attaches a `ViolatedRule` whose id is the
invariant's value and whose description is the one-sentence requirement the
invariant enforces on its own — that a response is never a 5xx, carries a declared
status code, matches the declared schema and `Content-Type`, answers within the
latency SLA, does not slow down as concurrency grows beyond the run's tolerance,
degrades cleanly under chaos, or honours a produced resource's state
transition. Which invariants are contract-declared is the single `frozenset`
`DECLARED_RULE_INVARIANTS`; every other invariant is intrinsic by exclusion, with no
per-finding flag to persist. `evaluate` runs the oracles in `(order, name)`
order, turning each non-empty verdict into an `ObservedViolation` (its invariant
paired with its rule), accumulating them and stopping at the first `terminal` one;
it returns a `list[ObservedViolation]`, as do `check_response` and
`evaluate_contract_free`. `check_response(result,
endpoint, latency_sla_ms=, is_chaos=)` builds the `ResponseContext` — resolving
the endpoint's response contract for the status by exact code → status class →
`default`, once, for the whole pipeline, and carrying the endpoint's
`semantic_properties` onto the context — and evaluates it;
`evaluate_contract_free(result)` evaluates against no contract, which is what a
replay and a transition probe use. `build_context(result, responses, *,
latency_sla_ms=, is_chaos=, semantic_properties=(), access_expectation=None)` is
the single builder: every optional beyond the response body and its contracts is
keyword-only, so a caller supplies only the data its run has — the auth runner is
the only one that passes an `access_expectation`, and outside an auth run it is
`None`, so the `access_control` oracle stands down.

All nine built-ins are registered explicitly by `register_builtin_oracles`,
never as a side effect of importing a runner, so the registered set is one
readable function. `validate_value(value, contract)` structurally checks a
response body against a strategy-contract shape through a `SchemaType`-keyed
table of checkers — a missing type is a lookup miss, not a silent pass.

### How a semantic property is evaluated

The `semantic_property` oracle judges the business rules the contract declares for
the endpoint, and only these — it is **dormant** on an endpoint that declares none,
and silent outside a
2xx (a rule speaks about what a successful call promised, not about a rejection).
Each rule carries a closed expression tree of six node kinds (the kernel's
`SemanticProperty`); the oracle picks the value the rule is judged against by the
rule's `PropertyClass`:

| Property class | Judged against |
|---|---|
| `RESPONSE_INVARIANT` | the response body |
| `INPUT_CONSTRAINT` | the flattened request the server accepted — path parameters, body keys, query and headers in one namespace |

The flattened request is one shared function, `flatten_input_scope(body, query,
headers, path=...)` (`engine/oracles/semantic/scope.py`), used by both the oracle
and the generator so the two can never disagree on what a rule sees. It overlays
the four zones in `ZONE_OVERRIDE_ORDER` — path, then body, then query, then headers
— so a name declared in more than one zone resolves to the **last** listed. Path is
first and therefore **lowest** precedence: a path parameter only decides a name that
no data zone (body, query, header) declares, and on a collision the data zone wins,
because a data zone is the field a rule most plausibly constrains. Only header
values are stringified, because a header is a string on the wire; path values enter
raw and typed, so an `integer` path parameter is judged as an `int`. A companion,
`resolve_declared_field` (`declared.py`), resolves a declared field to its zone by
that same precedence, so generation and evaluation agree on where a referenced
field lives.

Before a rule is evaluated, a value that contradicts its field's declared type is
dropped from that scope. A rule speaks about well-typed inputs; leaving a
wrong-typed value in the semantic scope would let a 2xx to a malformed request be
read as a business-rule violation. An undeclared name is
kept, since no declared type contradicts it — so a header declared numeric is never
compared as a number, while a name the contract never mentions still reaches the
rule.

A rule may name a **path parameter**: the request carries the raw drawn path values
alongside the URL (`RequestBlueprint.path_params`), so a rule over `PATCH
/users/{id}` sent as `/users/0` sees `id` as `0` and a 2xx makes `id > 0` a finding
that cites the declared rule. Values URL normalization would drop — `""`, `.`, `..`
— are filtered by the compiler, so an unsendable request never becomes a finding.

`evaluator.py` walks the tree with a `functools.singledispatch` over the six node
kinds — never `eval`, so nothing the LLM authored is executed. A field reference
is a dotted lookup that is **transparent through arrays**: `items.price` over a
list of objects yields the list of prices. Evaluation is total: a lookup that
misses, a type-invalid operation (arithmetic on a bool, a division by zero, a
comparison of unlike types) or an aggregation over a non-list yields the
`UNDETERMINED` sentinel rather than raising. Boolean combinations use **strong
Kleene (K3) three-valued logic** — `and`/`or`/`not` over `TRUE`/`FALSE`/`UNKNOWN`
— so an undetermined operand collapses a combination to undetermined only when it
actually decides the outcome (`false and unknown` is still `false`).

A rule is a **violation only when its root expression evaluates to exactly
`False`**. A root that evaluates to `UNDETERMINED` — or to any non-boolean value —
is never a finding: an undecidable rule stays silent rather than accusing the API.
The oracle's verdict is **non-terminal**, so a semantic violation is recorded and
the pipeline continues to the latency oracle. A rule such as "the created article
keeps a non-empty slug" is the field reference `article.slug` compared `!=` to the
literal `""`; a 2xx whose body has an empty slug makes that root `False`, and the
oracle emits `InvariantViolation.SEMANTIC_PROPERTY`.

The verdict also **names the rule it broke**: it carries a `ViolatedRule` built
from the property's `id` and `description`, so the finding it produces points at
one specific business rule rather than at the anonymous `semantic_property`
invariant shared by every rule on the endpoint. The id rides all the way to the
crash report, the finding signature, storage and the report; the description
rides alongside it but is never compared ([ADR-049](adr/engine.md#adr-049)).

### Rules the run could not decide

Evaluation is total, so a rule that a response cannot answer is never a finding —
but until it was recorded, an undecidable rule was indistinguishable from a
satisfied one. The oracle now reports which rules it decided and which it could
not, per response. As it walks an endpoint's declared rules the
`semantic_property` oracle sorts each one: a rule whose root evaluates to a
boolean (either way) is **decided**; a rule whose root evaluates to `UNDETERMINED`
— it names a field the request or response did not carry, or a value the declared
type rules out — is **undecided**. The result rides the verdict as a
`RuleDecisions(decided, undecided)` (`engine/oracles/verdict.py`), and the ordered
pipeline merges every oracle's decisions into the `OracleReport(violations,
rule_decisions)` that `check_response` returns. The short-circuit on the first
broken rule is unchanged: the rules after a broken one are not evaluated on that
response, so they fall into neither set for it.

**A rule is "never decided" per endpoint, not per response.** Stateless
exploration folds each response's `RuleDecisions` into a running
`ExplorationState.rule_decisions`, and when the endpoint's exploration ends it
reports `RuleDecisions.never_decided` — the rules that were undecided on some
response and decided on none (`undecided - decided`) — as
`ExplorationOutcome.undecided_rules`. A rule the oracle managed to decide on even
one response is not listed: a single decidable draw retroactively clears it. A
rule the oracle never evaluated at all — an endpoint that returned no 2xx — is not
listed either, because it was never observed.

This is a **diagnostic, not a finding**. An undecidable rule stays silent about
the API, exactly as the verdict rules require; the run's status and its findings
are unchanged. But a rule that stays undecidable across the *whole* exploration is
a signal about the contract or the run's coverage — the field it names never came
back, or its declared type makes it undecidable in principle — and reporting it
turns that silent degradation into something a reader can act on. The canonical
example is a rule that compares a **header declared `integer`** numerically: a
header is a string on the wire, and a value that contradicts its declared type is
dropped from the semantic scope before evaluation, so the numeric comparison never
sees a number and the rule is undetermined on every response — never decided.

Only the two modes that drive the stateless fuzzer's full accounting report it:
**stateless** and **performance**. Stateful, replay, auth and resilience runs leave
it empty, exactly like `starved_identities`, and shrink re-sends never contribute
(shrinking runs off the findings, not the exploration state). The run loop merges
the per-endpoint lists and `build_stats` / `build_unshrunk_stats` surface them as
`EndpointStats.undecided_rules` (sorted rule ids), from where they reach storage,
the [run report](../../user-guide/reports.md) and the
[CLI views](../../user-guide/cli-reference.md) ([ADR-057](adr/engine.md#adr-057)).

### How the semantic phase steers generation

Observing a broken `input_constraint` only helps if a request actually breaks it.
Left to chance, an in-spec draw violates a rule like `end > start` only as often
as the schema happens to; a rule excluding one value from a million-wide range is
never hit at all. The **semantic phase** ([the semantic phase](strategy-compiler.md#the-semantic-phase))
aims generation at the rule, so the violation stops depending on luck.

The phase compiles a valid strategy per field, and the engine refines the
assembled payload once per endpoint. `refine_for_phase(strategy, endpoint, phase)`
(`engine/fuzzers/phases.py`) looks the phase up in the phase-extension registry via
`phase_extension_for(phase)` and applies the extension's `refiner` — for the
`semantic` extension, `build_semantic_payloads` — returning the strategy untouched
for any phase with no extension; `plan_passes` calls it as it builds each pass.
`build_semantic_payloads`
(`engine/fuzzers/semantic/`) mixes, for each declared input constraint, a
**violating** arm and a **conforming** arm, and always one unfiltered **valid** arm:

- A field compared against a **numeric literal** is built directly: the bounds
  implied by the comparison are rewritten and intersected with the field's own
  declared bounds, integer bounds rounded to the correct integer, and the value
  spliced into an otherwise valid draw. An empty region — a comparison the declared
  schema already rules out — yields nothing, so the phase never sends a
  schema-invalid value to fake a violation. This constructor covers path, body and
  query fields — every zone but the header, whose values are strings on the wire.
- **Two fields sharing a declared schema** are built by rearranging the drawn
  values: swapped for an order comparison, copied for equality or inequality. It is
  type-agnostic — numbers, strings and dates compare the way the evaluator already
  compares them.
- **Everything else** — aggregations, conditionals, logical combinations,
  arithmetic inside a comparison, dotted paths, `multipleOf`, boolean literals, a
  header built for a numeric comparison — falls back to **filtering** valid draws by
  the rule: the violating arm keeps draws the evaluator scores `False`, the
  conforming arm those it scores `True`.

The unfiltered valid arm is the safety net. A rule no arm can decide — a numeric
rule over a header declared `integer`, say, whose value is stringified and then
dropped by declared-type conformance — filters both directed arms empty, but the
valid arm always has candidates, so the phase never exhausts and never truncates
the run. Such a
rule silently degrades to plain valid draws: the phase could not construct a
violation, so it sends valid inputs, exactly as the oracle stays undecided on the
same rule. When a semantic finding is shrunk, the shrinker minimizes it over the
phase's base valid strategy, like any other phase.

The verdict rules are unchanged: a violation is still only a 2xx whose flattened
request scores the rule `False`, `UNDETERMINED` is still never a finding, and a
correctly rejected 4xx stays silent. A finding's signature carries its phase, but
reports are deduplicated after shrinking with the phase left out, so a violation the
plain valid phase also reaches is reported under whichever phase found it first.

With a rule plain valid generation breaks about a tenth of the time, the semantic
phase drives roughly a third to two-fifths of its requests to break it; with a rule
valid generation almost never breaks, only the phase reaches it at all.

### How access control is evaluated

The `access_control` oracle judges whether a caller obtained a 2xx it should not
have. It is **dormant** unless the auth runner passes an `AccessExpectation`
through `check_response(..., access_expectation=)` — it never reads
`endpoint.access` itself, so an ordinary run, which supplies no expectation,
never fires it. On an expectation, it fires when the response is a success and
the caller is one the policy excludes: for `owner_only`, an identity that is not
the owner (`identity_label != owner_label`) or an anonymous request; for
`authenticated`, an anonymous request **or** an identity whose label is in the
expectation's `invalid_labels` (a declared-invalid credential the target should
have rejected); for `role_only`, any caller at all. The caller is read from
`result.request.identity_label`, and an absent label is the anonymous case.
`invalid_labels` is only accepted on an `authenticated` expectation; the model
rejects it under any other policy.

The `role_only` rule is unconditional because the oracle cannot see roles: they
live on the run's `ExecutionConfig`, not on the response context. The planner is
what decides — it only ever crosses identities that lack the required role, plus
the anonymous request — so an expectation carrying `required_role` already means
"this caller was not entitled", and a 2xx contradicts it. The per-policy checks
are a table keyed by `AccessPolicy`; `public` has no entry because an
`AccessExpectation` refuses to be built for it.

The verdict is `InvariantViolation.ACCESS_CONTROL`, **non-terminal**, and names
the enforced policy as its `ViolatedRule` id (`owner_only`, `role_only` or
`authenticated`) with a description spelling out the crossing — "identity 'alice'
read a resource owned by 'bob'", "identity 'alice' succeeded without the required
role 'admin'", "an anonymous request succeeded on an endpoint requiring role
'admin'", "an anonymous request succeeded on an endpoint requiring
authentication", or "identity 'alice' succeeded with an invalid credential". A
`role_only` description names the caller and the required role, never the caller's
own role: the `identity_label` already points back into the user's identities
file.

The oracle sits at precedence 25, before every body-conformance oracle,
because it never reads the body: a bypass that also returns a schema-invalid body
must not be masked by a terminal schema violation raised lower in the chain
([ADR-050](adr/engine.md#adr-050)).

## The finding pipeline

`engine/findings/` turns raw findings into deduplicated crash reports, the
public finding union and the run's statistics. A finding's life runs signature →
group → shrink → materialize → dedupe → assemble → stats.

- **Signature.** `signature_of` builds a `FindingSignature` from what the
  failure looks like from the outside: endpoint, phase, primary violation,
  status code, identity label, the `rule_id` of the rule the finding broke, and a
  *fingerprint of the body's shape* — never its values (an object becomes its keys
  mapped to JSON type names; free text is lowercased with digit runs masked). Every
  finding now names a rule, so the id is always present; for an intrinsic invariant
  it is constant (the invariant's own value), so it adds nothing new to identity,
  and for a `semantic_property` or `access_control` finding it is the declared
  rule's id, so two different business rules broken on one endpoint are two
  findings. The rule's *description* never enters the signature. `group_findings`
  collapses findings that share a signature, in first-seen order.
- **Shrink.** `shrink_groups` attempts at most two representatives per signature
  (`MAX_REPRESENTATIVES_PER_SIGNATURE`). The first faithful reproducer stands
  for the group's untouched members (counted `collapsed`); a member that was
  never attempted counts `unverified`; one whose shrink did not reproduce counts
  `flaky` — **measured here, where it is observed, never derived by
  subtraction** ([ADR-018](adr/engine.md#adr-018)).
- **Materialize.** `build_crash_report` is the single assembler of a
  `CrashReport`, from a `FindingFacts` — the source-agnostic subject of a report
  — plus the request and result. Redaction happens here and nowhere else: request
  headers (`Authorization`, `Cookie`, `X-Api-Key` and the config header names) and
  the declared sensitive payload fields are replaced with `***`, and the
  `response_body` is redacted by field name at any depth of a JSON body — objects
  and arrays of objects alike. The response names come from two sources: a built-in
  table of credential-bearing names (`password`, `token`, `access_token`, `secret`,
  `api_key`, `cookie`, `session`, `private_key` and their siblings in
  `SENSITIVE_BODY_FIELDS`) and the endpoint's own declared `sensitive_fields` — of
  which only the last path segment counts, since a response has no zones. Matching
  is exact after normalization (case-folded, `_` and `-` removed), so
  `accessToken`, `access-token` and `access_token` all match; there is no suffix or
  substring matching and no shape heuristic, so `next_page_token` and a
  JWT-looking string in an unrelated field are left alone. Non-JSON text bodies,
  scalars and `None` pass through unchanged, and the input body is never mutated —
  the signature and the trace still see the raw body
  ([ADR-060](adr/engine.md#adr-060)).
  `materialize_report` is the no-shrink path, used by the modes that never
  minimize ([ADR-037](adr/engine.md#adr-037)).
- **Dedupe.** `dedupe_crash_reports` keeps one report per `ReportKey` — method,
  endpoint, invariant, status, identity and the canonical reproducer, phase
  deliberately excluded — and folds every duplicate's `represented_findings`
  into the one it kept.
- **Assemble.** `assemble_findings` reifies the outcomes as the closed `Finding`
  union `EngineRunResult.findings` carries: one `ConfirmedFinding` per
  deduplicated report, then the shrinker's own `FlakyFinding`s and
  `UnverifiedFinding`s — each an entry per signature carrying the raw
  `occurrences` it stands for. The counters stay the measurement; the union
  reifies them ([ADR-044](adr/engine.md#adr-044)).
- **Stats.** Four builders, one per lifecycle — `build_stats` (stateless),
  `build_stateful_stats`, `build_unshrunk_stats` (performance, resilience) and
  `build_replay_stats` — all start from the shared `RequestBreakdown`:
  per-endpoint request counts and latency, plus the run's `by_phase` and
  `by_category` totals. Latency percentiles are **nearest-rank** (P50/P95/P99):
  always an observed sample, never interpolated, and an unsent request is never
  sampled into a latency it never took.

The counters and their single producers are laid out in
[Data flow](data-flow.md#results-findings-and-their-counters).

## Stateless exploration

`engine/fuzzers/stateless/` explores one endpoint at a time, no sequencing.

`plan_passes` builds one `Pass` per `(phase, identity)`: the phase's example
budget (authoritative from the `GenerationPlan`, or the budget split for a
plan-less endpoint) split across the declared identities by `share_budget`. Each
pass carries its merged per-zone strategy, after `refine_for_phase` has had its
say — an identity for every phase but `semantic`, whose whole-payload strategy it
rewrites into directed draws (above). An endpoint with no zone at all falls back
to a single empty `valid` pass.

The driver `explore_pass` runs a Hypothesis `@given` over the pass's strategy,
but the callback **never raises on a finding** — it only accumulates drawn
payloads into a batch and, when the batch fills to `max_concurrency`, flushes
it: builds every blueprint, executes them concurrently on the one loop, and
folds each result back in draw order. Folding evaluates the oracles, records a
`RawFinding` on a violation, accumulates the oracles' rule decisions (above), and
maintains the abort counters.

**One stop signal crosses the `@given` boundary.** When folding decides the pass
must stop, it sets a `Cut` on the shared state and raises a single internal
`_StopExplorationError`, which unwinds cleanly out of Hypothesis's machinery to
the carried `Cut` — no ad-hoc exception per abort reason
([ADR-034](adr/engine.md#adr-034)). A pass stops for one of four reasons, each a
`TruncationReason`:

| Reason | Trips when |
|---|---|
| `DEADLINE_EXCEEDED` | the endpoint's `deadline_ms` elapsed before a batch |
| `INFRASTRUCTURE_ABORT` | `MAX_INFRA_FAILURES` target failures, target still answering a probe |
| `TARGET_DOWN` | those failures, and a liveness probe confirms the target is down |
| `GENERATION_EXHAUSTED` | a phase never produced a single generatable candidate |

`ExplorationState` is fresh per endpoint, but the `LivenessProbe` is injected
and **shared across every endpoint of the run**, so the last known-good safe
request (one of `SAFE_PROBE_METHODS`) persists between endpoints and is there to
resend the moment an abort streak needs adjudicating
([ADR-035](adr/engine.md#adr-035)). A run of consecutive 5xx on one endpoint is
adjudicated the same way: past `MAX_CONSECUTIVE_SERVER_ERRORS`, the known-good
request is resent off-budget; if it answers, the 500s are genuine findings, and
if it does not, the run cuts `TARGET_DOWN`. A dead target can confirm nothing, so
its raw findings are counted `unverified` — one `UnverifiedFinding` per
signature — rather than spending requests rediscovering the target is down.

**Shrinking** (`shrinking.py`) runs off the findings, never the results, so its
requests stay out of the trace. It first re-sends the finding's own payload to
confirm it still reproduces, then `find`s the smallest payload that still does,
then re-executes that minimal payload to package it; a minimal payload that does
not reproduce on re-execution is flaky and yields no report. Reproduction is
judged **by the finding's identity**: `_still_violates` accepts a re-executed
response only when it breaks the same invariant *and* the same rule id as the
original finding (and the search additionally holds the status fixed). That rule
clause is why a minimal reproducer never names a rule it does not break — a
smaller payload that trips a *different* business rule is not the same finding and
is not accepted as its shrink.

## Stateful sequencing

`engine/fuzzers/stateful/` drives sequences of linked operations as a Hypothesis
`RuleBasedStateMachine`, built **dynamically** for a given set of endpoints:
one `Bundle` per referenced name, one `@rule` per endpoint, and an optional
`@initialize` that fixes one identity for the whole sequence
([ADR-038](adr/engine.md#adr-038)).

A rule's state link drives the chaining: it **produces** a captured
response value into a bundle, **consumes** bundled values into later requests'
zones. The capture primitive itself — `capture`, which pulls a production's
dotted `response_field` out of a response body once its status matches, and
`matches_declared_statuses` — lives in `engine/state_link/`, the shared home for
state-link mechanics used by both the stateful machine and the auth runner.
A state link also optionally `invalidates` the bundle so a deleted resource is not
operated on again, and declares **transition invariants** — a follow-up probe
whose observed status must fall in an expected set, and whose body must reflect
the request's `echoed_fields`. A response that breaks its endpoint's own
invariant, or a transition probe that breaks its own, raises a
`StatefulViolationError` — the engine's one control-flow exception — which is
also the signal Hypothesis shrinks the *sequence* on.

A **supervisor** runs passes until the machine stops finding anything new. Each
pass is classified into a closed union of `PassOutcome` — `Reported`,
`LinkBroken`, `Exhausted`, `Flaky`, `Completed` — in one small function that
isolates the single `try`/`except` ([ADR-038](adr/engine.md#adr-038)):

- `Reported` appends a minimized crash report and **suppresses** that defect's
  signature, so the next pass looks past it; the run keeps going until
  `max_distinct_bugs` distinct defects are reported or the machine draws dry.
- `LinkBroken` raises `StatefulLinkError` carrying the partial exploration.
- `Flaky` — a shrink replay that stopped reproducing with no link error inside
  it — becomes a `FlakyFinding`: the recovered violation is turned into a
  `FindingSignature` and its occurrences are accumulated, or, when no violation
  could be recovered, the event is still tallied. `build_stateful_stats` sums
  both into `findings_flaky`, and `reconcile_flaky_with_confirmed` folds away any
  flaky finding a confirmed report already stands for
  ([ADR-047](adr/engine.md#adr-047)).

A per-endpoint `EndpointCircuitBreaker` takes an endpoint that stops answering
out of the machine for the rest of the run — there is no half-open state — so a
dead endpoint cannot starve a still-live consumer of a bundle it needs.
The run-level truncation is inferred from which breakers opened:
`TARGET_DOWN` when every rule endpoint the run reached opened,
`INFRASTRUCTURE_ABORT` when only some did, `GENERATION_EXHAUSTED` when the
machine never drew an eligible sequence, and `STATE_LINK_ABORT` when a link
could not be honored.

## Trace and replay

`engine/trace/` records **only what a run put on the wire**, in send order —
the recipe for reproducing it. Shrinking requests are absent by construction.
Each `TracedRequest` is an observed fact: credentials are *omitted* rather than
redacted (only the config header names are kept), a URL's `user:pass@` is
stripped and flagged with `omitted_url_userinfo`, the raw `path_params` sent
before URL interpolation are recorded alongside the query and body, and
`sent_at_ms` is excluded from anything hashed. `path_params` is a required field:
a trace recorded before it existed fails validation on load rather than
rehydrating without it — traces are regenerated, not migrated. `canonical_json` serializes a trace so equal content
yields equal bytes, and `content_hash` is its SHA-256 with the timing dropped,
so two runs that sent the same requests content-address alike.

The trace is the replay recipe, not a shareable report, so it is **not** put
through body redaction: a request's `json_body` is generated data, and the
config/identity credential headers were already omitted by name. One consequence
is worth stating plainly: a value the engine captures from a response through a
state link — a resource id, by design — is re-sent verbatim on replay, so a
producer that captured a secret into a bundle would leave it in the trace.

`rehydrate_request` is the inverse: it reconstructs a `RequestBlueprint` from a
traced request under a fresh config, applying three rules — the recorded
**identity** must still be declared, its **credential** header names must be
suppliable, and when the URL's userinfo was omitted the live `base_url` must
supply it for a **matching host**. Each rule that fails raises, so a replay
stops before sending a request it cannot fully reconstruct.

`validate_replayable(trace, config)` runs those rules over a whole trace
**without raising**, returning a `ReplayReadiness` value object with four
tuples — `missing_identities`, `missing_credentials`, `missing_url_userinfo`
(recorded hosts whose omitted userinfo the live `base_url` cannot supply) and
`host_mismatches` (recorded hosts that differ from the live host) — and an
`is_ready` that is true only when all four are empty
([ADR-022](adr/engine.md#adr-022), [ADR-046](adr/engine.md#adr-046)). The host
is checked for **every** request, not only where userinfo was omitted, so a
replay pointed at another host is refused pre-flight even when the trace kept its
own userinfo. A trace that cannot be replayed is an expected answer, not an
error.

`engine/replay/` compares and paces. `assess_fidelity` classifies a replay as
`EXACT` or `REDUCED`: a request whose observed status differs from the recorded
one is a `ResponseDivergence`, but a divergence on a request that was itself a
finding does not reduce fidelity — re-observing it is the point. Pacing is a
strategy chosen by a factory, never a runtime flag
([ADR-040](adr/engine.md#adr-040)): `TimedPacer` waits until each request's
recorded `sent_at_ms` measured from a fixed `t0`, so drift never compounds and a
past slot waits zero; `ImmediatePacer` never waits.

A replay does not blindly re-send a dead target's whole trace. `engine/http/`
carries a `TargetLivenessMonitor` that the `ReplayRunner` feeds each result as it
returns. The monitor counts a streak of target failures — the
`TARGET_FAILURE_CATEGORIES` (`timeout`, `availability`) — and ignores anything
that was never sent (no evidence either way). When the streak reaches
`MAX_INFRA_FAILURES` (5) it fires one `probe_liveness()` `HEAD`: a dead target
returns `target_down` and a live one `infrastructure_abort`, and either stops the
loop with a `TruncationRecord`. `run_status_of(truncation)` then maps that record
to the run's status — `aborted` for `target_down`, `truncated` otherwise.

Because the loop can stop short, the produced trace is a **prefix** of the
recorded one. `assess_fidelity(recorded, observed, truncation)` takes that record:
it compares `observed` against the matching prefix of the recorded requests, and
allows `observed` to be shorter than the recording **only** when a truncation is
present (a short replay with no truncation, or an overshoot, is still a
programming error and raises). The level it returns therefore describes the prefix
alone, and the truncation record itself rides along in the trace it hands back.
