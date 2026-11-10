# Handshake and versioning

`hello` is the first request of every session. Any other operation before it is
refused `HANDSHAKE_REQUIRED`.

```json
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol_version":"0.2.6","locale":"es-AR"}}
```

The response carries the protocol version, the locale the session is served in,
the server's identity, what this build can do, the whole operation catalog, the
vocabulary findings are reported in, and the options a run can be asked for:

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocol_version":"0.2.6",
  "locale":"es",
  "server":{"name":"specforge-core","version":"…","frozen":false},
  "capabilities":{…},
  "catalog":{…},
  "vocabulary":{…},
  "fuzz_options":{…}
}}
```

## Capabilities

| Field | Type | Declares |
| --- | --- | --- |
| `events` | bool | The core emits progress notifications |
| `event_kinds` | list of strings | The `kind`s **this build actually emits** — where `infra_failure` and `target_down` show up or not, depending on the engine |
| `cancellation` | bool | The core honors `$/cancelRequest` |
| `max_in_flight` | int or null | Concurrent operations allowed: the size of the core's worker pool, `8`. A ninth request waits in the queue until a worker frees, and a `$/cancelRequest` reaches it there. `null` would mean no ceiling |
| `payload` | object | `inline_max_bytes`, `file_handoff` (bool), `pagination` (bool) |

The whole handshake is **derived, not declared**: `event_kinds` is exactly what
the build's operations emit, `cancellation` is true when any operation reads a
cancellation token, the catalog is the same one `describe` publishes, the
vocabulary is read from the engine's registry, and the fuzz options are derived
from the engine's strategy profiles and runner traits.

## Vocabulary { #vocabulary }

`vocabulary` lists every closed vocabulary a finding is reported in, each value
with the label a frontend shows for it, so a client renders findings without a
table of its own. `describe` carries the same object beside `catalog`. The schema
lists it among the result's required fields.

| Key | Items | What it lists |
| --- | --- | --- |
| `categories` | `{value, label, summary}` | Every [`category`](vocabularies.md#category), in the engine's declaration order; `summary` is the kind of defect it holds. Plain strings to a client that asked for a version before `0.2.5` |
| `severities` | `{value, label, summary}` | Every [`severity`](vocabularies.md#severity), most severe first; `summary` is the defects it holds. Plain strings to a client that asked for a version before `0.2.5` |
| `invariants` | `{value, label, category, severity, rule_source, description, summary}` | Every invariant the engine checks, in registry order, the order that breaks ties within one severity. `rule_source` is `intrinsic` (the invariant states its rule, which `description` carries) or `declared` (the contract states it; `description` is `null`). `summary` is one sentence for a person on what a finding of it means, never `null` |
| `truncation_reasons` | `{value, label}` | Every [`truncation.reason`](vocabularies.md#truncation-reason) |
| `target_down_verdicts` | `{value, label}` | Every [`target_down_verdict`](vocabularies.md#target-down-verdict) |
| `finding_states` | `{value, label}` | Every state a finding is reported in: `confirmed`, `flaky`, `unverified`, `refuted` |
| `unprobed_reasons` | `{value, label}` | Every [`unprobed_reason`](vocabularies.md#unprobed-reason) |
| `hold_reasons` | `{value, label}` | Every value of `held_back_by` |
| `exclusion_dispositions` | `{value, label}` | The core's own: every [`producer_exclusions[].disposition`](vocabularies.md#producer-exclusion-disposition), plus `aborted`, a failed contract that stopped the run |
| `contract_failure_causes` | `{value, label}` | The core's own: every [contract failure cause](vocabularies.md#contract-failure-cause), the `cause` of `contract_failed` and `producer_exclusions[]` and the `data.cause` of `CONTRACT_PRODUCER_FAILED`, in declaration order |
| `signal_causes` | `{value, label}` | The core's own: every [`run.signal_causes`](vocabularies.md#signal-causes) value, in the order they render, each with a label short enough for a verdict line |
| `attack_families` | `{value, label, summary}` | Every [attack family](vocabularies.md#attack-family) a request's `attack_family` or a strategy's `attack_families` names, in declaration order, with a one-sentence `summary` of the payloads it sends |
| `oracle_needs` | `{value, label}` | Every [`oracle_need`](vocabularies.md#oracle-need), in declaration order: what a response must come with before an invariant can be judged on it |

Every list but `exclusion_dispositions`, `contract_failure_causes` and
`signal_causes` comes from the engine
([ADR-148](../../specforge-engine/adr/findings.md#adr-148)). Without the engine
the object is present with those lists empty, never missing.

## Fuzz options { #fuzz-options }

`fuzz_options` lists the execution modes and their runner variants, the
strategies, the producers, what each strategy changes against `default` in each
variant under each producer, what each variant can find and who meets what it
needs, and the presets a client chains, each term with its label and summary.
`describe` carries the same object, and the schema requires it in `hello`. Its
keys, the effects matrix and how it is derived are on
[Fuzz options](fuzz-options.md).

## Session locale { #session-locale }

`hello.params.locale` is optional: a [BCP 47](https://www.rfc-editor.org/info/bcp47)
tag naming the language the client would like the core's texts in; `null` is
the same as leaving it out. The core reads only its primary subtag, case aside,
up to a `-` or a POSIX `_` (`es-AR`, `es_AR` as `LANG` writes it, `es` and `ES`
all ask for `es`), and serves it when it is one of its locales: `en` or `es`. Any
other tag, or none, is served as `en`; an unknown language is not an error, since
there is nothing for the client to correct. A `locale` that is neither a string
nor `null` is refused `INVALID_PARAMS` with `data.parameter` `locale`
([errors](errors.md#protocol-level-codes)).

`result.locale` is always present, `"en"` or `"es"`, whether or not the client
asked for one, and whatever version it negotiated. It is the locale every text
the core writes for what is sent after this `hello` comes in; a client shows it
rather than assuming the one it asked for.

**Changing language is a second `hello`.** It negotiates the version and the
locale again for every request sent after it. An operation already running keeps
the session it started with: a run started in `en` emits its events and returns
its document in `en` even if the client switches to `es` meanwhile. A `hello`
that is refused, for its version or its `locale`, leaves the session as it was:
the version and the locale negotiated before still hold.

**What arrives in the session's locale and what stays English.** The rule is that
a text written for a person is translated, and a text that is data, a record, or
the technical detail beside a code is not. Codes, ids and enum values are never
translated: a client branches on them in any locale
([codes and English detail](errors.md#codes-and-detail)).

| Arrives in the session's locale | Stays English |
| --- | --- |
| Every label and summary of [`vocabulary`](#vocabulary) and [`fuzz_options`](#fuzz-options), presets included, in `hello` and `describe` | Every error's `message` and the prose in its `data` (`reason`, `detail`) |
| Each option's `help` in `get_config`, `set_config` and `reset_config` | `diagnose`'s `name`, `category`, `detail` and remedies, and a model list's `fallback_reason` |
| A finding's `summary` in `get_run`, `get_finding`, the live `finding` event, and the run document `fuzz` and `run_pipeline` return | The `reason` of `contract_failed` and of `producer_exclusions[]` |
| A template explanation (`source` `template`) in `explain_finding` and `get_finding`, written from the finding's evidence when it is read | Everything the LLM writes: a model explanation and its fix, and the rules it infers; a rule the contract declares, and an access-control rule |
| The `description` of a rule the engine writes: `vocabulary.invariants[].description`, and a finding's `rule_description` in `get_run`, `get_finding` and the run document `fuzz` and `run_pipeline` return | A stored `rule_description` that no longer reads as the engine wrote it (its sent values scrubbed, for instance): it is returned as stored |
| | The stored artifacts `report_json` and `report_html`, and the text of every `replay` result |
| | `describe`'s `catalog` (each operation's `summary`, `description` and parameter `help`), `events` and `error_codes` |

The names of the product, its modes and its strategies stay as they are in every
locale, as labels too. What is stored never changes language: a run's artifacts
and a cached template explanation are kept in English, so one run reads the same
whichever client ran it, and a session in `es` gets its Spanish texts built when
it reads them.

## Versioning { #versioning }

**The core serves a range within its own series.** A client is served when its
`protocol_version` has the core's `major.minor` and a patch between a declared
floor and the core's own. Each part compares as a number, never as text:
`0.1.10` is newer than `0.1.9`. This core speaks `0.2.6` and serves `0.2.0`
up to `0.2.6`: no `0.1.x` client is served. It always answers `hello` with its
own version, and a frontend ignores the keys it does not know.

Anything else — another series, a patch outside the range, or a
`protocol_version` that is not `major.minor.patch` — is refused
`PROTOCOL_VERSION_MISMATCH`. Its `data` carries `expected` (the core's version),
`oldest` (the floor) and `received` (what the client sent); its message names
the range served. The frontend aborts.

**How a version moves.** An additive change — a new operation, an optional
parameter, a result field, an event kind, an error code — bumps the patch. A
breaking change — a rename, a removal, a type change, a parameter made required
— bumps the minor.

**Why there is a floor.** A patch that breaks inside a series raises the floor
to itself, so no client older than it is handed keys it cannot read; `0.1.5`
did that inside the `0.1` series. When the minor moves, the floor returns to
`.0`: the `0.2` series starts at `0.2.0` with the floor there
([ADR-094](../adr/protocol.md#adr-094), [ADR-189](../adr/protocol.md#adr-189)).

## Lifecycle { #lifecycle }

The frontend launches the core, does the handshake, works, and on exit sends
`shutdown` and waits for its answer.

- **`shutdown` drains.** The core cancels every operation still running — each
  answers on its own, exactly as after a
  [`$/cancelRequest`](events.md#cancellation) — waits for them to settle, then
  answers `{"ok": true}` last and exits without reading another line. The answer
  is the signal that the pipe can be dropped.
- **EOF cancels the same way.** If the frontend dies without warning, or closes
  stdin right after its last request, the core detects **EOF on stdin**,
  cancels what is still running, waits, and exits on its own. A script piped
  into the core keeps stdin open until its answers have arrived; closing it
  early cancels what has not finished.
- **What cannot be cancelled runs to its end.** An operation whose catalog
  entry says `cancellable: false` (`load_contract`, `diagnose`, `get_run`,
  `apply_fix_plan`, …) still running at that point completes before `ok`
  arrives.

`hello` and `shutdown` are requests like any other — each carries an `id` and
gets its own response — but neither is a catalog operation, so `describe` lists
neither. See [ADR-095](../adr/protocol.md#adr-095).

## Changelog

The report document that `fuzz`, `replay` and `run_pipeline` answer with is
`schema_version` 1.28. The protocol's own README holds the full entry for each
version; the lines below are the summary.

- **0.2.6** — Where a client read English prose to tell one case from another,
  the core sends a stable code beside it: why a contract producer failed, why a
  repository cannot be traced, why a provider's model list fell back to the
  catalog, which requirement each `diagnose` check probes, and which parameter an
  overwrite refusal is about. The English text beside each code (`reason`,
  `detail`, `fallback_reason`, `message`) stays, as technical detail that may
  change; a client branches on the code
  ([codes and English detail](errors.md#codes-and-detail)). And the core speaks
  the language the client asks for in `hello`, English or Spanish
  ([session locale](#session-locale)).
  **Additive**: every new field goes to a client of any version; this core serves
  `0.2.0` up to `0.2.6`. It ships with report `1.28`.
    - *Added:* `locale` in `hello`'s params, optional, a BCP 47 tag or `null`;
      its primary subtag, before a `-` or a `_`, picks `en` or `es`, and anything
      else is served as `en`. One that is neither a string nor `null` is refused
      `INVALID_PARAMS` with `data.parameter` `locale`.
    - *Added:* `locale` in `hello`'s result, required, `"en"` or `"es"`: the
      locale the session is served in. A second `hello` changes it for what is
      sent after it; a refused one leaves it as it was.
    - *Changed:* in a session served in `es`, the labels and summaries of
      `vocabulary` and `fuzz_options`, the `help` in `get_config`, `set_config`
      and `reset_config`, a finding's
      `summary`, a template explanation and the run document `fuzz` and
      `run_pipeline` return come in Spanish. Errors, `diagnose`, what the LLM
      writes, `replay` results and the stored artifacts stay English.
    - *Added:* `cause` in the `contract_failed` event, required, one of the
      [contract failure causes](vocabularies.md#contract-failure-cause)
      ([events](events.md#the-event-catalog)).
    - *Added:* `data.cause` in `CONTRACT_PRODUCER_FAILED`, the same values but
      `unexpected`, beside `source` and `detail` ([errors](errors.md#execution)).
    - *Added:* `vocabulary.contract_failure_causes` in `hello` and `describe`:
      every cause as `{value, label}`, present with or without the engine
      ([vocabulary](#vocabulary)).
    - *Added:* `cause` in each `producer_exclusions[]` entry of `get_run` and of
      the report document, report `1.28`: the same values but `unexpected`;
      `null` for a run stored before this version.
    - *Added:* `data.cause` in `REPO_ROOT_INVALID`: `not_found` or
      `not_a_directory`, beside `repo_root` and `reason`
      ([errors](errors.md#analysis)).
    - *Added:* `fallback_cause` and `fallback_status` in each provider entry of
      `list_llm_models`, always present and `null` for a list the account
      answered ([the causes](vocabularies.md#llm-fallback-cause)).
    - *Added:* `id` and `category_id` in each check of `diagnose`, beside the
      unchanged `name` and `category` ([the codes](vocabularies.md#diagnose-check)).
    - *Added:* `data.parameter` `overwrite` in the `INVALID_PARAMS` that refuses
      to replace an existing file without `overwrite`: `generate_contract`'s
      `destination` and `init_project` over a kept `specforge.toml`
      ([errors](errors.md#overwrite-invalid-params)).

- **Report 1.28** — Additive; it ships with protocol `0.2.6`. Adds `cause` to each
  `producer_exclusions` entry, `null` in a document of a run stored before it.

- **0.2.5** — A finding's category and severity read like the other terms, with a
  label and a summary; a capped run says which model has no price before it is
  sent; a capped `generate_contract` holds every call it sends within its cap; and
  `auth` says it needs the access policies a producer declares, with each producer
  saying whether it meets that.
  **Changes the shape of two fields, kept for older clients**: this core serves
  `0.2.0` up to `0.2.5`. It ships with report `1.27`, as `0.2.4` did.
    - *Changed:* `vocabulary.categories` and `vocabulary.severities`, in `hello`
      and `describe`, list each term as `{value, label, summary}`, in the same
      order as before: a category in the engine's declaration order, a severity
      from the most severe ([category](vocabularies.md#category),
      [severity](vocabularies.md#severity)). A client that asked `hello` for a
      version before `0.2.5` still gets plain strings in both.
    - *Changed:* a variant's `requires` is read off the engine's runners, and
      `auth`'s is `["identities", "access_policies"]`. `access_policies` is a new
      value: the endpoints' access policies a producer's contracts declare,
      without which an `auth` run sends nothing. A variant's `invariants` are what
      it reports once its `requires` are met
      ([which variant a run gets](fuzz-options.md#which-variant)). `requires` is
      an open list, so a client of any version gets the new value.
    - *Changed:* a preset's `requires` is what the variant each of its runs takes
      requires, where it was what any variant of the run's mode required;
      `access-check`'s is `["identities", "access_policies"]`.
    - *Added:* `meets` in each row of `fuzz_options.producer_supplies`: the values
      of a variant's `requires` the producer's contracts can meet,
      `["access_policies"]` for `fixture` and `inference` and `[]` for `none`, so a
      client tells a requirement met without a table of its own
      ([the object](fuzz-options.md#the-object)).
    - *Changed:* a capped `fuzz`, `run_pipeline` or `generate_contract` refused
      because a model of its chain has no price is still `INVALID_PARAMS`, now
      with `data.parameter` naming the cap it was given, `producer.max_cost_usd`
      or, for `generate_contract`, `max_cost_usd`, and `data.model`, the model
      with no price ([errors](errors.md#producer-invalid-params)).
    - *Fixed:* a capped `generate_contract` with `use_llm` whose chain has a model
      with no price is refused before its route discovery is sent, rather than
      after paying for the discovery and writing the contract.
    - *Fixed:* a capped `generate_contract` with `use_llm` holds every call it
      sends against `max_cost_usd`: its two route discovery calls and its response
      calls besides the contract inferences, so a discovery that alone passes the
      cap is no longer sent. Each call is held at its estimated worst case, the
      input as sent and the output at the expected answer length. A discovery the
      cap cannot hold is refused `CONTRACT_PRODUCER_FAILED` before its next call,
      with nothing written; a response call it cannot hold is not sent, and its
      endpoint's `refinement_error` says so. A discovery one call paid for is kept
      for the next call, which does not pay for it again, even when the first was
      refused after it ([its cap](operations.md#generate-contract-cap)).
    - *Added:* `unpriced_models` (list of strings) in `estimate_inference`, and so
      in the `data.estimate` of `INFERENCE_APPROVAL_REQUIRED`: the models, primary
      or fallback, a pending inference's worst case has no price on; empty when
      every model is priced. It names the model a capped run would be refused for
      before the run is sent ([the estimate](operations.md#estimate-inference)).

- **0.2.4** — The run picker reads its words and facts from the core: what each
  mode, variant, strategy, phase and preset is, what a run can find and what
  selects a variant. An endpoint says whether it needs a login, and a finding's
  explanation and fix see where its route is registered. A run's ticks say when it
  is confirming its findings, and a base URL that names any declared server is
  sent as given. **Additive on the wire,
  with semantic changes**: this core serves `0.2.0` up to `0.2.4`. It ships with
  report `1.27`, as `0.2.3` did.
    - *Added:* `label` and `summary` on every mode, variant, strategy and preset of
      `fuzz_options`, and two lists: `fuzz_options.phases` (`{value, label,
      summary}`) and `fuzz_options.changes` (`{value, label}`). `auth` reads
      *Authorization* ([labels and summaries](fuzz-options.md#labels-and-summaries)).
      A mode's `summary` says what it sends, never what a finding means (the
      invariant's `summary`) nor what it needs (its variants' `requires`).
    - *Added:* `vocabulary.attack_families`, each attack family as `{value, label,
      summary}` ([attack families](vocabularies.md#attack-family)). `injection` and
      `sql_injection` send the same payloads, and their summaries say so alike.
    - *Added:* `vocabulary.invariants[].summary`, a sentence for a person on what a
      finding of the invariant means, for every invariant; never `null`.
      `description` keeps carrying an `intrinsic` invariant's rule, `null` for a
      `declared` one.
    - *Added:* `vocabulary.signal_causes`, each `run.signal_causes` value as
      `{value, label}`, in the order they render
      ([signal causes](vocabularies.md#signal-causes)). The core's own, like
      `exclusion_dispositions`.
    - *Added:* what a run can find: `invariants` and `invariants_when` on every
      variant, `supplies` on every strategy, `fuzz_options.producer_supplies`,
      `fuzz_options.request_supplies` and `vocabulary.oracle_needs`
      ([what a run can find](fuzz-options.md#what-a-run-can-find),
      [ADR-199](../../specforge-engine/adr/strategies.md#adr-199)). An invariant
      more than one need lets a variant report, such as `input_validation` through
      a strategy's `out_of_schema_field` or a producer's `rule_witness`, sits in a
      row for each.
    - *Added:* how a run gets a variant: `selected_by` (`null`, or `{parameter,
      when}`), `requires` and `examples_cap` on every variant; `omits_read_only` and
      `promotes_attack_hints` on every strategy; and
      `fuzz_options.limits.max_concurrency_default`, the default of the core's
      `engine.max_concurrency` option, which a project's config can change
      ([which variant a run gets](fuzz-options.md#which-variant)).
    - *Added:* four presets, `stateful-flows`, `resilience-check`, `access-check`
      and `stress-ladder`; `load` and `variant` on every preset run, and `requires`
      on every preset ([presets](fuzz-options.md#presets)). A client of `0.2.0` up
      to `0.2.3` is not offered a preset with a run that carries `load` or
      `variant`, today `stress-ladder`, which it would run as plain `flat` load.
    - *Added:* a `help` for every parameter of `fuzz`, `run_pipeline`'s run
      parameters and `estimate_inference`, nested fields included. *Changed:* the
      `help` of `examples_per_endpoint` and `allow_side_effects` says what they do:
      what the count means for a `stateful` run, and everything the safety guard
      holds back, a declared transition to an endpoint outside the run included.
      *Changed:* every parameter's `help` is one line.
    - *Added:* `requires_auth` (`true`, `false` or `null`) on each row of
      `list_endpoints` and on `get_endpoint`; the schema types both results
      ([which endpoints need a login](operations.md#requires-auth)).
    - *Changed:* `explain_finding` (with `include_code`) and `propose_fix` also send
      the model the lines where the code registers the finding's route; their
      estimates price the longer prompt, and a finding whose registration is now
      shown is explained and fixed again once
      ([the code the model sees](replay-and-fixes.md#code-shown)). The route is
      looked for under the server path the finding's request URL went to, else
      under each server the contract declares; matches under more than one show
      none.
    - *Fixed:* a `base_url` that already ends in a server path the contract
      declares, any of its `servers`, is sent as given: `http://h/v2` against
      servers `/v1` and `/v2` went to `http://h/v2/v1`. A `stateful` follow-up
      written with any declared server path in front loses it, the longest first
      ([the target base URL](operations.md#base-url)).
    - *Added:* `stage` (`generating` or `confirming`) in a `stateless` or
      `performance` run's `tick`, with `signatures_done` and `signatures_total`
      while it is `confirming`, the stretch where the run re-sends each distinct
      finding to confirm and shrink it. A tick that changes `stage` is sent
      whatever the rate limit, so `tick` is at most ten per second plus one at
      each stage change ([events](events.md#the-event-catalog)).

- **0.2.3** — An inference failure is never a quiet `clean`: the cost cap holds
  each inference's worst case, an endpoint nobody judged a write is held under
  load, and a `stateful` run's ticks say how far it went. **Additive on the
  wire**: this core serves `0.2.0` up to `0.2.3`. It ships with report `1.27`.
    - *Added:* `contracts_unproduced` in `run.signal_causes`: one or more
      endpoints of the run are in `producer_exclusions`
      ([signal causes](vocabularies.md#signal-causes)).
    - *Added:* `worst_case_cost_usd` in `estimate_inference` and in the
      `data.estimate` of `INFERENCE_APPROVAL_REQUIRED`: every re-ask and fallback
      model included, `null` when unpriced
      ([the estimate](operations.md#estimate-inference)).
    - *Changed:* `producer.max_cost_usd` holds each inference's worst case when it
      is admitted, and `exceeds_cap` judges `worst_case_cost_usd`; so does the
      estimate `generate_contract` asks approval for. A capped `fuzz` or
      `run_pipeline` whose worst case has no price is refused `INVALID_PARAMS`
      naming the unpriced model, before any inference.
    - *Changed:* a contract inference's expected `output_tokens` are measured per
      profile, and higher for the `security` and `exposure` strategies.
    - *Changed:* the safety guard holds as `assumed_write` an endpoint whose method
      is not safe and whose risk no producer declared, or that leaves
      `write_operation` out, in `performance`, `resilience` and a custom mode,
      unless `allow_side_effects`. `assumed_write` is a new value of
      `vocabulary.hold_reasons` and of `held_back_by`
      ([ADR-196](../../specforge-engine/adr/engine.md#adr-196)).
    - *Changed:* the `inference` prompt asks for the rules that tie two input
      fields, a field to a literal, or that a description declares, and reads the
      operation's `summary` and `description`. Every cached inferred contract is
      inferred again once, on its endpoint's next run.
    - *Added:* `passes` and `max_passes` in a `stateful` run's `tick`.
      *Fixed:* its `findings` rises with each `finding`
      ([events](events.md#the-event-catalog)).
    - *Fixed:* an Anthropic model's contract answered inside a fenced block is
      read. An unparsable answer is re-asked up to twice on each model, each time
      within what is left of the call's time; a provider failure after a re-ask
      moves on to the next model.
    - *Changed:* a `producer.source_repo` that is not a directory answers
      `CONTRACT_PRODUCER_FAILED` (`data.source`, `data.detail`); a missing one is
      still `INVALID_PARAMS`, now with `data.parameter`
      ([errors](errors.md#producer-invalid-params)).

- **Report 1.27** — Additive; it ships with protocol `0.2.3`, `0.2.4` and `0.2.5`. Adds
  `contracts_unproduced` to `run.signal_causes`.

- **0.2.2** — A run's detail counts its unconfirmed defects once, says in which
  phase an identity got no examples, keeps a replay's verdicts, and says ahead
  whether a finding can be replayed alone. **Additive on the wire**: this core
  serves `0.2.0` up to `0.2.2`. It ships with report `1.26`.
    - *Added:* `metrics.unconfirmed_unique` in `get_run` (`total`, `flaky`,
      `unverified`, `refuted`): the run's unconfirmed defects, each counted once by
      the identity `compare_runs` pairs defects by, leaving out a defect the run
      also confirmed. `findings_flaky`, `findings_unverified` and
      `findings_refuted` count occurrences ([The finding counters](run-detail.md#metrics)).
    - *Added:* `starved` in each phase of an endpoint's `budget_by_phase`, in
      `get_run` and the report document; a phase planned with zero examples is
      listed when the run declares identities. `starved_identities` is the union
      over the phases ([Budget per phase](run-detail.md#budget-by-phase)).
    - *Changed:* an analysis's replay rules a recorded request `possibly_resolved`
      only behind a witness, an earlier recorded success of the same identity that
      answered as recorded, and never when the replay now refuses its credentials
      (`401` or `403`). The defect recorded there is `inconclusive` with it, in
      `replay`'s `verdicts`, `defect_verdicts` and `judged`, and in `compare_runs`
      against that replay. A replay stored before keeps its verdicts
      ([Replay verdicts](vocabularies.md#replay-verdicts)).
    - *Added:* `finding_id` on each entry of a replay's `defect_verdicts`, in the
      `replay` answer, the report document and `get_run`. `judged.recorded_defects`
      counts the recorded run's confirmed findings, one per phase.
    - *Added:* `replay` in `get_run` (`judged` and `defect_verdicts`, `null` for a
      run that is no replay, for a replay stored before and for one whose stored
      verdicts are incomplete), and `run.judged` in
      `list_runs` and `get_run` ([A stored replay's verdicts](run-detail.md#replay)).
    - *Changed:* `compare_runs` against a replay reads its verdicts from the store:
      pruning its report no longer leaves every defect `inconclusive`. A replay
      stored before still reads its report and can still raise a
      `replay_report_*` caveat.
    - *Added:* `replay_alone` (`possible`, [`reason`](vocabularies.md#replay-alone-reason):
      `stateful`, `refuted`, `trace_pruned` or `not_in_trace`) on every finding, in
      `get_run` and `get_finding`. Every finding of a `stateful` analysis is
      `stateful`. It is `null` when not known ahead: stored before, or by a core
      whose trace matcher had another version. It covers neither consent nor the
      live credentials ([Replaying a finding alone](run-detail.md#replay-alone)).
    - *Added:* `data.reason` in `REPLAY_NOT_REPRODUCIBLE` when a finding is refused
      for one of `replay_alone`'s reasons; every other cause carries none.
    - *Changed:* storing a run reads its trace back from the bytes it stores: a
      trace that does not read back now fails storing the run, instead of every
      later replay of it.
    - *Changed:* `replay_finding` and `verify_finding_fix` look for the finding's
      request in the trace before they ask for consent: a finding whose request is
      not there is `REPLAY_NOT_REPRODUCIBLE` where it was
      `SIDE_EFFECTS_CONSENT_REQUIRED`.
    - *Added:* `reasons` in `SIDE_EFFECTS_CONSENT_REQUIRED`'s `data`: every case
      that applies, `safety_breached` before `recorded_with_side_effects`; `reason`
      is the first of them, so a recording made with `allow_side_effects` that
      also breached the guard reads `safety_breached` where it read
      `recorded_with_side_effects` ([Replay consent](operations.md#replay-consent)).
    - *Fixed:* an endpoint with a finding that only a shrink reached, as a
      `stateful` shrink can, counts as exercised: it is in `coverage.exercised` and
      the scope `compare_runs` rules by, and no longer in `endpoints_unreached`. Its
      `requests` still count exploration only.
    - *Added:* [`link_value_never_produced`](vocabularies.md#unprobed-reason) and
      `rule_never_drawn` in `unprobed_reason` and `vocabulary.unprobed_reasons`:
      why a `stateful` run that was not cut short never sent a targeted endpoint;
      with them, the signal cause `stateful_endpoints_unsent`, named after both,
      and those endpoints leave `endpoints_unreached`. `rule_never_drawn` also
      covers a rule whose arguments could never be drawn.
    - *Changed:* `estimate_finding_explanation`, `explain_finding`,
      `estimate_finding_fix` and `propose_fix` take a finding in any state, and the
      model is told what its `state` means. `propose_fix` may answer a `refuted`
      finding with an empty fix; `apply_finding_fix` refuses it with
      `FIX_EMPTY_OR_UNAPPLICABLE`. The state, and the control the finding was
      judged by (whether it had one, its source, whether it failed), are part of
      the explanation's and the fix's cache key ([Explaining and fixing an unconfirmed finding](replay-and-fixes.md#unconfirmed)).
    - *Changed:* why static analysis could not resolve an endpoint is an English
      sentence the core writes for its `code`, in `endpoint_failed`,
      `analyze_endpoints`' `failures`, `ENDPOINT_ANALYSIS_FAILED`,
      `STATIC_ANALYSIS_REQUIRED` and `estimate_inference`'s `untraced`. The `code`
      is unchanged ([the sentences](errors.md#analysis-failure-reasons)).

- **Report 1.26** — Additive; it ships with protocol `0.2.2`. Adds `starved` to
  each phase of `endpoints[].budget_by_phase`, and `finding_id` to each entry of
  `replay.defect_verdicts`; a report written before `1.26` has none.

- **0.2.1** — A finding's replay says what it judged and why it could not tell,
  and earns `possibly_resolved` behind witnesses. **Additive on the wire**: this
  core serves `0.2.0` up to `0.2.1`. The report stays `schema_version` 1.25.
    - *Added:* on `replay_finding`'s answer, and so on `verify_finding_fix`'s
      `replay`: `judged` (`oracle_scope`, `requests_sent`, `controls_resent`;
      `null` for a cancelled replay), [`inconclusive_reason`](vocabularies.md#inconclusive-reason)
      (`no_answer`, `stale_target`, `credentials_refused`, `witness_diverged`,
      `unwitnessed`, `not_observable_without_contract`), `witnesses` (the recorded
      reads sent before the finding's request) and `exchange` (the finding's
      request and its answer this time, in `get_finding`'s evidence shape)
      ([Finding replay verdicts](finding-replay.md)).
    - *Changed:* a finding's replay is `possibly_resolved` only when the server
      answered, runs the code with the fix, its credentials pass or are proven, and
      witnesses answered as recorded; otherwise it is `inconclusive` with the first
      reason that holds, and resolves nothing. An `inconclusive` replay takes an
      earlier `resolution` away. `present` is unchanged
      ([how the verdict is reached](finding-replay.md#verdict)).
    - *Changed:* when no witness answers, the finding's request is not sent
      (`no_answer`, `exchange` `null`, the server's log not read). `fidelity` is
      `reduced` when a witness diverged, the server's log is then not kept, and
      `run_status` is the worse of the witnesses' run and the finding's.
    - *Changed:* a `401` or `403` to a request recorded with credentials, where the
      recording got neither, never meets `acceptance` while no witness proves the
      credentials ([credentials](finding-replay.md#credentials)).
    - *Changed:* `fix_applied_at`, `stale_reason` and `stale_target`, in
      `replay_finding` and in `inspect_service` with `finding_id`, speak of the
      newest fix applied over the finding's handler files, its own or another
      finding's ([stale builds](finding-replay.md#stale)).
    - *Added:* [`scope_differs`](vocabularies.md#caveats) in `compare_runs`'
      `caveats[].reason`, side `pair`.
    - *Fixed:* `compare_runs` between a run of one endpoint and a run of many no
      longer rules the others' defects `possibly_resolved`: a defect the `after`
      run lacks, on an endpoint it did not exercise, is `inconclusive`.
    - *Changed:* `compare_runs`' `comparable` is ruled after every caveat, the
      `replay` one included: a comparison against a replay is never `comparable`.

- **0.2.0** — The compatibility kept for `0.1.x` clients goes away, and a cut no
  endpoint caused names none. **Breaking: this core serves `0.2.0` only**; a
  client asking for any `0.1.x` gets `PROTOCOL_VERSION_MISMATCH` with `oldest`
  `0.2.0` ([ADR-189](../adr/protocol.md#adr-189)). The report is `schema_version`
  1.25.
    - *Removed:* `stack_trace` on the findings of `get_run` and `get_finding`;
      `hacker` as a `strategy` value of `fuzz`, `run_pipeline` and
      `estimate_inference` (refused `INVALID_PARAMS` like any unknown strategy:
      send `security`); `strategy_mode` from `list_analyses`, `get_analysis`,
      `get_run`'s `analysis` and the report document's `analysis` (read
      `strategy`).
    - *Changed:* `run.truncation.endpoint_id` is `null` with reason
      [`flaky_generation`](vocabularies.md#truncation-reason), and the
      `truncated` event carries no `endpoint` for it; every other reason names
      one.
    - *Added:* [`run_truncated`](vocabularies.md#signal-causes) in
      `run.signal_causes`: a `truncated` run is always `degraded`, and a `fuzz`
      reply carries the `degraded_signal` warning naming it. The operation's
      `status` stays `completed` for such a run.
    - *Added:* [`requests_unanswered`](vocabularies.md#signal-causes) in
      `run.signal_causes`: an endpoint that leaves at least three of its
      requests, and at least 5 % of them, with a timeout or an availability
      failure makes the run `degraded`.
    - *Added:* `observation.marker` `inferred_rule_database_error`: a rejection
      of a value only an inferred rule forbids, whose body shows a database
      error, does not show the server applies the rule
      ([Witnesses](../../specforge-engine/witnesses.md#what-it-reports)).
    - *Changed:* a `stateful` run stops after two consecutive passes without
      progress, sends inferred-rule witnesses among its draws, and gives one
      further pass to the targeted endpoints it never reached and what produces
      their values ([Run depth](../../specforge-engine/stateful-depth.md#stateful-depth)).
    - *Changed:* a `control`'s `known_answer` is sent on every method, and on a
      write it follows a resource the accepted `attribution` renamed; a
      whole-request rejection that reproduces is `unverified` when a value in
      question was already accepted at its field
      ([Control requests](../../specforge-engine/control-requests.md)).
    - *Changed:* in a `performance` run, a latency finding and a crash are
      reported as observed, and every finding judged against the contract is
      shrunk and judged like a stateless one; in an `auth` run, an
      `access_control` finding and a crash are confirmed, and every finding judged
      against the contract is `unverified`
      ([Findings](../../specforge-engine/findings.md#states)).
    - *Changed:* the engine's warnings, not only its errors, are written to the
      core's stderr.

- **Report 1.25** — Breaking; it ships with protocol `0.2.0`. `analysis.strategy_mode`
  is removed (`analysis.strategy` stays). `run.truncation.endpoint_id` is `null`
  with reason `flaky_generation`. `run.signal_causes` gains `run_truncated` and
  `requests_unanswered`; `observation.marker` gains `inferred_rule_database_error`.
  The HTML report's header shows `Strategy`, the canonical value.

- **0.1.30** — A finding says what resolves it: `resolution` (`fix_id`,
  `fix_finding_id`, `replayed_at`) on every finding and on `replay_finding`'s
  answer, and `covering_fixes` on `inspect_finding_source`. The truncation reason
  `flaky_generation` is new: a stateful run whose passes kept ending because the
  target answered differently from an earlier test case ends `truncated`.

- **0.1.29** — An applied fix is verified with one build and a replay in a single
  operation, `verify_finding_fix`; `check_finding_fix` and `apply_finding_fix`'s
  `check` are removed, a proposed fix carries `build_failure`, and `propose_fix`
  takes `mend_build`. `set_finding_trace` keeps text with no stack frame as notes.

- **0.1.28** — `check_finding_fix` runs an applied fix's build apart from applying
  it, `inspect_finding_source` answers `server_trace`, and an edit quoted with the
  prompt's line numbers holds.

- **0.1.27** — An applied fix is checked with the project's own build and taken
  out again when it breaks it. `inspect_finding_source` and `set_finding_trace` are
  new; the config gains `replay.log_file` and the `fix` group
  (`fix.check_command`, `fix.check_timeout_s`).

- **0.1.26** — A replay finds the API under test on its port (`inspect_service`),
  can build and start it again first (`replay_finding`'s `rebuild`, error
  `REBUILD_FAILED`), and says when it still runs the code from before the
  finding's applied fix (`stale_reason`). The config gains
  `replay.rebuild_command`, `replay.hot_reload`, `replay.rebuild_timeout_s` and
  `replay.ready_timeout_s`.

- **0.1.25** — A replay says when the server still runs the code from before a finding's
  fix, a fix is aimed at where the server crashed, and a finding on a rule only a produced
  contract declares is judged by a plain request. Additive on the wire, with semantic
  changes; the report is `schema_version` 1.24. `replay_finding` answers `stale_target`,
  `null` unless the server logged a trace the applied fix cannot have logged.
  `revert_finding_fix` undoes an applied fix, and `status` gains `reverted`.
  `estimate_finding_explanation` and `estimate_finding_fix` take `include_prompt` and
  answer `prompt`. Entries of a fix's `discarded` carry `search`. The truncation reason
  `pass_limit_reached` is new. Explanations and fixes name the places that call the
  crashing function, a fix can add the import it needs, and a finding recorded as a crash
  with no stack trace is replayed once alone first when `replay.log_container` is set. A
  2xx to a value breaking a declared constraint gets an `acceptance` too. The
  `input_validation` and whole-request `contract_completeness` controls change: see
  [Control requests](../../specforge-engine/control-requests.md). A `replay_finding` of a
  `refuted` finding fails with `REPLAY_NOT_REPRODUCIBLE`.

- **Report 1.24** — A `control` carries the further requests that judged it.
  Additive; it ships with protocol `0.1.25`. A `control` can carry `attribution`,
  `peer`, `occupancy` and `known_answer`, and always carries `source`. See
  [What the report shows](../../specforge-engine/control-requests.md#evidence).

- **0.1.24** — A finding and a focus entry name a nested body field by its path,
  `input_validation` judges patterns and formats, and a finding whose control
  could not judge it is left unverified. Additive on the wire, with semantic
  changes; the report stays `schema_version` 1.23. `unprobed_reasons` gains
  `link_target_reserved`: an `auth` or `resilience` run sends nothing at an
  endpoint whose state link writes a bound value into a header the credentials or
  the transport own, counted under `access_preconditions_unmet`; an `auth` run
  whose only endpoint with a policy to cross is left unprobed this way fails with
  `EXECUTION_FAILED`. A finding's `request.poisoned_field` names a field inside a
  body object or array element by its dotted path (`user.email`, `items.0.price`,
  `0.role` for a body sent as an array), and so do the `rule_id`s of
  `input_validation`, `information_disclosure`, `reflected_payload`,
  `input_induced_timeout` and `mass_assignment` (`body.user.email`): the
  signatures of findings on nested fields change, those on top-level fields do
  not. A produced contract's `attack.focus_fields` and `sensitive_fields` name a
  nested field by the same path (`body.article.title` reaches that leaf only,
  `body.items.0.price` the field in every element, `body.0.price` or
  `body.$.0.price` a field of a body sent as an array); a `focus_fields` entry is
  checked along its whole path, and one the endpoint does not declare there makes
  the contract unusable (with the `inference` producer the endpoint falls back to
  `schema_only`, with the `fixture` producer the run stops). The `inference`
  prompt teaches those paths, so every cached inferred contract is inferred again
  once. `input_validation` judges a declared `pattern` and `format` (its
  `expected` carries the key `pattern` or `format`), reads a text as a lenient
  server does (`"+4"` for an integer is `4`; `"1"` or `"yes"` for a boolean is
  not a proven violation), and cites the text sent. A `mutation` finding names a
  judged field only when the mutation provably breaks that field's contract. A
  finding whose control request got an answer that cannot judge it (the server
  rejected it, or a `mass_assignment` control's success holds no object) is
  `unverified`, not `confirmed`. Path and header values are sent in
  OpenAPI's `simple` style, each part spelled as in the query (`true`, arrays
  joined by commas, objects as `k1,v1,k2,v2`); a `null`, empty-array or
  empty-object path value is not sent, and the bytes on the wire change.
  Mass-assignment keys are also injected inside the body's objects, the elements of
  a body sent as an array included, never under an object that admits extra keys;
  a form or multipart echo is compared with the key's value as sent.
  `contract_completeness` checks a `format` with the JSON Schema 2020-12 checker
  and reads a `pattern` as ECMA-262. A string with a known `format` is drawn
  within its declared length; an endpoint is excluded only when no valid text of
  the format fits ([Field addressing](../../specforge-engine/field-addressing.md),
  [Proving a violation](../../specforge-engine/provable-violation.md),
  [ADR-173](../../specforge-engine/adr/models.md#adr-173) to
  [ADR-185](../../specforge-engine/adr/engine.md#adr-185)).

- **0.1.23** — A finding a control request refuted is listed with that control, a
  `resilience` server error is confirmed by resending its attack, and the runs go
  deeper. Additive on the wire, with semantic changes. `finding_states` gains
  `refuted`: a finding a control request showed is not a defect, listed in
  `unconfirmed_findings` with its `control`. A stateless `contract_completeness`
  finding whose rule is `request` can be refuted: the same request with fresh
  string values was accepted once and rejected the same way when sent again, a
  conflict with stored state; its `control` is the accepted request.
  `unprobed_reasons` gains `owner_identity_missing`: a `resilience` run with no
  valid identity sends an `owner_only` endpoint nothing, counted under
  `access_preconditions_unmet`. `resilience` builds its attacks on the endpoint's
  minimal valid request, on a resource provisioned for the owner of an
  `owner_only` endpoint; its variant's `phases` is `["valid"]`, and `security` and
  `exposure` gain `payloads` in its `effects` rows (and `field_hints` with the
  `fixture` or `inference` producer). A `resilience` server error is resent twice:
  one that does not come back on both resends is `flaky`; a confirmed one carries
  the clean base request sent afterwards as its `control`, and its `summary` says
  whether the attack left the endpoint broken. A `stateful` run continues past its
  first defect, until a pass finds nothing new or 25 distinct defects, or 25
  distinct flaky ones, are found; its defects carry `request.trigger_fields`, and
  two defects with one signature but different trigger fields are reported apart.
  A `DELETE` removes the resource it consumes from what later steps draw, and a
  deleted-resource transition is derived when the resource's read declares 404 or
  410, only where the deleting path has a single placeholder, its last segment; a
  transition whose follow-up path has a placeholder its probe does not fill is
  rejected and listed in `excluded_endpoints`. A `stateless` run sends producers
  first and deletes last, and draws path identifiers mostly, and query values
  sometimes, from what the run's successful responses returned; a request whose
  method is not safe draws only values the run created, unless the run allows side
  effects (`allow_side_effects`), when it may also reuse values it only read; a
  value a finding holds is never reused by such a request. In `valid`, a string named
  like an email, a username or a password gets a usable value when its contract
  constrains it in no other way. An object parameter's examples seed its
  properties ([Run depth](../../specforge-engine/run-depth.md),
  [ADR-162](../../specforge-engine/adr/runners.md#adr-162) to
  [ADR-172](../../specforge-engine/adr/measurement.md#adr-172)).

- **Report 1.23** — A finding a control request refuted is listed, with the
  control that refuted it. Additive; it ships with protocol `0.1.23`. An entry of
  `unconfirmed_findings` can carry `state` `refuted`, with its `control` and a
  `summary` that says it was refuted. See the
  [Run Report](../../../user-guide/reports.md#unconfirmed-findings).

- **0.1.22** — A replayed crash says whether it now answers as its fix was asked
  to, and explanations and fixes start from what the fuzzer measured. Additive on
  the wire, with semantic changes. `replay_finding` answers `acceptance` for a
  finding recorded as a crash: the 4xx statuses the contract declares for the
  operation, the status observed, and whether it `met` one of them. `explain_finding`
  and `propose_fix` send the model the facts the fuzzer measured, and `propose_fix`
  applies a fix whole or not at all, asking once more when an edit is refused.

- **0.1.21** — A finding's request can be re-sent alone to check a fix, and the
  stack trace its server logged meanwhile is kept and reaches the explanation and
  the fix. Additive. `replay_finding` sends the one recorded request a finding was
  reported from, under its analysis's recipe, and rules it `present`,
  `possibly_resolved` or `inconclusive`. The option `replay.log_container` names the
  Docker container the API runs in, whose log is read for the stack trace while
  the request is in flight.

- **0.1.20** — A run picks one of five strategies by its canonical name and how
  many examples it asks of each endpoint, and the handshake says what each mode,
  strategy and producer changes. Additive on the wire, with semantic changes.
  `strategy` on `fuzz`, `run_pipeline` and `estimate_inference` takes `default`,
  `security`, `conformance`, `smoke` or `exposure`; `hacker` is still accepted as
  `security`, never listed and never sent back, and the `started` event carries
  the canonical value. An analysis carries `strategy` beside `strategy_mode`, its
  label for older clients. `examples_per_endpoint` on `fuzz` and `run_pipeline`, at least 1;
  a smaller one, or one asked of a runner that honors no count (the `performance`
  ladder, `auth`, `resilience`), is refused `INVALID_PARAMS`. `hello` and
  `describe` carry [`fuzz_options`](fuzz-options.md); the schema now requires
  `vocabulary` and `fuzz_options` in `hello`. The opt-in invariant
  `undeclared_response_field` (`contract_hygiene`, `low`), turned on by
  `conformance`. Under `security`, mutation breaks every field.
  `sensitive_data_exposure` judges every successful response whose status
  declares a body schema; the replay of an unpoisoned exposure is
  `inconclusive`. An object whose `type` is missing or a list naming `object`
  honors its `additionalProperties`. A secret a response returns is redacted from
  its own finding, and a sent credential never reaches a signature or a
  `rule_id`. `compare_runs` gains the caveats `strategy_differs` and
  `examples_differs`. A refused strategy's message names its canonical value
  ([Strategies](../../specforge-engine/strategies.md),
  [ADR-155](../adr/protocol.md#adr-155) to
  [ADR-161](../adr/core.md#adr-161)).

- **Report 1.22** — The analysis names its strategy canonically and the examples
  it asked of each endpoint. Additive; it ships with protocol `0.1.20`.
  `analysis.strategy`, the canonical strategy, right before
  `analysis.strategy_mode`, which keeps its label for older clients; and
  `analysis.examples_per_endpoint`, `null` when the runner honors no count or for
  an analysis stored before it was recorded. See the
  [Run Report](../../../user-guide/reports.md).

- **0.1.19** — A finding says what kind of defect it is, how serious, what
  happened in one sentence and the evidence behind it, live and read back, and the
  handshake carries the labels to show it with. Additive on the wire, with
  semantic changes. Each finding of `get_run` and `get_finding` carries
  `category`, `severity`, `summary`, `observation`, `request`, `response` and
  `control`, as the report's defects do; `stack_trace` is always `null` there and
  is deprecated, to be removed with the next minor. The `finding` event carries
  `category`, `severity` and `summary`. `hello` and `describe` carry
  [`vocabulary`](#vocabulary). `metrics.findings_refuted` is new. A load step
  measured on no samples has `degraded` `null`, and a ladder that judged no step
  makes the signal `degraded` with `load_unjudged`. A `resilience` run sends
  nothing to a `role_only` endpoint whose role no identity holds
  (`required_role_unheld`, `access_preconditions_unmet`). `settings.base_url` is
  published with its password, query values and fragment as `***`.
  `compare_runs` against a replay meets each defect with the replay's verdicts on
  the recorded defects of its own identity, and `after_count` counts those seen
  present. A run's or a replay's `base_url` with a query or a fragment is refused
  `INVALID_PARAMS`: it never worked, since the route was appended after it
  ([findings](../../specforge-engine/findings.md),
  [ADR-148](../../specforge-engine/adr/findings.md#adr-148) to
  [ADR-154](../adr/core.md#adr-154)).

- **Report 1.21** — Each finding carries its classification, its summary and its
  evidence, and the defects sort by severity. Breaking for a reader of
  `stack_trace`; additive otherwise; it ships with protocol `0.1.19`. Each defect
  and each unconfirmed finding carries `category`, `severity`, `summary`,
  `observation` (`expected`, `observed`, `location` `{scope, path}`, `marker`),
  `request` (`url`, `poisoned_zone`, `poisoned_field`, `attack_family`,
  `trigger_fields`), `response` (`content_type`, `headers`, `latency_ms`) and
  `control` (`status_code`, `latency_ms`, `error`); a finding stored earlier reads
  the four evidence fields back `null`. A replay carries `defect_verdicts`, one
  per defect the recorded run confirmed, and `judged` (`oracle_scope`,
  `recorded_defects`, `present`, `possibly_resolved`, `inconclusive`); a request
  verdict is `possibly_resolved` only where the replay could observe the recorded
  finding. Each step of a `transition_sequence` carries `payload`,
  `response_body` and `response_body_truncated`. `defects` and
  `unconfirmed_findings` sort by `severity`, then registry order.
  `metrics.findings_refuted`, `load_profile[].degraded` `null` and
  `load_unjudged` as in `0.1.19`. `defects[].stack_trace` is removed; it was
  always `null`. See the [Run Report](../../../user-guide/reports.md).

- **Report 1.20** — The report says where each endpoint's requests, findings and
  examples went, phase by phase, confirms a load degradation before reporting it,
  and names an incomplete contract. Additive; the protocol version does not
  change. Each endpoint, in the report and in `get_run`, carries `by_phase`,
  `findings_by_phase`, `by_attack_family` and `budget_by_phase` (`{planned,
  carried_in}` per phase), each `{}` when nothing was counted
  ([ADR-144](../../specforge-engine/adr/engine.md#adr-144)). Each `load_profile`
  step carries `remeasured`, the confirmation window, `null` when the step was
  measured once ([ADR-145](../../specforge-engine/adr/engine.md#adr-145)). The
  invariant `contract_completeness` is a 400 or 422 to a request that conforms to
  its contract, its declared rule naming the field the response blames as
  `<zone>.<field>` or `request`, labelled "Incomplete contract", ranked last, and
  explained by `explain_finding` with a fixed template
  ([ADR-143](../../specforge-engine/adr/engine.md#adr-143)).

- **Report 1.19** — The report names five security findings. Additive; the
  protocol version does not change. The invariants `information_disclosure`,
  `sensitive_data_exposure`, `reflected_payload`, `mass_assignment` and
  `input_induced_timeout`, each with a declared rule naming the field that
  triggered it as `<zone>.<field>` (`body.role`), or `response.<key>` for an
  exposed key, one finding per endpoint and field, and a rule label of its own.
  They rank right after `not_a_server_error`
  ([ADR-139](../adr/core.md#adr-139)).

- **Report 1.18** — The report names a success that accepted an invalid input, and
  an endpoint the engine failed on while the rest of the run went on. Additive; the
  protocol version does not change. The invariant `input_validation`: a 2xx that
  accepted a value outside the declared schema of the field its `rule_id` names,
  as `<zone>.<field>` (`query.limit`; `body.$` for a body that is not an object),
  one finding per endpoint and field. The truncation reason `engine_failure`: an
  endpoint whose exploration raised inside the engine was isolated, with the
  error's type and location in `detail`; the run explores the other endpoints and
  ends `truncated` ([ADR-125](../adr/core.md#adr-125)).
- **0.1.18** — An endpoint whose produced contract declared a risk flag and could
  not be used runs schema-only under the safety guard instead of being withheld.
  Additive on the wire, with semantic changes. Such an endpoint (an identity that
  does not match it, a fusion failure, a construct the projection does not support)
  keeps only its declared risk flags; the guard holds it as any other, naming the
  flag in `held_back_by`. `producer_exclusions[].disposition` and `contract_failed`'s
  `disposition` are `schema_only` for it, its `reason` naming the flags the guard
  still holds. `generate_contract` composes the mount prefixes it can read
  statically, writes a `requestBody` for a Go handler binding one struct with
  validation tags, and emits `started` before validating `repo_root`.
  `endpoint_failed.code` can be `SOURCE_UNREADABLE`. `fuzz`, `run_pipeline` and
  `replay` without `identities_path` read the one `specforge.toml` declares under
  `[project]`, and `ProjectState` carries `settings.identities_path`. The error
  `REPO_ROOT_INVALID` (`data`: `repo_root`, `reason`) answers a `repo_root` that does
  not exist or is not a directory. A `get_config` row's `layer` can be
  `environment`.
- **0.1.17** — A proposed fix can be applied to the tree its finding's run traced.
  Additive. `apply_finding_fix` (family `results`, destructive): `finding_id`,
  `fix_id`, `create_backup`; through `git apply` in a Git work tree, else by
  replacing each edit in place with a `.bak` copy; it answers `applied` or
  `conflict`, the tree untouched. The errors `FIX_EMPTY_OR_UNAPPLICABLE` and
  `FIX_APPLY_FAILED`. `get_finding`'s `fix` answers `applied`.
  `list_llm_models` answers `credential_env_vars` per provider.
- **0.1.16** — A finding can be explained in plain language and a model can propose
  a fix for it. Additive. `estimate_finding_explanation` and `explain_finding`
  (a fixed template, a stored explanation or a model, optionally with the handler's
  code), `estimate_finding_fix`, `propose_fix` (SEARCH/REPLACE edits checked
  against the traced tree, never written) and `get_finding_fix_patch`.
  `get_finding` answers `explanation` and `fix`. The errors
  `FINDING_EXPLANATION_FAILED`, `FINDING_FIX_FAILED`, `FIX_NOT_FOUND` and
  `STATIC_ANALYSIS_REQUIRED`; `endpoint_failed.code` can be `FRAMEWORK_ROUTE`.
- **0.1.15** — A project with no OpenAPI document can get one from its code.
  Additive. `generate_contract` scans `repo_root` without running it, writes an
  OpenAPI 3.1 document and loads it; with `use_llm`, an approved LLM discovers more
  routes and refines each one ([Operations](operations.md#generate-contract)). The
  error `CONTRACT_GENERATION_FAILED`. `list_llm_models` lists the models a
  provider's account can call, else its catalog.
- **0.1.14** — `get_config` publishes `paths.llm_env_file`, the `.env.local` the
  LLM layer reads, so a frontend can write the user's model and key there.
  Additive.
- **0.1.13** — `update_project` (family `session`) changes `name`, `openapi_spec`
  or `base_url` in `specforge.toml`, leaving the other sections and comments as
  written, and reloads the project. Additive.
- **0.1.12** — The catalog says what an operation needs and what it destroys.
  Additive. `requires: "analysis"` on `get_static_analysis`,
  `get_endpoint_static_analysis` and `get_llm_payload`; `destructive` on every
  operation, `true` on `apply_fix_plan` and `apply_prune_plan`. `shutdown` and
  EOF cancel, wait and exit; `max_in_flight` is `8`, and `$/cancelRequest`
  reaches a queued request. `run_pipeline`'s `contract` stage runs the session's
  loaded contract. `specforge.toml`'s `engine.*` values reach a run, checked like
  a request's; `engine.headers` refuses credential headers.
- **0.1.11** — A run shows, and can cancel, the production of its contracts,
  several endpoints at once. Additive. `contract_started`, `contract_finished`
  and `contract_failed` on `fuzz` and `run_pipeline`; `run.production_duration_ms`;
  option `inference.max_workers` (`1` to `16`, default `4`); `minimum` and
  `maximum` on `get_config` rows. `producer.max_cost_usd` is checked as each
  inference is admitted. The report document is `schema_version` 1.17.
- **0.1.10** — An `auth` run degrades per endpoint. Additive. Four
  `unprobed_reason` values (`owner_producer_missing`, `owner_chain_cyclic`,
  `owner_resource_unprovisioned`, `required_role_unheld`) and the signal cause
  `access_preconditions_unmet`; the run fails `EXECUTION_FAILED` only when no
  endpoint with a policy to cross could be crossed. A stateful run counts its
  shrink requests in `requests_shrink`. Nested resources link to their parent's
  bundle, and `minimal_payload` redacts the built-in credential names.
- **0.1.9** — The safety guard holds every spelling of a vetoed route and says
  who caused each hold. Additive on the wire, with one refusal: a `replay` of a
  recording made with `allow_side_effects`, or one that breached the guard,
  needs `allow_side_effects` (`SIDE_EFFECTS_CONSENT_REQUIRED`). `held_back_via`
  on each endpoint; `disposition` (`schema_only` or `withheld`) on each
  `producer_exclusions` entry. The report document is `schema_version` 1.16.
- **0.1.8** — `run_pipeline` produces its contracts once, in its `inference`
  stage, and `execution` runs what that stage produced; a refusal met before the
  engine fails the `inference` stage. Additive. `repo_root` on `run_pipeline`;
  `name`, `openapi_spec` and `base_url` on `init_project`, whose result carries
  `settings` and `spec_found`. A relative `producer.source_repo`,
  `producer.contracts_dir` or `identities_path` resolves against the project
  root.
- **0.1.7** — Inference cost is estimated, approved by token, and capped.
  Additive. `estimate_inference`, which calls no model; `producer.approval_token`
  and `INFERENCE_APPROVAL_REQUIRED`; `producer.max_cost_usd`; `data` on a failed
  `run_pipeline` stage; `run.inference_cost` (`{estimated, actual}`); option
  `inference.require_approval` (default `true`). The report document is
  `schema_version` 1.15.
- **0.1.6** — `hello` negotiates within the series from the floor `0.1.5`; an
  additive change bumps the patch and a breaking one the minor.
  `PROTOCOL_VERSION_MISMATCH` carries `oldest`. Additive. `producer.refresh` on
  `fuzz` and `run_pipeline`; an `inference` run whose store did not open is
  refused `CONTRACT_PRODUCER_FAILED`; `run.contract_cache` (`{hits, misses}`).
  The report document is `schema_version` 1.14.
- **0.1.5** — Every reader of a run says the same thing under the same name.
  Breaking for a frontend that reads the renamed keys or relies on absences: an
  analysis's `repo_hash` is `generated_against_repo_hash` in `list_analyses`,
  `get_analysis` and `get_run`; in the report document an endpoint's
  `crash_count` is `findings_confirmed` and an unconfirmed finding's
  `occurrences` is `represented_findings`. A missing fact is `null`, never `""`:
  the report's `held_back_by` and `unprobed_reason`; in `get_run`, an endpoint's
  `load_profile` is a list of steps (`[]` when no concurrency ladder ran) and a
  crash's `transition_sequence` is `null` for a crash a stateless run found (a
  stateful crash keeps a list, `[]` on its first step), instead of `[]`.
  Added: a per-endpoint `truncation` (`{reason, detail}`) in `get_run` and the
  report; `run.oracle_scope`; coverage's `reached_by_transition` and
  `reached_by_transition_endpoints`. In `compare_runs`, each caveat carries
  `detail` beside `reason`, and `reason` is always a token of the
  [result vocabularies](vocabularies.md#caveats), with `oracle_scope_differs`
  and `safety_breached` new. A run that reached a route the safety guard held
  back is stored as `safety_breached`; the operation and its `finished` event
  answer `safety_breached`, and `run_pipeline`'s execution stage ends `failed`
  (`stopped` when cancelled), live and in the reply. The report document is
  `schema_version` 1.13.
- **0.1.4** — Additive: nothing is removed or renamed, but `hello` must say
  0.1.4. In `list_runs` and `get_run`, a run's `truncation` gains `detail` and
  `target_down_verdict`; in `get_run`, each endpoint gains `by_category` and
  `held_back_transitions`; in `get_run` and `get_finding`, an unconfirmed finding
  gains `body_fingerprint` (`""` means the response had no body). The report
  document is `schema_version` 1.12. `target_down`'s description names both ways
  a run concludes the API is down: a failed liveness probe, or every circuit
  breaker open.
- **0.1.3** — `finding` catches up with what the engine knows while a run is in
  flight. Breaking for a frontend that reads `finding`: `finding_id` and
  `severity` are gone (neither has an honest source before a run is persisted),
  and `invariant` and `phase` arrive — the same vocabulary the persisted defect
  uses, so live findings correlate with the report. `endpoint_ref.number` becomes
  optional in events (a reload can leave an event about an endpoint the catalog
  does not number). The server also matches the contract where it did not:
  `target_down` carries `reason`, an operation sends a single `started`, and
  `endpoint_failed` carries the closed `code` plus a human `reason` instead of a
  class name.
- **0.1.2** — The contract catches up with what the server does. Breaking for a
  frontend that reads stages or the payload: `started`/`finished` carry
  `operation`; the stage vocabulary is `contract` / `static_analysis` /
  `inference` / `execution`; a stage ends `completed` / `failed` / `skipped` /
  `stopped`. `get_llm_payload` answers an `LlmPayload` with a `delivery`
  discriminant rather than always a file path. A cancelled run keeps and
  persists its evidence, so its document is not null and a cancelled
  `run_pipeline` answers with the stages already finished. Two new operations
  (`apply_prune_plan`, `apply_fix_plan`), a `requires` field on every operation,
  `deadline_ms` on `fuzz`/`run_pipeline`, and five new error codes. Parameters
  are coerced and validated, so a wrong type or an out-of-vocabulary enum answers
  `INVALID_PARAMS` instead of leaking an `INTERNAL_ERROR`.
- **0.1.1** — Three holes in the validator closed (a `progress` envelope was
  never validated; a token-less notification crashed instead of reporting;
  nothing checked an emitted `kind` against `capabilities.event_kinds`). Adds
  `fixtures/invalid/`. Contract hole closed: an `id` is never reused within a
  session.
- **0.1.0** — First version: framing, message shapes, the progress token, the
  event catalog, cancellation, the handshake, errors, endpoint reference and
  payload policy. Events are one method with a union by `kind` (the counter is
  `tick`); cancellation is `$/cancelRequest` only; the payload threshold is read
  from the handshake.
