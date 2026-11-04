# Result vocabularies

The envelope does not type an operation's `result`, so the schema cannot list the
values a result field may take. The fields on this page are the ones a frontend
is expected to **branch on**: each takes only the values listed here, every one
of them may appear, and a new value is a protocol change with its own changelog
entry. This page is the one place they are enumerated; the other pages link here.

Where the same concept appears in a reply and in the report document that
`fuzz`, `replay` and `run_pipeline` answer with, it has the same name and the
same values in both. A missing fact is `null`, never an empty string; an empty
collection is `[]` or `{}`.

These tables are the human version. The machine version, with the label of every
value, travels in the handshake's [`vocabulary`](handshake.md#vocabulary).

## `run.status` { #run-status }

How a stored run ended. In `list_runs`, `get_run` and the report document's
`run`.

| Value | Meaning |
| --- | --- |
| `completed` | The run went through its whole plan. |
| `truncated` | The run was cut short (`run.truncation` says why) and holds what it gathered until then. |
| `aborted` | The API went down, or a stateful chain could not be honored. |
| `cancelled` | The client asked the run to stop (see [cancellation](events.md#cancellation)). |
| `safety_breached` | Requests reached a route the safety guard held back; the run is kept, with that evidence. |

A run that fails outright is never stored, so `failed` is not a `run.status`.
The persistence layer stores these five values under a CHECK constraint.

The [operation status](#operation-status) is not the run's verdict: `completed`
there means the operation ran and answered a document, and a `truncated` run
answers it too. Read the verdict from `run.status` and `run.signal`; a
`truncated` run's signal is always `degraded`, with
[`run_truncated`](#signal-causes) among its causes.

## `run.comparability` { #comparability }

Whether this run's defects can be compared with another run's.

| Value | Meaning |
| --- | --- |
| `comparable` | The run can be compared as it is. |
| `truncated` | The run was cut short. |
| `aborted` | The run was aborted. |
| `cancelled` | The run was cancelled. |
| `safety_breached` | The run breached the safety guard. |
| `reduced_fidelity` | A replay that did not reproduce its trace exactly. |
| `unknown_status` | The run carries a status this build does not know. |

## `run.oracle_scope` { #oracle-scope }

Which oracles judged the run's responses. Two runs judged by different scopes
report different kinds of defect.

| Value | Meaning |
| --- | --- |
| `contract` | Every check the contract makes possible. |
| `contract_free` | Only the checks that need no contract, which is what a replay runs. |

The persistence layer stores these two values under a CHECK constraint.

## `truncation.reason` { #truncation-reason }

Why a pass stopped before its plan was exhausted. The run carries it in
`run.truncation`, and each entry of `endpoints` carries its own in `truncation`,
set when that endpoint's pass was cut short whether or not the run was.

| Value | Meaning |
| --- | --- |
| `infrastructure_abort` | Too many timeouts or transport failures in a row. |
| `deadline_exceeded` | The time budget ran out. |
| `target_down` | The API stopped answering; [`target_down_verdict`](#target-down-verdict) says how the run concluded it. |
| `state_link_abort` | A stateful chain could not be honored: a fault of the harness, not of the API. |
| `generation_exhausted` | No request could be generated for the endpoint. |
| `engine_failure` | The engine itself raised while exploring the endpoint; it was isolated and the run went on. |
| `pass_limit_reached` | A stateful run that kept making progress stopped at its limit of passes. |
| `flaky_generation` | A stateful run's passes kept ending because the target answered differently from an earlier test case, so it stopped before a clean pass. No endpoint caused it: `run.truncation.endpoint_id` is `null`, and the `truncated` event carries no `endpoint`. |
| `cancelled` | The client asked the run to stop. |

Every reason but `flaky_generation` names the endpoint the run was exploring in
`run.truncation.endpoint_id`. `detail` beside it is free text for a person, or `null`. For `engine_failure` it
names the error's type and where it was raised (`<type> @ <file>:<line>`); the
message and the traceback are in the core's stderr log, never in the report.

## `target_down_verdict` { #target-down-verdict }

How the run concluded the API was down. It sits on `run.truncation` and is set
only when the reason is `target_down`.

| Value | Meaning |
| --- | --- |
| `liveness_probe_failed` | A liveness probe against the API failed. |
| `circuit_breakers_open` | Every endpoint the run had sent requests to opened its circuit breaker. |

## Coverage dispositions { #coverage }

Every endpoint of an analysis falls into exactly one disposition, and `coverage`
counts each one: in `get_run` under `coverage.counts`, in `list_analyses` and
`get_analysis` under `coverage`, and in the report document flat in `coverage`
(`null` for a replay).

| Value | The endpoints that were... |
| --- | --- |
| `targeted` | Declared and fuzzed. |
| `excluded` | Declared, and rejected by the compiler or [withheld](#producer-exclusion-disposition); `excluded_endpoints` lists each with its `reason`. |
| `filtered` | Declared, and left out by the run's endpoint selection. |
| `reached_by_transition` | Never declared, and reached only by a stateful transition; `reached_by_transition_endpoints` lists each as `{method, path}`. |

`declared` is `targeted + excluded + filtered`: an endpoint reached by a
transition is never counted as declared. The persistence layer stores these four
values under a CHECK constraint.

## `producer_exclusions[].disposition` { #producer-exclusion-disposition }

What the run did with an endpoint whose produced contract it could not use. In
`get_run` and the report document's `producer_exclusions`, beside `method`,
`path` and `reason`.

| Value | Meaning |
| --- | --- |
| `schema_only` | The endpoint stayed targeted and was fuzzed from its schema alone. |
| `withheld` | Its contract declared a risk flag and could not be used, so it was never fuzzed as a target; the coverage also counts it `excluded`, with a `reason` starting `withheld:`. In a mode that does not hold its flag, transition probes and same-route siblings may still reach its route. |

An endpoint is withheld only when the producer returned a contract and adopting
it failed: an identity that does not match the endpoint, a fusion failure, or a
construct the projection does not support. A failure before a validated contract
exists (an inference error, an output that failed validation, a vanished cache
entry, the cost cap, an untraced endpoint) leaves it `schema_only`. The two
lists answer different questions and share the `(method, path)` key: the
coverage says where the endpoint ended up, `producer_exclusions` what failed in
the producer. The persistence layer stores these two values under a CHECK
constraint.

## `endpoints[].unprobed_reason` { #unprobed-reason }

Why the `auth` mode crossed nothing at a targeted endpoint, the `resilience`
mode sent it nothing, or a `stateful` run's exploration never sent it: by design,
for an access precondition the run could not meet, or because the exploration
never reached it. `resilience` reports `required_role_unheld`,
`owner_identity_missing`, `link_target_reserved` and the three `owner_*` reasons;
`auth` reports every access value but `owner_identity_missing`; `stateful` reports
`link_value_never_produced` and `rule_never_drawn`, and none when the run was cut
short (`run.truncation` explains it then). In `get_run` and the report document's
`endpoints`; `null` when the endpoint was probed.

| Value | Meaning |
| --- | --- |
| `declared_public` | The access policy is public: there is nothing to cross. |
| `access_undeclared` | The contract declares no access policy. |
| `owner_producer_missing` | Nothing in the run produces the owner's resource or one it depends on. A producer the safety guard held back counts as missing, and needs `allow_side_effects`. |
| `owner_chain_cyclic` | The owner's resource depends on itself through its producers, in every candidate. |
| `owner_resource_unprovisioned` | Every attempt to create the owner's resource failed, or its producer has no payload; the attempts are in the trace. |
| `required_role_unheld` | No declared identity holds the required role. |
| `owner_identity_missing` | No valid identity is declared to own the resource, so `resilience` sends the `owner_only` endpoint nothing. |
| `link_target_reserved` | A state link of the endpoint, or of every producer of the owner's resource, writes a bound value into a header the credentials or the transport own, so nothing is sent; an `auth` run whose only endpoint to cross is left unprobed this way fails with `EXECUTION_FAILED`. |
| `link_value_never_produced` | Every time the `stateful` exploration drew the endpoint, a value it consumes had not been produced yet: its producer never answered with a status that produces it. The producer's requests are in the trace. |
| `rule_never_drawn` | The `stateful` exploration never drew the endpoint at all. |

The six from `owner_producer_missing` to `link_target_reserved` are access
preconditions the run could not meet; each one makes the run's signal `degraded`
with [`access_preconditions_unmet`](#signal-causes). The two `stateful` reasons make
it `degraded` with [`link_values_unproduced`](#signal-causes). An endpoint that
received any request never carries either of them.

For `link_value_never_produced`, look at the requests of the endpoint that produces
the value (the one whose links name it as producer): it never answered with a status
that captures the value. For `rule_never_drawn`, give the exploration more room: a larger
`max_examples` or `step_count` ([stateful options](../../specforge-engine/execution-modes.md#options-per-mode)).

## `run.signal_causes` { #signal-causes }

Why a run's `signal` is `degraded`, in the order they render. In `get_run` and
the report document's `run`, beside `signal` (`clean` or `degraded`); `[]` when
the signal is not `degraded`.

| Value | Meaning |
| --- | --- |
| `no_responses` | No request reached the target: every attempt was an availability, timeout or unsendable-request failure. |
| `requests_unanswered` | Some requests reached the target, but an endpoint left at least three of its requests, and at least 5 % of them, with a timeout or an availability failure, so what the run says of that endpoint rests on the rest. `metrics.by_category` and the endpoint's `by_category` count them. Never raised beside `no_responses`. |
| `endpoints_excluded` | One or more declared endpoints were excluded from this run. |
| `withheld_by_safety_guard` | The safety guard held back one or more targeted endpoints, so they were never probed. |
| `access_policy_undeclared` | One or more targeted endpoints declare no access policy, so the `auth` run verified nothing there. |
| `access_preconditions_unmet` | One or more targeted endpoints had an access policy the run could not cross: no producer, no role holder, no owner, no resource it could create, or a state link into a reserved header; each one's [`unprobed_reason`](#unprobed-reason) says which. |
| `link_values_unproduced` | One or more targeted endpoints were never sent by a `stateful` run: the value they consume was never produced, or the exploration never drew them; each one's [`unprobed_reason`](#unprobed-reason) says which. Those endpoints do not count toward `endpoints_unreached`. |
| `run_cancelled` | The run was cancelled before it reached every targeted endpoint. |
| `run_truncated` | The run's `run.status` is `truncated`: it was cut short before its plan was exhausted, even when every targeted endpoint received requests. `run.truncation` says why. It can stand beside `endpoints_unreached`. |
| `endpoints_unreached` | One or more targeted endpoints never received a request. |
| `load_unjudged` | One or more endpoints' load profiles judged no step: every `degraded` is `null`, because the baseline or every step was measured on no samples. |

The signal and its causes are derived from the run's facts, both for the report
a run answers with and when a stored run is read, so the persistence layer
keeps no column for them.

## `endpoints[].load_profile[].degraded` { #load-step-degraded }

`true` or `false` when the step was judged; `null` when the step or its baseline
(the ladder's first step) was measured on no samples, so it is unmeasured rather
than healthy. A ladder with no step judged makes the run's signal `degraded` with
[`load_unjudged`](#signal-causes).

## `strategy` { #strategy }

Which family of values a run generates, and which extra checks judge the
answers. The `strategy` parameter of `fuzz`, `run_pipeline` and
`estimate_inference` takes one of these values, the `started` event of a run
carries the one it runs with, and an analysis carries it as `strategy` in
`list_analyses`, `get_analysis`, `get_run`'s `analysis` and the report document's
`analysis`. Any other value, `hacker` included, is refused `INVALID_PARAMS`.

| Value | Meaning |
| --- | --- |
| `default` | Schema-only generation. |
| `security` | Generation widened toward adversarial values. |
| `conformance` | Schema-only generation that also flags response fields the contract does not declare. |
| `smoke` | A short run of valid requests only. |
| `exposure` | Writes the fields the contract marks read-only and probes mass assignment. |

An analysis also carries `examples_per_endpoint`: the count the run asked of each
endpoint, `null` when its runner honors no count or for an analysis stored before
it was recorded ([Examples per endpoint](fuzz-options.md#examples-per-endpoint)).

## `fuzz_options.effects[].changes` { #changes }

What a strategy changes against `default` in one runner variant under one
producer ([the effects matrix](fuzz-options.md#effects)), listed in this order;
`[]` means nothing.

| Value | When |
| --- | --- |
| `payloads` | The runner draws from the plan, and the strategy's phases restricted to what it takes differ from `default`'s (with their shares, when it takes every planned phase), or its attack families, its contract type or whether it omits read-only fields differ. |
| `oracles` | The strategy turns on oracles `default` does not, and the runner's opt-in oracles judge what it sends. |
| `examples` | The examples the run would ask of each endpoint differ from `default`'s, after the runner's own cap; never for a runner that honors no count. |
| `llm_profile` | The producer is `inference` and the strategy's LLM profile differs from `default`'s. |
| `field_hints` | The producer is `fixture` or `inference`, the runner draws from the plan, and the strategy promotes the fields its contracts hint at where `default` does not. |

## `category` { #category }

The kind of defect a finding reports. In each entry of the report document's
`defects` and `unconfirmed_findings`, in `get_run`'s and `get_finding`'s findings,
and in the [`finding` event](events.md#the-event-catalog). Fixed per invariant by
the engine's [registry](../../specforge-engine/findings.md#taxonomy) and derived
when the finding is read, so a run stored before reads back classified as the
registry says today; `null` only when the core runs without the engine.

| Value | Meaning |
| --- | --- |
| `crash` | The API failed: a 5xx, or a broken request it did not reject cleanly. |
| `security` | The API leaked, accepted or reflected what it should not, or an input stalled it. |
| `access` | A caller reached what its access policy forbids. |
| `business_rule` | A rule the contract declares, or a state transition, did not hold. |
| `contract_hygiene` | The API and its contract disagree: status, Content-Type, schema, validation, or a response field the contract does not declare. |
| `performance` | A clean response was too slow, or slowed down under load. |

## `severity` { #severity }

How serious a finding is, beside `category` and wherever it is. Listed from the
most severe; the report's `defects` and `unconfirmed_findings` sort by it first,
then by the invariant's place in the engine's registry. `null` only without the
engine, and then neither orders anything.

| Value | Meaning |
| --- | --- |
| `critical` | An access boundary was crossed. |
| `high` | A server error, a broken business rule or state transition, sensitive data exposed or a privileged field accepted. |
| `medium` | Internal details leaked, input reflected or stalling the API, invalid input accepted, a response off its schema, a latency defect, a malformed request handled badly. |
| `low` | A valid request rejected, a Content-Type off its contract, or a response field the contract does not declare. |
| `info` | A status the contract does not declare. |

## `observation.location.scope` { #location-scope }

Where in the exchange the value a finding observed lives, which fixes how
`observation.location.path` reads. In each finding's `observation`; `location` is
`null` when the observation names no place. What each invariant observes is in
[the observation](../../specforge-engine/findings.md#observation).

| Value | `path` is |
| --- | --- |
| `request_field` | `<zone>.<dotted.path>` of a request field, spelled as a rule id (`body.user.email`) |
| `response_body` | An RFC 6901 pointer into the response body; `""` is the whole body |
| `response_header` | The lower-case name of a response header |
| `load_step` | The concurrency of the load step |
| `caller` | The label of the identity that sent the request |
| `follow_up` | `<METHOD> <path>` of the follow-up request |

## Replay verdicts { #replay-verdicts }

A replay rules each request the recorded run saw violate an invariant
(`replay.verdicts`) and each defect the recorded run confirmed
(`replay.defect_verdicts`), with the same three values:

| Value | A recorded request is... | A recorded defect is... |
| --- | --- | --- |
| `present` | reproduced, or still violating an invariant | `present` when a recorded request at its method, path and status is |
| `possibly_resolved` | changed, the recorded run kept there a finding the replay's contract-free oracles can observe, and a witness stands before it (below) | `possibly_resolved` only when every such request is, and the replay can observe its invariant |
| `inconclusive` | anything else | anything else, also when no recorded request matches it |

`replay.judged` counts the defect verdicts under the replay's `oracle_scope`;
`present`, `possibly_resolved` and `inconclusive` sum to `recorded_defects`. Each
entry of `replay.defect_verdicts` names the confirmed finding it rules on in
`finding_id`. A defect of an invariant the replay cannot observe (a response
schema, a declared rule, a timeout on the whole request, ...) is `inconclusive`,
never resolved ([ADR-154](../adr/core.md#adr-154)). The run of a replay keeps
`judged` and `defect_verdicts`; `get_run` reads them back
([A stored replay's verdicts](run-detail.md#replay)).

**A changed answer resolves nothing on its own.** An analysis-wide `replay` sends
no [witnesses](finding-replay.md#what-it-sends) of its own: its witnesses are the
requests it recorded. A recorded request on a defect reads `possibly_resolved` only
behind a witness, an earlier request of the same replay that:

- was not a finding when recorded, and got a success (2xx) then;
- was sent by the same identity, on any endpoint, or both were sent without one;
- answered, in the replay, as it was recorded.

Without one the request is `inconclusive`, and so is the defect recorded there. A
trace whose every request was a finding has no witness, so nothing in it reads
resolved; neither does a witness of another identity, one recorded after the
defect, one that diverged, or one a truncated replay never sent.

**Refused credentials resolve nothing either.** A request recorded with credentials
(an identity, the configuration's headers or the URL's userinfo), not refused for
them then, that the replay gets a `401` or `403` for, is `inconclusive` whatever
witness stood before it: a witness may be a public endpoint that never proves the
credentials. A request recorded without credentials and answered `401` or `403` is
judged as any other answer. When the replay reads `inconclusive` where a defect
seemed fixed, replay the finding itself with `replay_finding`, which sends its own
witnesses and says why it [could not tell](#inconclusive-reason).

These rules hold for replays made by a core speaking protocol `0.2.2` or later; a
replay stored before keeps the verdicts it recorded. A finding's replay
(`replay_finding`) starts from the same engine verdict on its one request and then
earns, or loses, `possibly_resolved` ([Finding replay verdicts](finding-replay.md#verdict)).

## `inconclusive_reason` { #inconclusive-reason }

Why a finding's replay could not tell whether the defect is still there. In
`replay_finding`'s answer and `verify_finding_fix`'s `replay`, beside `verdict`;
`null` unless `verdict` is `inconclusive`, and for a replay cancelled before its
request was sent. The reasons are checked in this order and the first that holds is
the one given; what to do for each is on
[Finding replay verdicts](finding-replay.md#verdict).

| Value | Meaning |
| --- | --- |
| `no_answer` | The server did not answer the finding's request (down, timed out, connection dropped), or no witness answered and the request was not sent. |
| `stale_target` | The server answered with the code from before a fix applied over the finding's handler files (`stale_reason` or `stale_target` set). |
| `credentials_refused` | The request, recorded with credentials, now gets a `401` or `403`, and no witness proved the credentials still pass. |
| `witness_diverged` | A witness no longer answers as recorded: the server's data, or the credentials, are not the ones the finding was recorded against. |
| `unwitnessed` | The server answered otherwise, but the trace held no witness to vouch that it still answers as recorded. |
| `not_observable_without_contract` | The server answered otherwise, but the finding's invariant can only be judged against a contract the replay does not check. |

## `replay_alone.reason` { #replay-alone-reason }

Why `replay_finding`, and so `verify_finding_fix`, cannot send a finding's request
alone. On every finding, in `get_run` and `get_finding`, as
`replay_alone: {possible, reason}`; `reason` is `null` when `possible` is `true`.
The reasons are checked in this order and the first that holds is the one given:
the one `replay_finding` refuses the finding with, `REPLAY_NOT_REPRODUCIBLE`. What
`possible: true` does not promise is on
[Run detail](run-detail.md#replay-alone).

| Value | Meaning |
| --- | --- |
| `stateful` | The finding needed prior requests to build its state: replay its analysis instead. |
| `refuted` | Its control request showed it is not a defect, so it has no request to replay alone. |
| `trace_pruned` | Retention pruned its analysis's recorded trace. |
| `not_in_trace` | Its analysis's recorded trace does not hold the request it was reported from. |

## Comparison caveats { #caveats }

In `compare_runs`, each entry of `caveats` says why two runs' defect sets are
not directly comparable. `side` says whether it concerns the `before` run, the
`after` run or the `pair`; `detail` is free text for a person, or `null`.
Branch on `reason`, show `detail`. `comparable` is `true` only when `caveats` is
empty, the `replay` caveat included: a comparison against a replay is never
`comparable`.

| Value | Side | Meaning |
| --- | --- | --- |
| `truncated`, `aborted`, `cancelled`, `safety_breached`, `reduced_fidelity`, `unknown_status` | `before` / `after` | That run's [`comparability`](#comparability). |
| `engine_version_differs` | `pair` | The two analyses ran on different engine versions. |
| `engine_version_unknown` | `pair` | Neither analysis recorded its engine version, so they cannot be assumed equal. |
| `spec_differs` | `pair` | The analyses were generated against different spec revisions. |
| `execution_mode_differs` | `pair` | The analyses were generated in different execution modes. |
| `oracle_scope_differs` | `pair` | Different oracles judged the two runs. |
| `strategy_differs` | `pair` | The analyses ran different [strategies](#strategy), so one may have judged with oracles or drawn values the other never did. |
| `examples_differs` | `pair` | The analyses asked a different number of examples of each endpoint; silent when either recorded none. |
| `scope_differs` | `pair` | The runs exercised different endpoints; `detail` says how many of the first run's the second exercised and, when it covered more, how many the first did not. |
| `replay` | `after` | The later run is a replay: it records verdicts per recorded request, not crashes. |
| `replay_report_not_indexed` | `after` | The replay's report was never recorded. |
| `replay_report_missing` | `after` | The replay's report is missing from disk. |
| `replay_report_corrupt` | `after` | The replay's stored report fails its integrity check. |
| `replay_report_unreadable` | `after` | The replay's report file cannot be opened. |
| `replay_report_undecodable` | `after` | The replay's report carries no verdicts this build can decode. |

Against a replay stored since protocol `0.2.2`, the verdicts are read from the
store, as `get_run`'s [`replay`](run-detail.md#replay) gives them, and pruning its
report changes nothing. Only a replay stored before reads its report, and only it
can raise a `replay_report_*` reason. With any of the five, every change but a
`new` one is `inconclusive`: without the replay's verdicts, nothing can be ruled
resolved or persisted.

**Per endpoint.** A run exercised an endpoint when it reached the wire for it and
did not leave it unprobed, an endpoint reached by a transition included. A defect
the `after` run lacks, on an endpoint it did not exercise, is `inconclusive`, never
`possibly_resolved`. Every other `after` or `pair` reason makes any defect the
`after` run lacks `inconclusive`; `scope_differs` does not: a defect on an endpoint
the `after` run exercised is ruled as usual, and a `new` one on an endpoint the
`before` run did not exercise stays `new`. Scope is kept per method and path, not
per identity: an endpoint exercised under one identity counts as exercised for a
defect recorded under another ([ADR-195](../adr/core.md#adr-195)).

**Against a replay**, a defect meets the replay's `defect_verdicts` with its own
identity: method, path, invariant, status and, for `access_control`, the identity
that sent it. It is `persisted` when one of them is `present`, and its
`after_count` is how many of them are: the recorded defects with that identity the
replay saw present, counted the way `before_count` counts them. It is
`possibly_resolved` only when every one of them is, and `inconclusive` otherwise.
A `present` verdict is keyed on where the request was recorded, not on its
invariant: a defect never reads resolved by mistake, but it can read present
because another invariant at the same place still breaks. A defect the replay
ruled `inconclusive` for want of a witness, or for refused credentials, is
`inconclusive` here too ([Replay verdicts](#replay-verdicts)).

## Operation status { #operation-status }

How an operation ended: the reply's `status` and the `finished` event's.

| Value | Meaning |
| --- | --- |
| `completed` | The operation ran to its end. |
| `cancelled` | The client asked the operation to stop. |
| `failed` | The operation could not finish. |
| `safety_breached` | Requests reached a route the safety guard held back. |

`run_pipeline`'s own status ranks its stages: a safety breach outranks a stop
request, which outranks a failure; otherwise it is `completed`.

## Stage status { #stage-status }

How one stage of `run_pipeline` ended: the `status` of a `stage_finished` event
and of each entry in the reply's stage list.

| Value | Meaning |
| --- | --- |
| `completed` | The stage ran to its end. |
| `failed` | The stage could not finish. |
| `skipped` | The stage had nothing to do in this pipeline and did not run. |
| `stopped` | The stage stopped at the client's request. |

The execution stage reads the run's own outcome: a run that breached the safety
guard ends the stage `failed`, a cancelled one `stopped`.
