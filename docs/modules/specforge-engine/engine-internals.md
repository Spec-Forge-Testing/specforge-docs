# Engine internals

`runtime/` executes a compiled `EngineInput` against a live API and turns what
comes back into findings, statistics and a replayable trace. It is the deep
machinery the [runners](execution-modes.md) drive: an HTTP transport, the
Hypothesis harness, the response oracles, the finding pipeline, the two
fuzzers, the bulkhead that isolates a failing endpoint, and the trace and replay
layers. This page follows those layers in the order a request travels through
them; how a request is shaped before it gets here, and what it carries, is on
[Requests](requests.md).

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
fresh probe. Re-sending a recording made without the guard, or whose run breached it, needs the caller's
consent again, which the core asks for before the engine runs (see
[consent to re-send](execution-modes.md#consent-to-re-send)). `RiskFlag`'s
declaration order is precedence — `external_side_effects` outranks
`write_operation` — so an endpoint carrying both is held for the stronger, less
reversible reason.

The guard is off by **policy**, not by engine stability:
`ExecutionConfig.allow_side_effects` (default `False`, set by the CLI's
`--allow-side-effects`) lifts it and probes every endpoint.

Every selected entry raises its vetoes, compiled or excluded alike. That
includes an endpoint the caller keeps out of the run: `CompilerInput.withheld`
takes `WithheldEndpoint`s (`method`, `path_url`, `risk`, a non-empty `reason`),
and the compiler turns each into an exclusion that reaches `EngineInput.excluded`
with its risk, so its flag still vetoes its route. An endpoint listed both in
`endpoints` and in `withheld` fails `CompilerInput` validation.

### A veto covers a route, however it is spelled { #route-vetoes }

A flag the mode holds vetoes its endpoint's route as a **pattern**, not as the
declared string. `RouteVetoes.of_selection` builds one `VetoedRoute` per route
shape, and every compiled endpoint, follow-up and recorded row is compared by its
shape. `route_shapes` reduces a method and a path to the routes a path-decoding
server dispatches them to:

| Spelling | How the shape reads it |
|---|---|
| `HEAD` | as `GET`: servers answer it with the `GET` handler |
| query, fragment | cut off |
| case | folded |
| empty segments (a trailing or doubled slash) | dropped |
| percent-encoded unreserved characters, `%2F`, `%5C`, `%3B` | decoded once, or twice, in the order each server chain decodes |
| `\` | a segment separator, as `/` |
| path parameters (`;v=1`) | dropped from each segment, before or after decoding |
| dot segments (`.`, `..`, encoded too) | resolved, both before and after merging repeated slashes |
| a `..` that climbs above the base | matched by its tail, since the server resolves it from its own root |
| `{name}` | one placeholder, so placeholder names never split a route |

Servers apply those steps in different orders, and the order changes the route.
`runtime/http/route_reading.py` names each modelled chain as a `ServerPipeline`
in `SERVER_PIPELINES`: a servlet container that drops path parameters before
decoding, once or twice; one that decodes first, so an encoded `;` starts
parameters, with or without splitting backslashes before it drops them; and a
proxy in front of a container that decodes once or normalizes dot segments
first. Every pipeline ends as a router does, splitting on backslashes and then
resolving dots, and runs with and without merging repeated slashes first, so a
path has at most 18 readings ([ADR-110](adr/engine.md#adr-110)).

A path may yield more than one shape; it is covered when any of them is. A
placeholder in a veto covers any one segment; a literal segment in a veto never
covers a placeholder in the subject.

**A literal the run declared wins over a vetoed template.** A subject whose exact
route key (method and path as declared, case kept) is a selected entry is held
only by a veto on one of its own shapes, as routers and OpenAPI rank a concrete
route before a templated one. Any other spelling of it, `HEAD` or a trailing
slash included, is not declared, so every veto covering it holds it.

**Naming the hold.** Every covering veto holds; the name only picks the one the
report shows: the most specific veto (the most segments that are not a bare
placeholder), then the stronger flag, then the first entry in the run's
selection. `RouteVetoes.of` returns a `RouteVeto` (`flag`, `via`): `via` is the
endpoint id of the entry that raised the flag, the subject's own id when its own
flag decided.

**Follow-ups.** A declared transition whose follow-up a veto covers is held for
that flag. A follow-up to a route outside the run's selection goes through only
on a safe method (`GET`, `HEAD`, `OPTIONS`); any other is held as
`unsafe_method_outside_run`. Only `stateful` probes transitions, so only it
reports them, in the declaring endpoint's `EndpointStats.held_back_transitions`.

!!! warning "What a veto does not foresee"
    - A placeholder value filled in at run time that spells a vetoed literal or a
      dot segment: the partition runs before any value exists.
    - A declared path that is not canonical, and a server that decodes a path
      more than twice.
    - A router that matches in registration order and sends a declared literal to
      a vetoed template's handler: the guard follows the contract. Flagging the
      literal as well closes it.

    The guard errs toward holding: a follow-up to an undeclared route that fits a
    vetoed template is held even if the server has a handler of its own.
    Declaring and selecting that route, or `allow_side_effects`, lets it through.

### What the run records

A held endpoint is not dropped from the accounting. `record_safety_partition`
folds each one into `RunStats.by_endpoint` as a zero-request `EndpointStats`
whose `held_back_by` names the flag that held it and `held_back_via` the entry
that raised it (both `None` for a probed endpoint; one is `None` exactly when the
other is), so the report, the storage row and the live summary all show which
endpoints the run declined to touch, why, and because of which entry.

A row on a held route that drew requests anyway is a breach. It keeps its
counters and carries the same two fields — on a route held only as an unsafe
follow-up, `held_back_via` is the endpoint that declared the transition — and
`record_safety_partition` raises `SafetyGuardBreachError`, carrying the result
marked `safety_breached` so the run is kept with that evidence.

Symmetrically, a **targeted** endpoint that drew no requests records why in
`EndpointStats.unprobed_reason`: `declared_public` for a by-design public skip
(complete evidence, not a gap), `access_undeclared` for a missing access policy,
or one of the four access preconditions the auth run could not meet
(`owner_producer_missing`, `owner_chain_cyclic`, `owner_resource_unprovisioned`,
`required_role_unheld`; see [Execution modes](execution-modes.md#auth)). A silent
endpoint is therefore never confused with one the run failed to reach.

!!! note "Auth mode and a held producer"
    In `auth` mode, a producer the guard held back counts as missing: an
    endpoint whose owner resource only that producer creates is left unprobed
    with `unprobed_reason` `owner_producer_missing`, and the run goes on.
    `--allow-side-effects` is the way to probe it.

## Run signals

The two optional signals a caller wires into `run` — a way to stop the run and a
way to watch it — travel together as one frozen `RunSignals` carrier
(`cancellation`, `progress`), so a runner takes a single value instead of two
parameters threaded through every call. `run` builds it once and passes it down
through the `RunRequest`; every runner, the shared endpoint loop and both fuzzers
read `signals.cancellation` at their boundaries and report through
`signals.progress`. When the caller supplies neither, `NULL_SIGNALS` carries a
never-cancelled token and a no-op progress sink, so the paths downstream need no
special case.

`progress` is a `Progress` Protocol, not the raw observer: a `ProgressEmitter`
sits behind it and owns the run's clock, the tick throttle and the three counters
(`sent`, `total`, `findings`). It forwards a **fact** event straight through and
**throttles** a `tick` to at most one per `MIN_TICK_INTERVAL_S`, reading the live
wire-request count from the orchestrator each time. The emitter is built only when
an observer is supplied; otherwise `run` wires the no-op `NULL_PROGRESS` and
computes no counters at all. Cancellation is read as a plain value — a sticky
`Cut` inside stateless exploration, a `TruncationRecord` with reason `cancelled`
at every other boundary — never thrown. The full treatment of both signals, the
event catalog and the per-mode boundaries is on
[Progress and cancellation](progress-and-cancellation.md).

## HTTP transport

`runtime/http/` owns everything the wire needs. One `AsyncOrchestrator` is
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
concurrency slot so a waiting retry frees its slot for other work. The sleep is
**chunked** so a cancelled run does not wait it out: it runs through `wait_chunks`
in steps of at most `CANCELLATION_POLL_INTERVAL_S` and ends the moment the run's
cancellation token trips, in which case the last attempt's result is returned
unretried (see [Progress and cancellation](progress-and-cancellation.md)). Every other
transport error is returned on the first attempt: a 4xx or 5xx is the API's
answer, not a fault to paper over, and a malformed URL will never succeed.

A request the client cannot put on the wire at all is caught before it is sent
and returned as an **unsendable result** (`UNSENDABLE_REQUEST`, no status code),
never as a transport fault and never as a crash of the run. A request is
unsendable when its body cannot be encoded for its media type — a JSON body JSON
cannot encode (a `NaN` or an infinity), a form or multipart body that is not an
object of encodable fields, a multipart body with no field to send, or a media
type no encoder handles — when a header name is not an RFC 9110 token, or when a
header value is not ASCII or carries a NUL, a line break, or whitespace at either
edge. The injector judges the body when it builds the blueprint, and a replay
judges a rehydrated body the same way; the orchestrator refuses any blueprint that
carries an `unsendable_reason`, and still refuses a header the client will not
encode at send time. An unsendable request is not counted as a wire request, never
retried and never a finding; it is only recorded in stats by category, and its
detail names the offending header or the body's problem, never a value.

**The body is encoded by its media type.** `runtime/http/body_encoders.py` holds
`BODY_ENCODERS`, a closed table of three `BodyEncoder`s keyed by the media type's
essence: JSON (any JSON media type, `+json` included), form-urlencoded and
multipart. Each names the `Content-Type` it sends (`None` lets the client write
multipart's boundary), the client arguments (`json=`, `data=`, `files=`), and why
a body cannot be encoded. The table and what each encoder writes are on
[Requests](requests.md#encoders) ([ADR-122](adr/models.md#adr-122)).

`error_classifier.py` maps outcomes to an `ErrorCategory`. `classify_response`
turns a status into `SERVER_ERROR` / `CLIENT_ERROR` / `None` (a clean 2xx/3xx);
`classify_exception` walks `type(exc).__mro__` against a small table so a
transport exception resolves to the nearest matching category — a subclass need
not be listed to be classified. A local protocol error the client raises before
the request leaves — a header it will not encode — resolves to
`UNSENDABLE_REQUEST`, alongside a malformed URL or an unsupported scheme.

| Exception | Category |
|---|---|
| `InvalidURL`, `UnsupportedProtocol`, `LocalProtocolError` | `UNSENDABLE_REQUEST` |
| `ConnectError`, `ConnectTimeout`, `PoolTimeout`, `WriteTimeout` | `AVAILABILITY` |
| any other `TimeoutException` (a read timeout) | `TIMEOUT` |
| `RemoteProtocolError`, `ReadError`, `WriteError` | `CONNECTION_DROPPED` |
| anything else | `AVAILABILITY` |

`CONNECTION_DROPPED` sits apart from the infrastructure categories on purpose. A
peer that refuses the connection or never answers is `AVAILABILITY` or
`TIMEOUT` — evidence about the target's health, recorded in stats and a finding
only when the request's poisoned field induced the timeout
([ADR-131](adr/engine.md#adr-131)). A pool or write timeout happens on the
client's side, before the target could answer the payload, so it is
`AVAILABILITY`, never a judged `TIMEOUT`. A peer that *accepted* the connection and then dropped it before a
complete response has crashed mid-response, so `CONNECTION_DROPPED` is
deliberately outside `INFRA_CATEGORIES`: the server-error oracle reports it as
`not_a_server_error` exactly as it reports a 5xx, and under chaos the resilience
oracle judges it instead. It still belongs to `TARGET_FAILURE_CATEGORIES`, so a
run of drops advances the abort streak and can trigger a liveness probe; a
streak of judged failures only, drops included, against a target that answers the
probe keeps exploring (see [Stateless exploration](#stateless-exploration) and
[ADR-132](adr/engine.md#adr-132)). The raw-socket chaos transport produces it
too: it tells a failure before the socket connected (`AVAILABILITY`) from one
after (`CONNECTION_DROPPED`).

### From payload to request: `ContextInjector`

`ContextInjector.build` turns a `ZonedPayload`, a compiled endpoint, the run
config and an optional `Identity` into an immutable `RequestBlueprint`. It:

- **interpolates the path** by percent-encoding each path value
  (`quote(..., safe="")`) and recording which segments the template actually
  consumed;
- **leaves out what was drawn as `None`**: a query or header parameter drawn as
  `None` is not sent, and a body drawn as `None` is no body at all;
- **layers headers** in three coats — config headers, then the identity's
  credential headers (`credential_headers`, case-insensitive, the identity
  winning), then the fuzzer's generated headers — and records the credential
  header *names* in `config_header_names` so their values are never persisted. A
  generated header whose name is **reserved** (a credential's, or `Content-Type`)
  is dropped unless the request's intent poisons that very header
  (`admit_generated_headers`, `runtime/http/reserved_headers.py`,
  [ADR-119](adr/engine.md#adr-119));
- **encodes the body** for the compiled body's `media_type`: the blueprint carries
  `body`, `media_type` and `file_fields`, and the encoder's `Content-Type`
  replaces a config one (an admitted, poisoned `Content-Type` stays);
- **copies the intent** from the payload to `RequestBlueprint.intent`;
- **flags an unsendable request** when a percent-encoded path segment is one
  URL normalization would strip (`""`, `"."`, `".."`), because a request whose
  path silently re-routes tests nothing, and when the body or a header could not
  be sent (above). The blueprint carries an `unsendable_reason`, every reason
  joined when there are several, and the orchestrator refuses it rather than
  send it.

The identity's `label` rides on the blueprint — unless an admitted (poisoned)
generated header shadows one of the identity's own, in which case the request does
not speak for that identity and the label is dropped. A dropped reserved header
never unlabels the request.

## The zoned payload

`ZonedPayload` is the value object a strategy draws and the injector reads: the
values for one request, keyed by `Zone` (`path`, `query`, `header`, `body`),
plus the `RequestIntent` they were drawn for — the phase, and the one zone and
field drawn outside its schema, if any ([ADR-116](adr/engine.md#adr-116)). It is
frozen; `with_field` returns a copy with one field written and the intent kept,
never mutating the original ([ADR-033](adr/engine.md#adr-033)).

Its `body` has **three** states, and the type keeps them apart with the
`NO_BODY_DRAWN` sentinel (`models/runtime/draw.py`): absent (no body drawn), an
explicit `None`, and a value. `has_body` is true for the last two; the injector
sends neither an absent body nor a `None` one. `from_mapping` builds one from the
zone-keyed dict Hypothesis draws, reading each zone's `ZoneDraw` — or bare values,
as `as_mapping` renders them, with no intent — and raising when two zones claim a
poisoned field; `as_mapping` renders it back, omitting empty zones and an absent
body. Where the intent lives on every later object is on
[Requests](requests.md#where-the-intent-lives).

## The Hypothesis harness

`runtime/harness/` is the seam between Hypothesis's synchronous callbacks and the
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
| `shrink_settings()` | one finding's minimization | `max_examples=SHRINK_REQUEST_BUDGET` (one request per attempt), phases `explicit` + `generate` + `shrink` (no `explain`) |
| `stateful_settings(options, reserved_steps)` | one state-machine pass | phases `explicit` + `generate` + `shrink` (no `explain`), `stateful_step_count`, `report_multiple_bugs=False` |

`identity_strategy(identities)` is `st.sampled_from` over the declared
identities — the one place a run draws which caller a request is sent under.

## Response oracles

`runtime/oracles/` judges one response. Oracles form an **ordered pipeline**, a
Chain of Responsibility, not a keyed lookup. Each satisfies the `ResponseOracle`
Protocol — a `name`, an `order: OraclePrecedence`, and `check(context) ->
OracleVerdict` — and precedence is a named `IntEnum` value, never a magic gap
([ADR-036](adr/engine.md#adr-036)):

| Precedence | Oracle `name` | Fires on |
|---|---|---|
| `INPUT_INDUCED_TIMEOUT` (100) | `input_induced_timeout` | a timeout on a request whose intent names a poisoned field (terminal) |
| `INFRA` (110) | `infra` | an infrastructure failure — suppresses everything below it |
| `RESILIENCE` (200) | `resilience_degradation` | under a chaos request, a 5xx or a dropped connection the attack does not tolerate |
| `SERVER_ERROR` (210) | `server_error` | any 5xx, or a connection the server dropped |
| `ACCESS_CONTROL` (300) | `access_control` | a 2xx a caller should not have obtained, judged against the auth runner's expectation (non-terminal) |
| `MASS_ASSIGNMENT` (400) | `mass_assignment` | a 2xx that echoes an undeclared body key the request poisoned, with the value sent (non-terminal) |
| `SEMANTIC` (410) | `semantic_property` | a 2xx that breaks a declared business rule (non-terminal) |
| `INFORMATION_DISCLOSURE` (420) | `information_disclosure` | a non-2xx to a poisoned request whose body shows a leak marker outside the echo of the sent value (non-terminal) |
| `SENSITIVE_DATA_EXPOSURE` (430) | `sensitive_data_exposure` | a 2xx, to a poisoned request or under a declared body schema, that carries a secret-looking key the object holding it does not declare (non-terminal) |
| `INPUT_VALIDATION` (440) | `input_validation` | a 2xx to a request whose poisoned field was sent outside its declared schema (non-terminal) |
| `REFLECTED_PAYLOAD` (450) | `reflected_payload` | an HTML response that echoes the active payload of a reflectable family unescaped (non-terminal) |
| `CONTRACT_COMPLETENESS` (460) | `contract_completeness` | a 400 or 422 to an unpoisoned request that provably conforms to its declared contract (non-terminal) |
| `STATUS_CODE` (500) | `status_code` | a status no response contract declared |
| `CONTENT_TYPE` (510) | `content_type` | a body whose `Content-Type` misses the declared one |
| `SCHEMA` (520) | `schema` | a body that fails the declared schema |
| `UNDECLARED_RESPONSE_FIELD` (530) | `undeclared_response_field` | **opt-in**, only where the strategy names it: a JSON body holding a key a closed declared object does not declare (non-terminal) |
| `LATENCY` (600) | `latency_sla` | a clean 2xx/3xx slower than the run's SLA |

The business rule and the security oracles run before the status, content-type
and schema checks on purpose. Those three are terminal; the oracles before them are
not, so the chain reaches the rule before a deviation can stop it
([ADR-104](adr/engine.md#adr-104)). A response that breaks two rules yields **two**
findings: the fold records one raw finding per `(invariant, rule_id)`, each
grouped, shrunk and confirmed on its own ([ADR-137](adr/engine.md#adr-137)). A
2xx that breaks a declared rule and also misses its declared status is a
`semantic_property` finding and a `status_code_conformance` finding, and an
undeclared 400 to a conforming request is a `contract_completeness` finding and a
`status_code_conformance` one.

The security oracles are anchored on the intent and each states its limit; what
each reads, and why `reflected_payload` reads HTML only, is in
[ADR-131](adr/engine.md#adr-131) and [ADR-135](adr/engine.md#adr-135). They share
`sent_value` (what the request sent for a field, by zone), `response_walk` (the
nested objects and texts of a body) and `shared/sensitive_names` (the name
predicate the finding redaction uses too).

The `OracleVerdict` shape lives in its own leaf module, `runtime/oracles/verdict.py`
(with the shared `CONTINUE` verdict), so the verdict depends on nothing else in the
oracles package and the package stays free of import cycles. A verdict carries the
`violation` an oracle decided, whether it is `terminal`, and an optional `rule: ViolatedRule | None`
naming the rule the response broke (a verdict that decides no violation —
`CONTINUE`, or an infrastructure suppression — carries no rule). **Every finding
names its rule.** For a
`semantic_property` or `access_control` finding the rule is *declared* by the
contract — the business rule's own id and text, or the enforced access policy —
for an `input_validation` finding it is the accepted field, `<zone>.<field>`, for a
`contract_completeness` finding the rejected field the response names,
`<zone>.<path>`, or `request`, and for a security finding the poisoned field, `<zone>.<field>`, or the exposed key,
`response.<key>`. For
every other invariant the rule is *intrinsic*: `intrinsic_verdict(invariant)`
(built on `runtime/oracles/rules.py`) attaches a `ViolatedRule` whose id is the
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
endpoint, latency_sla_ms=, chaos=, access_expectation=)` builds the
`ResponseContext` — resolving
the endpoint's response contract for the status by exact code → status class →
`default`, once, for the whole pipeline, and carrying the endpoint's
`semantic_properties` onto the context — and evaluates it;
`evaluate_contract_free(result)` evaluates against no contract, which is what a
replay and a transition probe use; it runs only the intrinsic oracles, those
registered neither `opt_in` nor `requires_contract`. `check_response` passes the
endpoint's `optional_oracles` on, and `evaluate` keeps an opt-in oracle only when
its name is among them ([Strategies](strategies.md#opt-in-oracles)). `build_context(result, responses, *,
latency_sla_ms=, chaos=None, semantic_properties=(), access_expectation=None)` is
the single builder: every optional beyond the response body and its contracts is
keyword-only, so a caller supplies only the data its run has — the auth runner is
the only one that passes an `access_expectation`, and outside an auth run it is
`None`, so the `access_control` oracle stands down. Likewise only the resilience
runner passes `chaos`, the attack's `ChaosExpectation`: whether a dropped
connection refuses that attack rather than crashing under it.

All seventeen built-ins are registered explicitly by `register_builtin_oracles`,
never as a side effect of importing a runner, so the registered set is one
readable function. `validate_value(value, contract)` (`shared/schema_check.py`,
which the compiler's attack shape filter reads too) structurally checks a
value against a strategy-contract shape through a `SchemaType`-keyed table of
checkers — a missing type is a lookup miss, not a silent pass. It holds a value
declared `format: int32`, `int64` or `float` to that word, and an unformatted
number to no word at all ([ADR-113](adr/compiler.md#adr-113)); the response schema
oracle and the input-validation oracle both read it. Beside it,
`meets_declared_shape(value, contract)` checks, at any depth, what `validate_value`
leaves out: `pattern`, `format`, `uniqueItems`, `minProperties` and
`maxProperties`. A format it cannot evaluate is never met, and `password` and
`binary` restrict nothing. Only the contract-completeness oracle reads it.

### How input validation is judged

The `input_validation` oracle answers one question: did a 2xx accept the value the
request was drawn to get wrong? It reads the request's **intent**, never its phase
([ADR-118](adr/engine.md#adr-118)), so it judges an out-of-range boundary edge as
readily as an invalid draw, and stays silent on an invalid draw that happens to be
valid.

It speaks only on a 2xx whose intent names a poisoned field with a schema in the
context's `declared_schemas_by_zone`. It reads the value the request sent, by
zone: the drawn path or query value; the header's text, matched without case; the
body's field, or the whole body for `$`, and for a form or multipart body the text
its encoder sent. A field the request did not send is **absent**, which is not
`null`; an absent field breaks the schema only when it is required. A sent text on
a text wire is read as the declared type through strict literals
(`interpret_wire_text`: `-?[0-9]+` for an integer, a decimal with an optional
exponent for a number, `true` or `false`), so `" 7"` is text and fails an
`integer` field ([ADR-117](adr/compiler.md#adr-117)). Then `validate_value`
decides.

A violation is a verdict with the invariant `input_validation`, non-terminal, and
the rule `accepted_field_rule(zone, field)`: `ViolatedRule(id="<zone>.<field>")`,
such as `query.limit` or `body.$`. `input_validation` is in
`DECLARED_RULE_INVARIANTS`, so its rule is declared, not intrinsic, and findings
group by that id: one finding per endpoint and field. Because it is non-terminal
and runs before `status_code`, a 2xx that accepts the poisoned value and also
misses its declared status yields two findings, one per rule
([ADR-137](adr/engine.md#adr-137)).

### How contract completeness is judged

The `contract_completeness` oracle answers the opposite question: did the server
reject, with a 400 or 422, a request the contract accepts? A yes means the server
enforces a validation rule the contract does not declare
([ADR-143](adr/engine.md#adr-143)).

It speaks only on a sent request whose intent names no poisoned field, at an
endpoint that declares response contracts. The request must provably conform,
read field by field through `sent_in_declared_shape` (`runtime/oracles/sent_value.py`):
`validate_value` on the value as the server reads it, then `meets_declared_shape`.
It must break no declared input constraint (`breaks_an_input_constraint`,
`runtime/oracles/semantic/input_constraints.py`). When the endpoint's declared
access is anything but `public` (`CompiledExecutionEndpoint.requires_authentication`),
it must carry a credential: an identity or a configured auth header. Whatever
cannot be shown to conform leaves the oracle silent.

The rule names a field only when the response does. The oracle walks the body's
nested objects, skips the keys of the rejection's own declared schema, and keeps
the keys whose value is a string or a list of strings. The first such key whose
case-folded name is the leaf of exactly one declared request field, at any depth,
gives `ViolatedRule(id="<zone>.<path>")`, such as `body.user.email`; otherwise the
id is `request`. The verdict is non-terminal and runs before `status_code`, so an
undeclared 400 also yields its `status_code_conformance` finding.

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
headers, path=...)` (`runtime/oracles/semantic/scope.py`), used by both the oracle
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
the pipeline continues to the status-code, content-type, schema and latency
oracles, whose violations join the same finding behind the rule. A rule such as "the created article
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
`RuleDecisions(decided, undecided)` (`runtime/oracles/verdict.py`), and the ordered
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
(`runtime/fuzzers/phases.py`) looks the phase up in the phase-extension registry via
`phase_extension_for(phase)` and applies the extension's `refiner` — for the
`semantic` extension, `build_semantic_payloads` — returning the strategy untouched
for any phase with no extension; `plan_passes` calls it as it builds each pass.
`build_semantic_payloads`
(`runtime/fuzzers/semantic/`) mixes, for each declared input constraint, a
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

The oracle sits at precedence 25, before the business rule and every
body-conformance oracle, because it never reads the body: a bypass that also
returns a schema-invalid body must not be masked by a terminal schema violation
raised lower in the chain ([ADR-050](adr/engine.md#adr-050)).

## The finding pipeline

`runtime/findings/` turns raw findings into deduplicated crash reports, the
public finding union and the run's statistics. A finding's life runs signature →
group → shrink → materialize → dedupe → assemble → stats. How a finding is
classified, what its observation and evidence hold, and what is withheld from them
are in [Findings: taxonomy and evidence](findings.md).

- **Signature.** `signature_of` builds a `FindingSignature` from what the
  failure looks like from the outside: endpoint, phase, primary violation,
  status code, identity label, the `rule_id` of the rule the finding broke, the
  field the request poisoned (`poisoned`, when it poisoned one), and a
  *fingerprint of the body's shape* — never its values (an object becomes its keys
  mapped to JSON type names; free text is lowercased with digit runs masked, after
  the values of the credentials the request sent are erased from it, so a signature
  never carries an echoed credential). Every
  finding names a rule, so the id is always present; for an intrinsic invariant
  it is constant (the invariant's own value), so it adds nothing new to identity,
  and for a `semantic_property`, `access_control` or `input_validation` finding
  it is the declared rule's id, so two different business rules broken on one
  endpoint, or two fields it fails to validate, are two findings. The rule's *description* never enters the signature. The identity
  label is carried on every signature but compared only through
  `keyed_identity(invariant, label)`: it splits two findings only when the
  invariant is in `IDENTITY_SCOPED_INVARIANTS` (`access_control`), so a 5xx found
  under three identities is one finding, while two identities crossing one
  access policy are two ([ADR-106](adr/engine.md#adr-106)). `group_findings`
  collapses findings that share a signature, in first-seen order, and the group
  keeps the identity of the finding that stands for it.
- **Shrink.** `shrink_groups` attempts at most two representatives per signature
  (`MAX_REPRESENTATIVES_PER_SIGNATURE`). The first faithful reproducer stands
  for the group's untouched members (counted `collapsed`); a member that was
  never attempted counts `unverified`; one whose shrink did not reproduce counts
  `flaky` — **measured here, where it is observed, never derived by
  subtraction** ([ADR-018](adr/engine.md#adr-018)). A reproduction its control
  request also shows counts `refuted`, and the group yields one `RefutedFinding`
  carrying the first control that refuted it; one whose control got no answer
  counts `unverified` ([ADR-151](adr/findings.md#adr-151),
  [ADR-167](adr/findings.md#adr-167)). In a group that poisoned no
  field, the members the first representative's cause does not explain are probed
  and, when the cause differs, shrunk on their own
  ([ADR-150](adr/findings.md#adr-150)).
- **Materialize.** `build_crash_report` is the single assembler of a
  `CrashReport`, from a `FindingFacts` — the source-agnostic subject of a report
  — plus the request and result. Redaction happens here and nowhere else: request
  headers (`Authorization`, `Cookie`, `X-Api-Key` and the config header names) and
  the sensitive payload fields — every name `is_sensitive_field_name` calls a
  secret, whatever the contract declares, plus the declared ones — are replaced
  with `***`, and the `response_body` is redacted by field name at any depth of a
  JSON body — objects and arrays of objects alike. Of a declared
  `sensitive_fields` entry only the last path segment counts for the response,
  since a response has no zones. The predicate and its exemptions (a token that
  is a count or a cursor, such as `next_page_token`) are described in
  [Redaction](findings.md#redaction); there is no shape heuristic, so a
  JWT-looking string in an unrelated field is left alone. Non-JSON text bodies,
  scalars and `None` pass through name redaction unchanged, and the input body is
  never mutated — the trace keeps the raw body
  ([ADR-060](adr/engine.md#adr-060), [ADR-152](adr/findings.md#adr-152)).
  The observation, the response headers and the request URL are redacted here
  too, slot by slot.
  A second pass erases by **value**: the credentials the request actually sent —
  the identity's headers, `ExecutionConfig.headers`, and the `user:pass@`
  userinfo of the request URL — are replaced with `***` wherever they appear in a
  string of `minimal_payload` or `response_body`, at any depth
  ([ADR-103](adr/engine.md#adr-103)). Each value is matched in its derived forms
  too: the token after the scheme, each cookie's value, the decoded
  `user:password` of a Basic credential and its password, the Basic token with
  or without its base64 padding, and, for URL userinfo, the Basic header httpx builds from
  it and its secret (the password decoded and as written, or the username when
  there is no password). Every form is matched **per character in any encoding a
  server writes**: each character other than an ASCII letter or digit may appear
  raw, as a JSON short escape, as `\uXXXX` in either case, or as a numeric or named
  HTML entity, mixed freely within one echo, read once as a JSON string and once as
  plain text ([ADR-109](adr/engine.md#adr-109)). A form shorter than
  `MIN_SECRET_LENGTH` (8) is not scrubbed in any encoding, so a short value does
  not mangle a body.
  `materialize_report` is the no-shrink path, used by the modes that never
  minimize ([ADR-037](adr/engine.md#adr-037)).
- **Dedupe.** `dedupe_crash_reports` keeps one report per `ReportKey` — method,
  endpoint, invariant, status, the canonical reproducer and, for an
  identity-scoped invariant only, the identity; phase deliberately excluded — and
  folds every duplicate's `represented_findings` into the one it kept, which keeps
  the identity it was observed under.
- **Assemble.** `assemble_findings` reifies the outcomes as the closed `Finding`
  union `EngineRunResult.findings` carries: one `ConfirmedFinding` per
  deduplicated report, then the shrinker's own `FlakyFinding`s,
  `UnverifiedFinding`s and `RefutedFinding`s — each an entry per signature
  carrying the raw `occurrences` it stands for, a refuted one also its control. The counters stay the measurement; the union
  reifies them ([ADR-044](adr/engine.md#adr-044)).
- **Stats.** Four builders, one per lifecycle — `build_stats` (stateless),
  `build_stateful_stats`, `build_unshrunk_stats` (performance, resilience, auth)
  and `build_replay_stats` — all start from the shared `RequestBreakdown`:
  per-endpoint request counts, `by_phase`, `by_attack_family` and latency, plus the
  run's `by_phase` and `by_category` totals. Each builder counts `findings_raw` and
  `findings_confirmed` per endpoint and takes the run's total as their sum, so the
  endpoint rows always add up to it; in a mode that never shrinks, a defect
  observed once counts as confirmed ([ADR-107](adr/engine.md#adr-107)), unless
  resilience's confirmation found it flaky, which `build_unshrunk_stats` counts in
  `findings_flaky` with the confirmation's requests in `requests_shrink`. Latency percentiles are **nearest-rank** (P50/P95/P99):
  always an observed sample, never interpolated, and an unsent request is never
  sampled into a latency it never took.

The counters and their single producers are laid out in
[Data flow](data-flow.md#results-findings-and-their-counters).

## Stateless exploration

`runtime/fuzzers/stateless/` explores one endpoint at a time, no sequencing.

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
folds each result back in draw order. Folding evaluates the oracles on every
result, unanswered ones included (the `infra` oracle is the one suppressor),
records one `RawFinding` per violated rule ([ADR-137](adr/engine.md#adr-137)),
accumulates the oracles' rule decisions (above), and
maintains the abort counters. The concurrent sends are gathered with
`gather_settled`, so when one send raises every sibling's result is recorded
before the first error is raised again.

A valid pass opens with its **minimal request**: `plan_passes` stores the simplest
payload of the pass's strategy as `Pass.minimal_payload`, and the driver runs it
as an explicit `@example` that takes one place of the pass's share
([ADR-115](adr/compiler.md#adr-115)). A poisoning phase no zone of the endpoint can
poison is not planned at all.

**What a pass leaves unspent funds the next pass of its identity.** Hypothesis
ends a pass silently once a strategy's choices run out, so a short `boundary`
space spends a fraction of its share. A `CarryOverLedger`, owned by one call of
`fuzz`, keeps each identity's unspent examples. Before a pass runs, `fund` raises
its share by what its identity left pending, at most its own planned share; after
it, `settle` keeps pending what it did not run, counted as the payloads
Hypothesis handed over (`PassOutcome.examples_run`), sendable or not. A pass
skipped because its phase was exhausted hands its whole share on. Passes run in
phase order, so `valid` never receives, and a ladder step, which repeats payloads
until full, never leaves a remainder. The ledger's `budget_by_phase` —
`PhaseBudget(planned, carried_in)` per phase — lands on the endpoint's stats
([ADR-142](adr/engine.md#adr-142)).

**One stop signal crosses the `@given` boundary.** When folding decides the pass
must stop, it sets a `Cut` on the shared state and raises a single
`StopExplorationError` (`specforge_engine.exceptions`), which unwinds cleanly out
of Hypothesis's machinery to the carried `Cut` — no ad-hoc exception per abort
reason ([ADR-034](adr/engine.md#adr-034)). A pass stops for one of four reasons,
each a `TruncationReason`:

| Reason | Trips when |
|---|---|
| `DEADLINE_EXCEEDED` | the endpoint's `deadline_ms` elapsed before a batch |
| `INFRASTRUCTURE_ABORT` | `MAX_INFRA_FAILURES` target failures, not all of them judged failures, target still answering a probe |
| `TARGET_DOWN` | those failures, and a liveness probe confirms the target is down |
| `GENERATION_EXHAUSTED` | a phase never produced a single generatable candidate |

The target failures are `TARGET_FAILURE_CATEGORIES`: `timeout`, `availability`
and `connection_dropped`. The streak observes the folded result, so it knows which
failures the oracles judged: `ExecutionResult.is_judged_failure` is a result an
oracle turned into a finding, or a dropped connection, which is judged by
definition. A streak made **only** of judged failures, against a target that
answers the probe, is not an outage: the endpoint crashes or hangs on what it is
sent, and every failure is already a finding. The pass keeps exploring, and from
then on the streak counts a judged failure as an answer
(`count_judged_as_answers`), so the endpoint is not probed again for the same
reason ([ADR-132](adr/engine.md#adr-132)).

`ExplorationState` is fresh per endpoint, but the `LivenessProbe` is injected
and **shared across every endpoint of the run**, so the last known-good safe
request (one of `SAFE_PROBE_METHODS`) persists between endpoints and is there to
resend the moment an abort streak needs adjudicating
([ADR-035](adr/engine.md#adr-035)). A run of consecutive 5xx on one endpoint is
adjudicated the same way: past `MAX_CONSECUTIVE_SERVER_ERRORS`, the known-good
request is resent off-budget; if it answers, the 500s are genuine findings, and
if it does not, the run cuts `TARGET_DOWN`. Neither probe — the resent
known-good request nor the `HEAD` to the base URL behind an abort streak — is
counted in the run's request totals or recorded in the trace. A dead target can confirm nothing, so
its raw findings are counted `unverified` — one `UnverifiedFinding` per
signature — rather than spending requests rediscovering the target is down.

**Shrinking** (`shrinking.py`) runs off the findings, never the results, so its
requests stay out of the trace. It first re-sends the finding's own payload to
confirm it still reproduces, then `find`s the smallest payload that still does,
then re-executes that minimal payload to package it; a minimal payload that does
not reproduce on re-execution is flaky and yields no report. A `mass_assignment`
or `input_induced_timeout` finding, and a `contract_completeness` finding that
blames the whole request, is then checked against a **control request**
(`CONTROL_CHECKS`, `control_checks.py`): the payload without the poisoned key,
with the poisoned field at its minimal valid value, or with its open strings
rotated and sent twice. A control that shows the same signal refutes the finding,
which becomes a `RefutedFinding` carrying that control
([Findings](findings.md#states), [ADR-167](adr/findings.md#adr-167)). The shrink
holds the fields a draw took from the run corpus, and never counts them as trigger
fields ([Run depth](run-depth.md#run-corpus)). Reproduction is
judged **by the finding's identity**: `_still_violates` accepts a re-executed
response only when it breaks the same invariant *and* the same rule id as the
original finding (and the search additionally holds the status fixed). That rule
clause is why a minimal reproducer never names a rule it does not break — a
smaller payload that trips a *different* business rule is not the same finding and
is not accepted as its shrink.

## Stateful sequencing

`runtime/fuzzers/stateful/` drives sequences of linked operations as a Hypothesis
`RuleBasedStateMachine`, built **dynamically** for a given set of endpoints:
one `Bundle` per referenced name, one `@rule` per endpoint, and an optional
`@initialize` that fixes one identity for the whole sequence
([ADR-038](adr/engine.md#adr-038)).

A rule's state link drives the chaining: it **produces** a captured
response value into a bundle, **consumes** bundled values into later requests'
zones. The capture primitive itself — `capture`, which pulls a production's
dotted `response_field` out of a response body once its status matches, and
`matches_declared_statuses` — lives in `runtime/state_link/`, the shared home for
state-link mechanics used by both the stateful machine and the auth runner.
A state link also optionally `invalidates` the bundle so a deleted resource is not
operated on again (the core sets it on every `DELETE` consumption but a nested
one), and declares **transition invariants** — a follow-up probe
whose observed status must fall in an expected set, and whose body must reflect
the request's `echoed_fields`. A response that breaks its endpoint's own
invariant, or a transition probe that breaks its own, raises a
`StatefulViolationError`, the signal Hypothesis shrinks on. The error carries the
violating `ExecutedStep`, the observed violations, the sequence that led to it,
and `recheck` — the oracle that judged the step, kept so a re-sent response can be
judged the same way. Each `ExecutedStep` records the `BundleBinding`s it
`consumed` and `produced`, so the sequence says which step fed which.

A **supervisor** runs passes until the machine stops finding anything new. Each
pass ends in a closed union, isolated in one small function around the single
`try`/`except` ([ADR-038](adr/engine.md#adr-038)). `run_pass` returns a
`MachineOutcome`: a `PassOutcome` — `Reported`, `LinkBroken`, `Exhausted`,
`Flaky`, `Completed`, `MachineFailed` — or its sibling `ShrinkCutShort`, a pass
whose shrink spent its budget. `settle_outcome` turns that into a `PassOutcome` on the wire (below),
and the supervisor reacts to it:

- `Reported` appends a minimized crash report, unless a report already holds its
  signature and trigger fields, which then stands for one more finding, and
  **suppresses** that defect in `SuppressedDefects`, so the next pass looks past
  it. A defect found again on another value widens its suppression once. The run
  keeps going until a pass changes nothing, or `max_distinct_bugs` (25) distinct
  defects or flaky signatures are found
  ([Run depth](run-depth.md#stateful-depth)).
- `LinkBroken` raises `StatefulLinkError` carrying the partial exploration.
- `MachineFailed` — the engine itself raised inside the pass, with an exception
  the outcome table does not classify — ends the machine with an `engine_failure`
  cut owned by the endpoint whose rule raised (the first endpoint otherwise), and
  keeps every result ([Isolating a failing endpoint](#isolating-a-failing-endpoint)).
  An error raised inside Hypothesis's own code while the pass holds a shrink
  witness is the exception: `keep_shrink_witness` ends that pass as
  `ShrinkCutShort(witness)` and logs the error
  ([ADR-164](adr/runners.md#adr-164)).
- `Flaky` — a shrink replay that stopped reproducing with no link error inside
  it — becomes a `FlakyFinding`: the recovered violation is turned into a
  `FindingSignature` and its occurrences are accumulated, or, when no violation
  could be recovered, the event is still tallied. A new flaky signature is
  suppressed like a reported defect and counts as progress; so do the first two
  flaky passes with no violation. `build_stateful_stats` sums
  both into `findings_flaky`, and `reconcile_flaky_with_confirmed` folds away any
  flaky finding a confirmed report already stands for
  ([ADR-047](adr/engine.md#adr-047)). A pass whose *rule set* diverged between the
  failing run and its replay lands here too: a rule is eligible only while its
  bundle is non-empty, and bundles fill from the target's own responses, so
  Hypothesis can draw a different set of eligible rules when it replays a failing
  sequence. That pass counts as "could not reproduce" — the same fact as a flaky
  violation — and the run moves on to the next pass. A budget-cut pass whose best
  failure does not reproduce when re-sent lands here too.

### Shrinking and minimizing a stateful finding

A stateful finding is reduced in two parts, each by the tool that is good at it,
and each capped at `STATEFUL_SHRINK_REQUEST_BUDGET` (1 000) wire requests per pass
([ADR-089](adr/engine.md#adr-089)).

**Hypothesis shrinks the payload.** Its shrink re-runs the machine with smaller
choices, with live bundles and the target's real state behind every step, and
that is how a violating payload reaches its smallest form. It does not shorten the
step sequence in practice: it minimizes its own choice sequence, not the engine's
steps. The machine runs without Hypothesis's `explain` phase, which would re-run it
hundreds of times only to annotate a printed report.

**The budget cuts that shrink before the wire.** From the first failure of a pass
the collector counts shrink re-sends and offers every failure to the pass's
**witness**, the best one seen: a violation outranks a link error, and between
violations the smaller canonical payload of the violating step wins, then the
shorter sequence. Both send sites — a rule step and a transition probe — call
`guard_shrink_budget` before the wire; once the pass's count reaches the budget
and a witness is in hand, it raises `ShrinkBudgetSpentError(witness)`. A pass with
no witness is never cut. Hypothesis may end a cut pass through its own determinism
check rather than through that signal, so the collector's record decides:
`honor_budget_cut` keeps a `Reported` or a `LinkBroken`, and turns any other ending
of a cut pass into `ShrinkCutShort(witness)` (`LinkBroken` when the witness is a
link error).

**The engine minimizes the sequence.** `settle_outcome` runs the sequence
minimizer (`minimizer.py`) on a `Reported` and on a `ShrinkCutShort`; every other
outcome passes through.

1. `data_slice` keeps, transitively, every step that produced a bundle value a
   kept step consumed, and for a transition probe the nearest earlier step that
   moved the value the probe re-reads (its trigger). The violating step is always
   kept.
2. If the slice leaves steps out, it is re-sent alone; when it reproduces, it is
   the reproducer.
3. A `ShrinkCutShort` witness that the slice did not settle is re-sent whole, once,
   whatever the budget has left. If it does not reproduce, the outcome is
   `Flaky(witness)`, never an unverified report.
4. Otherwise each step outside the slice is dropped in turn, keeping every drop
   that still reproduces, in passes until one drops nothing.

Every attempt goes through `WireResender`, which re-sends each step's recorded
`RequestBlueprint` verbatim — no regeneration, no bundle re-capture — through the
same send gate, collector and progress tick as a rule step. A send the gate
blocks stops the search. A re-send reproduces when its last response has the
original status code and `recheck` reports the same invariant under the same rule
id. The reproducer is rebuilt from the fresh results of the re-send that
reproduced, so the report shows the responses the minimal sequence actually got;
a deletion that breaks reproduction is undone. An attempt that would overrun the
budget is not made, and the search ends with the best verified reproducer. A
`Reported` that no attempt reproduces keeps its original sequence, which
Hypothesis's own final replay already verified.

The slice is what makes verbatim re-sending safe to delete against. A re-sent
request carries the original ids, and the resources the original run created still
exist on the target, so an unconstrained deletion would drop the step that created
a resource, or the `DELETE` that triggers a transition probe, and still
"reproduce". Keeping the slice rules that out by construction.

All of these re-sends are shrink traffic: they are counted in `requests_shrink`
and recorded in the stateful trace, never in the explored results.

Two guards decide whether the next step may be sent, both answered by the
collector's single `is_send_blocked(endpoint_id)`. A per-endpoint
`EndpointCircuitBreaker` takes an endpoint that stops answering out of the
machine for the rest of the run — there is no half-open state — so one dead
endpoint cannot starve a still-live consumer of a bundle it needs; that stays the
breaker's job, "one endpoint broken, the rest alive". A streak of judged
failures alone, dropped connections included, does not open it: the endpoint
answered with something the engine reports, and whether the target itself is down
is the run-wide watch's call ([ADR-132](adr/engine.md#adr-132)). Alongside it, a **run-wide
liveness watch** (`RunLivenessWatch`, a `LivenessWatch` composed onto the
collector) feeds the shared `TargetLivenessMonitor` from the
collector's one `record` point. Both send sites — a rule step and a transition
probe — ask `is_send_blocked` the one question: the run stopped (cancelled, or the
watch confirmed a dead target) or this endpoint's own breaker is open.

So a dead target now costs at most `MAX_INFRA_FAILURES` requests plus **one**
liveness probe for the whole run, not one failure streak per endpoint. Once the
watch's probe confirms the target is down, every send is blocked: a pass already
in flight drains as no-op steps (it never raises — an exception inside a
Hypothesis example would come back as a `FlakyFailure`), and the supervisor stops
between passes.

The run-level truncation is resolved with the run-wide cut winning over the
breakers'. A confirmed dead target cuts `TARGET_DOWN` naming the endpoint of the
request that completed the failure streak (mirroring the stateless fold), and it
wins over a breaker-derived cut because it happened first. Absent a run-wide cut,
the truncation is inferred from which breakers opened: `TARGET_DOWN` when every
rule endpoint the run reached opened, `INFRASTRUCTURE_ABORT` when only some did,
`GENERATION_EXHAUSTED` when the machine never drew an eligible sequence, and
`STATE_LINK_ABORT` when a link could not be honored.

A `TARGET_DOWN` cut therefore reaches one of two verdicts, carried on the
runtime-only `StatefulExplorationOutcome.target_down_verdict` and announced to the
observer: `LIVENESS_PROBE_FAILED` when the run-wide probe confirmed it, and
`CIRCUIT_BREAKERS_OPEN` for a reachable base URL whose rule endpoints all broke —
a gateway up with its backends down. A probe that *answers* never halts the run:
the target is alive, the streak resets, and the per-endpoint breakers stay in
charge, so both verdicts remain reachable. The verdict travels in the outcome, not
in the persisted `TruncationRecord` (whose `endpoint_id` the CLI reads), so the
runner announces the verdict the outcome carries rather than assuming one
([ADR-066](adr/engine.md#adr-066)).

## Isolating a failing endpoint

An exception the engine raises while exploring one endpoint — generating,
building, sending or folding its requests — costs that endpoint, never the run
([ADR-120](adr/engine.md#adr-120)). `runtime/bulkhead.py` is the bulkhead:

- `guard_endpoint(endpoint_id, work, evidence=...)` runs one endpoint's work. It
  wraps the shared loop's `fuzz_one` (stateless and performance) and the per-endpoint
  work of the auth and resilience runners.
- `CONTROL_EXCEPTIONS` pass through untouched: `StopExplorationError`,
  `asyncio.CancelledError` and `SafetyGuardBreachError`, which must still stop the
  run. Only `Exception`s are caught, so `KeyboardInterrupt` and `SystemExit` are
  never held.
- Any other exception becomes an `EngineFailure`: a `TruncationRecord` with
  reason `ENGINE_FAILURE`, the endpoint id, the requests it sent and a `detail`
  of `<type> @ <file>:<line>` of the root cause (`describe_failure`; exception
  groups are unwrapped by `root_cause`), plus the evidence below.

**What the endpoint sent is kept.** `SentEvidence(results, findings)` is what the
endpoint had sent and found when it raised; `failed_outcome` turns it into the
endpoint's `ExplorationOutcome` with the cut. The shared loop reads it through the
required `EndpointLoopSpec.evidence_of` — the stateless fuzzer's `sent_to` — and
the auth and resilience runners record each result before judging it. Concurrent
sends are gathered with `gather_settled` (`runtime/harness/settled.py`), so one
send that raises never discards its siblings.

**The run goes on.** The loop folds every endpoint's cut with `kept_cut`: a cut
that halts the run (`target_down`, `cancelled`) outranks any other, and otherwise
the first one recorded stands. `run_status_of` maps `engine_failure` to
`truncated`, so a run with an engine failure is never `completed`.

**The traceback goes to the engine's logger.** `engine_failure_record` logs the
error and its traceback on `logging.getLogger(ENGINE_LOGGER_NAME)`
(`"specforge_engine"`, `log.py`). The library adds no handler: the embedding
process decides where records go, and the core writes the engine's `ERROR`
records to stderr while it serves the protocol on stdout. The message stays in the
log and out of `detail`, which travels to the report and the database and could
echo a drawn value.

The other places the engine can raise follow the same rule:

| Where | What happens |
|---|---|
| a stateless pass | the batch flush keeps the error and raises the same one when Hypothesis replays the example, so the detail names the engine's error, not Hypothesis's wrapper |
| a stateful pass | an exception the outcome table does not classify is `MachineFailed`; the supervisor records an `engine_failure` cut owned by the endpoint whose rule raised (the first endpoint otherwise) and keeps the results |
| one finding's shrink | the shrink runs inside `isolate`, keyed by its endpoint: the exception becomes an `engine_failure` cut of that endpoint, recorded in `ShrinkOutcome.engine_failures` and put on its stats row; the endpoint's remaining findings are not attempted, every other endpoint's are shrunk, and the first such cut is offered as the run's ([ADR-133](adr/engine.md#adr-133)) |
| the resolve step outside any shrink | every finding group is reported as an `UnverifiedFinding` and the run is cut `engine_failure` at the endpoint whose finding was being shrunk (`EndpointLoopSpec.shrinking_at`) |
| an auth endpoint with no valid request | not a failure: the endpoint is cut `generation_exhausted` with the detail `no valid request available to cross`, and the run goes on |

A replay re-sends a recorded trace and explores no endpoint, so it has no
bulkhead.

## Trace and replay

`runtime/trace/` records **only what a run put on the wire**, in send order —
the recipe for reproducing it. A stateless run's shrinking requests are absent by
construction; a stateful run's shrink re-sends and minimizer replays did reach the
wire in sequence, so its trace holds them, and `requests_shrink` counts them apart.
Each `TracedRequest` is an observed fact: credentials are *omitted* rather than
redacted (only the config header names are kept), a URL's `user:pass@` is
stripped and flagged with `omitted_url_userinfo`, the raw `path_params` sent
before URL interpolation are recorded alongside the query and the body with its
`media_type` and `file_fields`, the intent is recorded as `phase`,
`poisoned_zone` and `poisoned_field` (the `intent` property reconstructs the value),
and `sent_at_ms` is excluded from anything hashed. `path_params` is a required field:
a trace recorded before it existed fails validation on load rather than
rehydrating without it — traces are regenerated, not migrated. `canonical_json` serializes a trace so equal content
yields equal bytes, and `content_hash` is its SHA-256 with the timing dropped,
so two runs that sent the same requests content-address alike.

The trace is the replay recipe, not a shareable report, so it is **not** put
through body redaction: a request's `body` is generated data, and the
config/identity credential headers were already omitted by name. One consequence
is worth stating plainly: a value the engine captures from a response through a
state link — a resource id, by design — is re-sent verbatim on replay, so a
producer that captured a secret into a bundle would leave it in the trace.

`rehydrate_request` is the inverse: it reconstructs a `RequestBlueprint` from a
traced request under a fresh config. It re-encodes the recorded body by its
recorded media type, applies the reserved-header rule to the credentials — a
traced header with a credential's name is dropped and refilled from the live
credentials, while the traced `Content-Type` is kept, since it is the one that went
out — and applies three rules — the recorded
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

`runtime/replay/` compares and paces. `assess_fidelity` classifies a replay as
`EXACT` or `REDUCED`: a request whose observed status differs from the recorded
one is a `ResponseDivergence`, but a divergence on a request that was itself a
finding does not reduce fidelity — re-observing it is the point. Pacing is a
strategy chosen by a factory, never a runtime flag
([ADR-040](adr/engine.md#adr-040)): `TimedPacer` waits until each request's
recorded `sent_at_ms` measured from a fixed `t0`, so drift never compounds and a
past slot waits zero; `ImmediatePacer` never waits.

A replay does not blindly re-send a dead target's whole trace. `runtime/http/`
carries a `TargetLivenessMonitor` — shared machinery used by every mode that
probes: the `ReplayRunner` feeds it each result as it returns, the stateful mode
feeds the same monitor through its run-wide watch (above), and the two sequential
runners (resilience and auth) feed it through a per-batch `TargetWatch`
(below). The monitor counts a streak of target failures — the
`TARGET_FAILURE_CATEGORIES` (`timeout`, `availability`, `connection_dropped`) —
and ignores anything that was never sent (no evidence either way). When the
streak reaches `MAX_INFRA_FAILURES` (5) it fires one `probe_liveness()` `HEAD`: a
dead target returns `target_down` and a live one `infrastructure_abort`, and
either stops the loop with a `TruncationRecord`. A live target behind a streak of
judged failures only (dropped connections included) returns no verdict: the run
goes on, and that streak counts later judged failures as answers. `run_status_of(truncation)` then maps that record
to the run's status — `aborted` for `target_down`, `truncated` otherwise.

The monitor takes the run's cancellation token and can **abandon a probe in
flight**. It runs the `HEAD` as a task and races it against the token in
poll-interval steps; if the run is cancelled while the probe is outstanding, the
monitor cancels the task and yields **no verdict**. An in-flight request cannot be
called back, and an abandoned probe confirms nothing, so the monitor discards it
rather than awaiting a full timeout — a cancelled run never *holds* for a probe.
`probe_liveness` keeps its boolean signature; only the monitor's internal verdict
widened to allow "no verdict". Because the race lives in the monitor, every mode
that probes benefits — the replay and the stateful watch simply pass their token.

### The per-batch target watch

The resilience and auth runners iterate endpoints sequentially but dispatch each
endpoint's batch — the chaos battery, or the identity crossings — concurrently.
`runtime/runners/target_watch.py` gives them dead-target detection without a copy
of the streak logic: `TargetWatch.for_run(orchestrator, request)` composes the
shared monitor wired to the run's orchestrator and cancellation token, and
`observe_batch(batch, endpoint_id)` feeds each result of one endpoint's batch to
the monitor. The first result whose verdict is `TARGET_DOWN` announces a
`TargetDown` event with `LIVENESS_PROBE_FAILED` and returns a `TARGET_DOWN`
truncation record naming that endpoint and counting what the batch put on the wire;
otherwise it returns `None` and the run goes on.

**The cut is between endpoints, deliberately.** Each runner judges an endpoint's
batch, then asks the watch, and stops on a cut before the next endpoint. Because a
batch is dispatched concurrently, its timeouts are paid in parallel, so a batch
already on the wire lands in full — walking every endpoint against a dead target is
what cost minutes, and cutting mid-batch would be a rewrite of the concurrent send
path to save a fraction of one timeout. An auth endpoint whose policy sends nothing
leaves the streak untouched. Neither runner has a per-endpoint circuit breaker, so
`LIVENESS_PROBE_FAILED` is the only target-down verdict they reach —
`CIRCUIT_BREAKERS_OPEN` belongs to the stateful mode. One boundary of what this
detects: a target whose base URL answers while every endpoint is broken is still
walked in full, since any answered result resets the streak.

A streak a probe already resolved **starts over on the next failure**, so a caller
that keeps running is not re-probed on every following failure. The `streak` still
reads the threshold immediately after the verdict — the value the replay
reports — and only rolls back to zero when the next failure arrives.

Because the loop can stop short, the produced trace is a **prefix** of the
recorded one. `assess_fidelity(recorded, observed, truncation)` takes that record:
it compares `observed` against the matching prefix of the recorded requests, and
allows `observed` to be shorter than the recording **only** when a truncation is
present (a short replay with no truncation, or an overshoot, is still a
programming error and raises). The level it returns therefore describes the prefix
alone, and the truncation record itself rides along in the trace it hands back.
