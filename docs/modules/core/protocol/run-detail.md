# Run detail

`get_run` reads a stored run back: its `run`, `metrics`, `endpoints`, `findings`
(paged with `limit`), `producer_exclusions` and, for a replay, what the replay
concluded. Most of it is the report document's own shape. This page explains the
facts a client has to read with care: what each finding counter counts, which
findings are LLM suspicions and where each finding's rule comes from, what
request an unconfirmed finding was observed on, how an
endpoint's budget was spent per phase and what a producer's contract added, what
a stored replay ruled, and whether a finding can be replayed alone. The closed values these fields take are on
[Result vocabularies](vocabularies.md).

## The finding counters { #metrics }

Every `findings_*` count in `metrics` is the engine's own, fixed when the run is
stored, and the same in `get_run` and the report document. Most of them count
**occurrences**, not defects: one defect seen on twenty requests that shrinking
could not reproduce is twenty `findings_flaky`. `unconfirmed_unique` counts the
same unconfirmed findings as **defects**, each once; it is counted when `get_run`
reads the run, and only `get_run` answers it.

| Field | What it counts |
| --- | --- |
| `total_requests` | Requests sent while exploring; those of the shrink are not among them. |
| `findings_raw` | Violations seen while exploring: a response that breaks two rules counts twice. In a stateful run, each confirmed report once, plus every occurrence of its refuted, unverified and flaky findings. |
| `findings_confirmed` | Shrunk representatives that reproduced, a second cause included, before deduplication. Where a runner does not shrink (`resilience`, `auth`, and the latency findings and crashes of `performance`), each distinct defect observed. |
| `findings_unique` | Confirmed reports after deduplication: as many as the report document's `defects`. |
| `findings_llm_suspicions` | Reports that reproduced like a confirmed one against a rule only the model assumed, after deduplication: as many as the report document's `llm_suspicions`, never in `findings_confirmed` nor `findings_unique` ([below](#llm-suspicions)). Also on each entry of `endpoints`, whose entries add up to it, and on a run's row in `list_runs`. |
| `findings_llm_suspicions_covered` | The suspicions a confirmed defect of the run already covers: the entries of `llm_suspicions` whose [`covered_by`](#covered-suspicions) is not `null`. Counted when the report is built or `get_run` reads the run, never stored; always `0` in a replay. Not on a run's row in `list_runs`. |
| `findings_collapsed` | Occurrences left unshrunk because a faithful representative of their signature stands for them. |
| `findings_flaky` | Occurrences shrinking tried and could not reproduce a second time: not findings, and not distinct defects. |
| `findings_unverified` | Occurrences never tried (the run ended first, or the search had no candidate) or whose control request could not judge them; in a stateful run, what the step controls left unjudged; in `auth`, every finding only a contract can judge. |
| `findings_refuted` | Occurrences whose minimal request reproduced while its control request showed the same signal, so the input was not the cause; `0` where no control is sent. |
| `requests_shrink` | Requests sent while shrinking, and while `resilience` confirms its server errors; each entry of `endpoints` carries its share, and the entries add up to it ([below](#requests-shrink)). |
| `stateful_chains` | Producer chains a `stateful` consumer sent inside its step that put at least one request on the wire, the shrink's not counted; `null` outside a `stateful` run. |
| `contract_items` | Every endpoint's [`contract_usage.summary`](#contract-usage) summed, in the same shape; `null` when no endpoint's contract (the spec's, plus a producer's when there is one) gave the run anything. |
| `unconfirmed_unique` | The run's unconfirmed defects, each counted once: `total`, `flaky`, `unverified` and `refuted`. |

```json
"metrics": {"total_requests": 412, "findings_raw": 9, "findings_confirmed": 2,
            "findings_unique": 1, "findings_collapsed": 1, "findings_flaky": 4,
            "findings_unverified": 2, "findings_refuted": 0, "requests_shrink": 37,
            "unconfirmed_unique": {"total": 2, "flaky": 1, "unverified": 1, "refuted": 0}}
```

**What makes one defect.** Two unconfirmed findings are one defect when they share
the method, the path, the invariant and the status (a request no response answered
counts with the status its finding records) and, only when the invariant is about
who sent the request, the identity. That is the identity
[`compare_runs`](vocabularies.md#caveats) pairs defects by. The phase, the
response's shape, the reproducer and the rule do not split a defect: the same `500`
under two identities is one, and so are two semantic rules broken on one endpoint
with one status.

- **Over the whole run.** `unconfirmed_unique` counts every finding of the run,
  whatever page of `findings` was asked for.
- **Never twice.** A defect the run also confirmed is not counted: no defect is both
  among the confirmed findings and here.
- **Per state, at least once.** Each state counts the defects with at least one
  finding in it. A defect flaky in one phase and refuted in another counts in both,
  so `flaky`, `unverified` and `refuted` may add up to more than `total`.

A client that says "N unconfirmed defects" reads `unconfirmed_unique.total`. The
three occurrence counters size the funnel; they are not a number of findings to
show. `metrics` is `null` for a run that recorded none, and then there is no
`unconfirmed_unique` either.

## LLM suspicions { #llm-suspicions }

A finding that reproduced against a rule only the model assumed is an **LLM
suspicion**, not a defect ([ADR-202](../../specforge-engine/adr/findings.md#adr-202)).
It went through the same shrink, re-send and control as a confirmed finding; what
differs is the standing of its rule: nothing the model was shown states it.

| Where | What it says |
| --- | --- |
| Report document | `llm_suspicions`, each entry shaped like one of `defects`; `defects` never holds one |
| `metrics`, `endpoints[]`, a run's row | `findings_llm_suspicions`, never in `findings_confirmed` nor `findings_unique`; `metrics.findings_llm_suspicions_covered`, how many a defect covers |
| `get_run`, `get_finding` | A finding of `kind` and `state` `llm_suspicion`, with a crash's fields |
| `finding` event | `state` `llm_suspicion` ([events](events.md#the-event-catalog)) |
| `compare_runs` | `llm_suspicion_changes`, shaped like `changes`; `changes` and `totals` count defects only. A finding that is a defect in one run and a suspicion in the other is `inconclusive`, once, in `changes`, with the caveat [`grounds_changed`](vocabularies.md#caveats) |

A suspicion never changes the signal: a run whose only findings are suspicions is
`clean`. A replay judges no suspicion, so against a replay every one that is not
`new` is `inconclusive`. A client shows suspicions apart from defects, each with
its rule's [grounds](#grounds), so a reader decides whether the API should hold
that rule.

### A suspicion a defect already covers { #covered-suspicions }

A suspicion often restates a defect the run confirmed: the same request, or the
same field broken under a rule the model assumed beside one the code states.
Each suspicion says so in `covered_by`, in the report document's `llm_suspicions`
and on a finding of `get_run` and `get_finding` of `kind` `llm_suspicion`:

| Field | Holds |
| --- | --- |
| `invariant_violated`, `rule_id`, `status_code` | The covering defect's |
| `finding_id` | The covering defect's id; only in `get_run` and `get_finding` |

`covered_by` is `null` when no defect covers the suspicion. A confirmed defect of
the same run on the same endpoint (method and path) covers it when:

1. **It sent the same request**: its `minimal_payload` equals the suspicion's.
2. **Otherwise, both are about the same field.** A finding is about the
   `<zone>.<field>` (zone `path`, `query`, `header` or `body`) its `rule_id`
   names, such as `query.q`; else the one its request poisoned
   (`request.poisoned_zone` and `request.poisoned_field`); else the only field its
   `minimal_payload` sets, when it sets exactly one and that one is not a path
   parameter. Otherwise it is about no field, and only the same request covers
   it: two findings sharing a resource's id are not the same problem, nor is a
   field a request merely carries.

A defect of category `contract_hygiene` never covers a suspicion: a gap in the
specification says nothing of what the suspicion expects. Among several
covering defects, the most severe covers it, and at the same severity the first
in the order of `defects`.

The cover is derived when the report is built or the run is read, so a run
stored before protocol `0.2.6` has it too. It hides nothing: every suspicion
stays in `llm_suspicions` and in `findings`, with its reproducer, and
`findings_llm_suspicions` still counts them all. The HTML report folds the
covered ones last in its **LLM suspicions** section, under "N more on a field a
defect already covers", each card naming its defect in a **Covered by** row
([ADR-215](../adr/core.md#adr-215)).

## Where a finding's rule comes from { #grounds }

Every entry of `defects`, `llm_suspicions` and `unconfirmed_findings`, and every
finding of `get_run` and `get_finding`, carries `grounds`: what the rule it cites
rests on. `null` for a rule no producer grounded: one the specification declares,
an intrinsic invariant, or a contract inferred without grounds.

| Field | Holds |
| --- | --- |
| `basis` | `stated` (the code, the operation or the author states the rule) or `assumed` (the model assumed it from what the field means) |
| `quote` | The text the model quoted for it; `null` for a rule it called assumed |
| `downgraded` | Why a rule the model called stated is taken as `assumed`: `no_quote` (it quoted nothing), `quote_not_found` (the quote is not in what the model was shown) or `quote_unrelated` (a keyword's quote names neither its field, in the quote or in the function or spec pointer it was found in, nor its value); `null` otherwise. A business rule, an access policy and a seed case are never `quote_unrelated` |
| `origin` | Where the quote, or the rule, is written: `{kind: "code", file, function, start_line, end_line}` (lines counted from 1, `file` relative to the analysis' tree), `{kind: "spec", pointer}` (a JSON Pointer into the operation the model was shown), `{kind: "fixture", file, pointer}`, or `null` |

`inspect_finding_source` answers `rule_source` (`{file, function, start_line,
end_line}`) when `origin.kind` is `code`, so a client opens the file at the rule in
one call ([inspect_finding_source](replay-and-fixes.md#inspect-finding-source)). How
a quote is checked is on [ADR-201](../adr/inference.md#adr-201).

A finding's `request` also says where its payload came from: `origin` is `drawn`
(a strategy's draw), `witness` (a value only an inferred rule forbids) or `seeded`
(a value the contract offers, sent as given), and `seed_case_id` and
`seed_case_description` name the seed case it was sent for, both `null` when none.
A finding stored before protocol `0.2.6` reads all three `null`.

## The request an unconfirmed finding was observed on { #observed-request }

A `flaky`, `unverified` or `refuted` finding has no reproducer: nothing shrank it,
so it has no `minimal_payload` nor `sanitized_headers`. It shows instead the
request it was observed on, in each entry of the report document's
`unconfirmed_findings` and on a finding of `get_run` and `get_finding` of `kind`
`unconfirmed`:

| Field | Holds |
| --- | --- |
| `observed_payload` | What the first request of the finding's group sent, by zone (`path`, `query`, `header`, `body`), as a crash's `minimal_payload` is keyed |
| `observed_headers` | The headers that request carried, as a crash's `sanitized_headers` |

Both are redacted exactly as a crash's reproducer is: credential headers, the
fields the analysis's contract declares sensitive and the built-in secret names
read `***`, and a credential the request sent is scrubbed wherever either carries
it. Neither is cut for size, and neither is minimal: it is the request as it was
sent. Both are `null` together for a finding stored before protocol `0.2.6`. A
crash and an LLM suspicion carry neither, since their reproducer says what they
sent. The HTML report folds both into the **Request sent** cell of the
unconfirmed findings table.

## Requests refused their credentials { #requests-refused }

**`endpoints[].requests_refused`** counts the endpoint's `requests` answered `401`
or `403`, in `get_run` and the report document's `endpoints`; it is never more
than `requests`. Only an endpoint that requires authentication (its OpenAPI security, or an access policy that is not `public`) counts them: a public endpoint's `401` or `403`, such as a login answering a wrong password, answers what the request sent, not who sent it, and never counts. A replay, which knows no endpoint's security, counts every `401` and `403`; it has no signal. When it is above `0` and equals the requests that got a
response (`requests` less its `availability`, `timeout` and `unsendable_request` ones in
`by_category`), the run's `signal_causes` carry
[`credentials_refused`](vocabularies.md#signal-causes): the credentials opened
nothing at that targeted endpoint, so the run verified nothing behind its
access check. An `auth` run counts its refusals too but never raises the cause,
since it sends identities the access policy should refuse. `null` for a run
stored before it was kept, which never raises the cause.

## Shrink requests and stateful values { #requests-shrink }

**`endpoints[].requests_shrink`** counts the requests shrinking or confirming a
finding sent to the endpoint; they are not in its `requests`, `by_phase` nor
`by_category`, and never change the signal. A `stateful` sequence counts each
request at the endpoint it went to: a producer the shrink re-sent counts there,
not at the consumer whose finding it confirmed. An entry with `requests` `0`,
`requests_shrink` above `0` and a finding was reached while confirming that
finding, not left unprobed.

### Where a stateful consumer found its values { #consumer-values }

`endpoints[].consumer_values` says, in a `stateful` run, where the endpoint's rule
found the values it consumes, one count per draw: `pool` (its own sequence had
produced them), `chain` (a producer chain sent inside the step returned them) and
`unsent` (the draws that found none, keyed by
[`unprobed_reason`](vocabularies.md#unprobed-reason)). `null` outside a `stateful`
run, for an endpoint that consumes nothing or was never drawn, and for a run
stored before it was kept.

```json
"consumer_values": {"pool": 41, "chain": 12, "unsent": {"link_value_never_produced": 3}}
```
## Budget per phase { #budget-by-phase }

Each entry of `endpoints` carries `budget_by_phase`: the examples each planned phase
got at that endpoint, in `get_run` and the report document. It is `{}` in a mode
that does not plan by phase.

| Field | What it holds |
| --- | --- |
| `planned` | The examples the strategy planned for the phase at this endpoint, every identity's share summed; the same with or without a producer. |
| `extra` | The examples a producer's contract added on top of `planned` in the phase: the items it sends as given and the draws it funds; `0` without one. |
| `extra_run` | The examples `extra` paid for that ran; `by_phase` counts them too, so the strategy's share ran `by_phase` minus `extra_run`. |
| `carried_in` | The examples an earlier phase of the same identity left unspent and this phase received. |
| `starved` | The declared identities this phase's share left with zero examples, sorted; `[]` when it funded every one. |

```json
{"method": "PUT", "path": "/articles/{slug}", "starved_identities": ["bob"],
 "budget_by_phase": {
   "valid":    {"planned": 5, "extra": 4, "extra_run": 4, "carried_in": 0, "starved": []},
   "attack":   {"planned": 3, "extra": 0, "extra_run": 0, "carried_in": 0, "starved": []},
   "mutation": {"planned": 1, "extra": 0, "extra_run": 0, "carried_in": 0, "starved": ["bob"]}}}
```

An endpoint's `examples_planned` is every phase's `planned` and `extra` summed, so
a run with a producer plans more than `examples_per_endpoint` times its phases.
What a contract adds, and why it is kept apart, is on
[ADR-204](../../specforge-engine/adr/measurement.md#adr-204). A run stored before
`extra` and `extra_run` were recorded reads both back `0`.

A phase whose share is smaller than the number of identities funds some and
starves the rest. Above, `mutation` has one example for two identities: `alice`
gets it, `bob` gets none in that phase, and `bob` still has his examples, and may
have findings, in `valid` and `attack`. A phase planned with zero examples is
listed, `planned` `0`, when the run declares identities, with every one of them in
`starved`. A run stored before report `1.26` reads back `starved` `[]` in every
phase.

**`starved_identities` is the union of the phases' `starved`.** It names an
identity left with zero examples in **at least one** phase, not an identity the
endpoint never sent anything for. To say where an identity was left out, read the
phases: "bob got no examples in `mutation`", never "bob was left out of
`PUT /articles/{slug}`".

## What the producer gave { #contract-usage }

**`run.producer`**, in the report document, `list_runs` and `get_run`, names the
producer that gave the run its contracts: `none`, `fixture` or `inference`. `null`
for a replay, which runs no producer.

**`endpoints[].contract_usage`** is the account of what the endpoint's contract gave
it, item by item, and what the run did with each
([ADR-204](../../specforge-engine/adr/measurement.md#adr-204)). The contract is the
spec's own (its `default` and `examples` values as field seeds, its `links` as
transitions) plus, when the run has one, a producer's: a run without a producer still
accounts for what the spec gave, with `grounds` `null` on every item. `null` when
nothing gave the endpoint an item, and for a run stored before it was kept. None of it enters `requests`, the coverage or the signal.

| Field | Holds |
| --- | --- |
| `fixed_cap` | The cap on the items the endpoint sends as given, in modes that send them; `null` elsewhere |
| `dropped_before_run` | The items the producer lost before the run, by `kind`: one per `producer_notes[]` entry that loses an item. A rule lost counts once, as `rule_case` |
| `items[]` | Each item: `kind`, `subject` and `detail` name it (a rule case's rule id and side, a keyword's field and keyword, a field seed's field and position, a transition's follow-up); `grounds` (`{basis, downgraded}`, `null` for an item no rule grounds); `sends`, `identities` and `phases` say how it was sent; `judged_against_expects` and `unjudged_because` for a seed case; `unexercised`, `null` when exercised, else `{reason, detail}` |
| `summary` | `{given, dropped_before_run, exercised, unexercised}`; `given` is always `dropped_before_run` + `exercised` + every count of `unexercised`, keyed by reason |

An item is exercised when at least one of its requests got an answer that did not
refuse the credentials (`401`, `403`), or, for a response rule, when a response
decided it. The values are on Result vocabularies: the
[item kinds](vocabularies.md#contract-item-kind), the
[unexercised reasons](vocabularies.md#unexercised-reason) in their order of
precedence, and [why a seed case went unjudged](vocabularies.md#unjudged-reason).

```json
"contract_usage": {"fixed_cap": 100,
  "dropped_before_run": {"rule_case": 1},
  "items": [
    {"kind": "seed_case", "subject": "discount-above-subtotal", "detail": null,
     "grounds": {"basis": "stated", "downgraded": null}, "sends": 2,
     "identities": ["alice", "bob"], "phases": ["valid"],
     "judged_against_expects": true, "unjudged_because": null, "unexercised": null},
    {"kind": "inferred_keyword", "subject": "body.quantity", "detail": "minimum",
     "grounds": {"basis": "assumed", "downgraded": null}, "sends": 0,
     "identities": [], "phases": [], "judged_against_expects": null,
     "unjudged_because": null,
     "unexercised": {"reason": "witness_not_found", "detail": "…"}}],
  "summary": {"given": 3, "dropped_before_run": 1, "exercised": 1,
              "unexercised": {"witness_not_found": 1}}}
```

### What the producer lost { #producer-notes }

`producer_notes`, in the report document and `get_run`, lists what the producer lost or had to retry on each endpoint, `{method, path,
kind, subject, detail, from_cache}`, in the order it was noted; `[]` when it lost
nothing or the run had no producer. The kinds are on
[Result vocabularies](vocabularies.md#producer-note-kind). A rule the model called
stated and could not back is noted `unverified_quote` and stays in the contract, as
assumed.

## Recurring findings { #recurring-findings }

`recurring_findings`, in the report document and `get_run`, groups the findings
that show one symptom on two endpoints or more: the same invariant, `rule_id`,
status and `observation.observed`. Each group is `{invariant_violated, rule_id,
status_code, observed, endpoints}`, `endpoints` each `{method, path}` once, plus
`finding_ids` in `get_run`. Only `undeclared_response_field` is grouped, whose rule
and observation prove the symptom is the same, such as one error body several
routes of a framework share. A group says the symptom is the same, never that the
cause is. It is derived: every finding stays in its list and no count changes.
`[]` when nothing recurs.
## A stored replay's verdicts { #replay }

A [`replay`](vocabularies.md#replay-verdicts) rules each defect the recorded run
confirmed. Its run keeps those verdicts in the store, so they read back after the
`replay` answer is gone and whatever retention did to its report.

`get_run` carries them in `replay`: `null` for a run that is no replay, for a
replay stored by a core older than protocol `0.2.2`, whose verdicts were kept only
in its report, and for a replay whose stored verdicts are fewer than the count
stored with them: part of them is never published.

| Field | What it holds |
| --- | --- |
| `judged` | The same object as the `replay` answer's `replay.judged`: `oracle_scope` (as [`run.oracle_scope`](vocabularies.md#oracle-scope)), `recorded_defects`, `present`, `possibly_resolved` and `inconclusive`. `recorded_defects` counts the recorded run's confirmed findings, one per phase a defect was confirmed in, not distinct defects. |
| `defect_verdicts` | One per confirmed finding of the recorded run, in the order the `replay` answer gave them: `finding_id` (the confirmed finding it rules on, an integer), `method`, `path`, `status_code`, `invariant_violated`, `rule_id` and `identity_label` as that finding was stored, and `verdict` (`present`, `possibly_resolved` or `inconclusive`). |

```json
"replay": {
  "judged": {"oracle_scope": "contract_free", "recorded_defects": 3, "present": 2,
             "possibly_resolved": 1, "inconclusive": 0},
  "defect_verdicts": [
    {"finding_id": 41, "method": "POST", "path": "/articles", "status_code": 500,
     "invariant_violated": "not_a_server_error", "rule_id": null, "identity_label": null,
     "verdict": "present"}]}
```

The `replay` answer and the report document's `replay.defect_verdicts` carry
`finding_id` too, so a client links each verdict to the finding it can open with
`get_finding`. In the report document it is optional: a report written before
`1.26` has none. A replay of a run that confirmed nothing has `defect_verdicts` `[]`
and every count of `judged` `0`; a replay whose verdicts are unknown is `null`,
never "zero of zero".

**`run.judged`**, in each row of `list_runs` and in `get_run`'s `run`, is the same
`judged`, and `null` whenever `replay` is. A replay's own `findings_unique` is
always `0`, since a replay records verdicts, not findings: a list of runs shows a
replay's row by its `judged` ("2 present, 1 possibly resolved"), and a `null` there
as verdicts unknown.

`compare_runs` against a replay reads these stored verdicts, so pruning the
replay's report changes nothing. Only a replay whose `replay` is `null` (stored
before `0.2.2`, or with incomplete stored verdicts) still reads its report, and only
it can raise a `replay_report_*` [caveat](vocabularies.md#caveats).

## Replaying a finding alone { #replay-alone }

Every finding, confirmed or not, carries `replay_alone` in `get_run` and
`get_finding`: whether [`replay_finding`](replay-and-fixes.md#replay-finding), and
so `verify_finding_fix`, can send its request alone.

```json
"replay_alone": {"possible": false, "reason": "not_in_trace"}
```

`reason` is `null` when `possible` is `true`; otherwise it is the
[reason](vocabularies.md#replay-alone-reason) `replay_finding` would refuse the
finding with, `REPLAY_NOT_REPRODUCIBLE`, whose `data.reason` carries the same value.
The reasons are checked in their listed order, and the first that holds is the one
given, so it names the same reason the error would. Every finding of a `stateful`
analysis is `stateful`, confirmed or not, unless it kept the steps of its minimal
sequence: a confirmed finding stored from protocol `0.2.6` on whose every step
reached the wire. That one reads `possible: true`, and its replay sends its steps
before it ([stateful findings](finding-replay.md#stateful)); whether the trace
holds its request then means whether the trace holds each of its steps where the
run sent it. Whether the trace holds the finding's request is decided when the run is stored, against the trace as it is stored, and
kept with the version of the matcher that decided it. Storing a run whose trace
does not read back from its own bytes fails, rather than keep a run no replay could
read; a `flaky` or `unverified` finding,
which has no minimal payload, is looked up as its replay sends it: the first
recorded request that broke an invariant at its endpoint, in its phase, under its
identity and with its status.

`replay_alone` is `null` for a finding that nothing else refuses and that was
stored before protocol `0.2.2`, or by a core whose matcher had another version:
whether its request is in the trace is not known until it is replayed. `stateful`, `refuted` and `trace_pruned` are still given for it.

!!! note "`possible: true` is not a promise"
    `replay_alone` does not cover what depends on the replay call itself or on the
    live secrets. A finding it calls replayable can still be refused for the
    consent its analysis's recording needs (`SIDE_EFFECTS_CONSENT_REQUIRED`), for a
    missing identity or credential, a stripped URL userinfo or another host
    (`REPLAY_NOT_REPRODUCIBLE`), and when the trace's file is missing or fails its
    integrity check. A client disables "replay alone" on `possible: false`, and
    still handles those errors when it is pressed.
