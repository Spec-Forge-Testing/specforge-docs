# Spec Forge Engine — Decision records — Findings

Part of the [Spec Forge Engine decision records](index.md). Decisions about what a
finding is: how it is classified, what it records about the breach, how two
findings are told apart, when a control request rules one out, and what is
withheld from its evidence. The behaviour is described in
[Findings: taxonomy and evidence](../findings.md).

---

## ADR-148 — One registry in the engine classifies every invariant, and the core derives the classification when it reads { #adr-148 }

**Status:** accepted · Supersedes in part [ADR-125](../../core/adr/core.md#adr-125), [ADR-139](../../core/adr/core.md#adr-139) · `models/runtime/taxonomy.py`, `models/runtime/labels.py`, `models/runtime/crash_report.py`; core `services/deps/engine_vocabulary.py`, `services/catalog/vocabulary.py`, `services/report/ordering.py`

### Context

A frontend shows a finding's kind, how serious it is and a label for it. That
knowledge lived in several parallel tables: a severity ranking and a rule-label
table in the core, a label table in each client. Each table was kept by hand, so
each drifted: an invariant added to the engine ranked last in one, had no label in
another, and a client showed a raw value for most of them. The finding itself held
none of it.

### Decision

**`INVARIANT_TAXONOMY` is the single source.** It maps each `InvariantViolation`
to a frozen `InvariantInfo`: `category` (`FindingCategory`), `severity`
(`Severity`, whose declaration order is its rank), `label`, `rule_source`
(`intrinsic` or `declared`), the intrinsic rule's text, whether a contract-free
judgement can observe it, and whether the identity tells two findings apart.
`DECLARED_RULE_INVARIANTS` and `IDENTITY_SCOPED_INVARIANTS` are derived from it.
The registry's order breaks ties within one severity.

**Nothing derived is stored.** `CrashReport.category` and `.severity` are
properties read from the registry. The core reads them through its engine gateway
when it reads a finding, sorts the report by severity rank and then by registry
order, and publishes the whole registry, with labels, as the handshake's
`vocabulary`. The labels of the other closed vocabularies a run reports
(truncation reasons, finding states, unprobed and hold reasons) live beside it,
in `models/runtime/labels.py`.

**`resilience_degradation` is a `crash`.** It is a 5xx or a dropped connection
on a malformed request. Its severity stays `medium`, below `not_a_server_error`,
because the request is broken on purpose.

### Rejected

- **The vocabulary in the shared kernel.** The kernel is the endpoint contract,
  and its version keys the inference cache. A finding's classification is not
  part of what an endpoint promises.
- **Mirrors in the core, held equal by a test.** They are the parallel tables this
  replaces, with a gate on top.
- **Columns for category and severity in storage.** With a `CHECK` they duplicate
  the vocabulary in the schema; without one they freeze the classification a run
  had when it was stored, and the registry stops being the only source. Storage
  already keeps `phase` and `state` as free text for the same reason: the
  vocabulary belongs to the engine.

### Consequences

A change to the registry reclassifies every stored run when it is next read.
`TestNewInvariant` fails until a new invariant has its entry. Without the engine
installed, the core publishes empty engine lists and reports `category` and
`severity` as `null`.

---

## ADR-149 — A verdict carries a typed observation: four slots and a location { #adr-149 }

**Status:** accepted · `models/runtime/observation.py`, `runtime/oracles/`, `runtime/runners/performance/degradation.py`, `runtime/fuzzers/stateful/transitions.py`, `shared/schema_check.py`

### Context

A finding said which invariant broke and which rule, but not what the oracle saw.
A reader of a schema finding could not tell which pointer broke which keyword, a
reader of an exposure finding could not tell which keys leaked, and a reader of a
latency finding had no numbers. Each oracle knew the answer when it judged the
response and dropped it.

### Decision

**`Observation` has four slots: `expected`, `observed`, `location` and
`marker`.** `expected` and `observed` are JSON values. `location` is a `Location`
of a `LocationScope` and a `path` whose spelling the scope fixes: a rule-id
spelling for a request field, an RFC 6901 pointer into the body, a lower-case
header name, a load step's concurrency, a caller's label, or a follow-up's
`<METHOD> <path>`. `marker` names the kind of breach when an invariant has
several. Every `OracleVerdict`, `ObservedViolation` and `CrashReport` carries one;
what each invariant fills is fixed and tested per oracle.

The schema check reports the **first mismatch** with its pointer, keyword and
declared value (`first_mismatch`), so `response_schema_conformance` and
`input_validation` name what broke rather than that something did.

### Rejected

- **A tagged union, one model per invariant.** More precise, but every client
  would have to know seventeen shapes. Four slots with a fixed meaning per
  invariant are enough to render and to tell.
- **Plain strings in `expected` and `observed`.** They lose the structure of a
  list of statuses or a map of rule fields, and make a client parse text.

### Consequences

A client renders any finding with one panel. The core tells what happened from
the observation ([ADR-153](../../core/adr/core.md#adr-153)), and the redaction can
withhold a slot by what it holds ([ADR-152](#adr-152)). A finding stored before
the observation existed reads it back `null`.

---

## ADR-150 — Findings are told apart by the field they poisoned and, without one, by the cause a probe confirms { #adr-150 }

**Status:** accepted · Superseded in part by [ADR-211](#adr-211) · `models/runtime/findings.py`, `runtime/findings/grouper.py`, `runtime/findings/shrinker.py`, `runtime/findings/causes/walk.py`, `runtime/findings/causes/triggers.py`, `runtime/findings/constants.py`

### Context

Raw findings that share a signature are shrunk through one representative, which
stands for the group. The signature did not include the field a request poisoned,
so two fields that broke one endpoint with the same 500 were one finding. A group
from the `valid` phase poisons no field at all, and can still hold two causes:
one value that crashes the parser and another that crashes a validator, both a
500.

### Decision

**Two mechanisms, each covering what the other does not.**

1. **`FindingSignature` includes `poisoned`.** Findings that poisoned different
   fields are different groups. It costs nothing.
2. **A counterfactual walk, for groups that poisoned no field.** The first
   faithful representative's `trigger_fields` are where its minimal payload
   differs from the simplest payload of the same phase, a comparison that sends
   nothing. Each further member is then settled: one that sent the same values in
   those fields is explained for free; otherwise one probe sends the
   representative's minimal payload with the member's values there, and if it
   still reproduces, the member is explained; otherwise the member is shrunk as a
   second representative, holding those fields, on half the shrink budget, and
   reported on its own only if its trigger fields differ.

`CAUSE_PROBES_PER_SIGNATURE` (3) and `MAX_REPRESENTATIVES_PER_SIGNATURE` (2) bound
the walk. They are stability constants, not knobs.

### Rejected

- **Shrinking every member.** It multiplies the shrink cost by the group's size.
- **Comparing values without a probe.** Values vary in almost every group, so it
  would spend a second shrink on nearly all of them.
- **The 500's message in the body fingerprint.** Framework error pages are
  generic, and messages that carry ids split one defect into many.

### Consequences

Measured over three repetitions per cell on the lab API and the RealWorld Go
target, against the engine without either mechanism under the same conditions: the Go
`default` cell's shrink requests stayed within noise (+2 % on the mean); the lab's
`security` cell spent 19 % (median) to 31 % (mean) more shrink requests and 4 % more
wall time, for two or three more reports per run, every planted bug still found in
all repetitions. Most of that cost is the poisoned field in the signature: more
`attack` groups, each with its shrink. Restricting the walk to unpoisoned groups,
and halving the second shrink's budget, are what keep the walk itself cheap.

---

## ADR-151 — A finding its control request refutes is counted apart from a flaky one, and a control that gets no answer leaves it unverified { #adr-151 }

**Status:** accepted · Supersedes in part [ADR-138](engine.md#adr-138) · Superseded in part by [ADR-167](#adr-167), [ADR-182](#adr-182) · `models/runtime/results.py`, `models/runtime/stats.py`, `runtime/fuzzers/stateless/shrinking.py`, `runtime/fuzzers/stateless/control_checks.py`, `runtime/fuzzers/stateless/streak_timeout.py`, `runtime/findings/shrinker.py`

### Context

A control request rules out a `mass_assignment` or `input_induced_timeout`
finding whose signal shows without the poison
([ADR-138](engine.md#adr-138)). Such a finding was counted flaky, which says it
did not reproduce, when it reproduced and was disproved. A control that timed out
or could not connect was read as "the signal did not show", so it confirmed the
finding on no evidence. And a request that timed out on a valid value, with no
poisoned field, was never judged: a streak of them ended the endpoint as an
infrastructure failure, even when the target answered everything else.

### Decision

**A shrink attempt ends in a `ShrinkVerdict`:** `reproduced`, `not_reproduced`,
`refuted`, `control_unanswered` or `unattempted`.

- `refuted` is counted in `findings_refuted`, apart from `findings_flaky`, and is
  never listed as a finding.
- `control_unanswered` counts the finding `unverified`, and the unverified entry
  carries the control's `ControlEvidence`, so the reader sees why.

**A timeout on a valid value is judged against a control.** When a streak of
timeouts no oracle judged reaches the threshold with the target alive, the endpoint's
minimal valid payload is sent. If it answers in time, each timeout of the streak
becomes an `input_induced_timeout` with the rule `request` and exploration goes on;
if not, the endpoint aborts as before. The stateful mode keeps its run-wide cut:
its streak spans endpoints, and there is no single request to control against.

### Rejected

- **A `refuted` finding state.** It adds a value to a closed field clients branch
  on, and it would read as a defect when it is the proof that there is none.
- **Judging every unpoisoned timeout as input-induced.** Without a control, a
  slow target would be reported as a bug in the input.

### Consequences

`findings_refuted` appears in the run's metrics. A confirmed controlled finding
carries its control in `control`. A replay cannot send a control, so it cannot
see a timeout ruled on the whole request again
([ADR-154](../../core/adr/core.md#adr-154)).

---

## ADR-152 — Evidence is redacted by what each slot holds, against one sensitive-name rule shared with the exposure oracle { #adr-152 }

**Status:** accepted · Supersedes in part [ADR-060](engine.md#adr-060), [ADR-103](engine.md#adr-103) · Superseded in part by [ADR-158](#adr-158) · `shared/sensitive_names.py`, `runtime/findings/redaction/finding.py`, `runtime/findings/redaction/exchanged_slots.py`, `runtime/findings/redaction/sanitize.py`, `runtime/findings/redaction/url.py`, `runtime/findings/materializer.py`, `runtime/oracles/security/sensitive_data.py`

### Context

A finding carries more than a payload and a body: an observation, the
request's URL, the response's headers and, for a stateful finding, each earlier
step's payload and body. Each is a new place a secret can travel. The name
redaction matched an exact list after normalization, while the
`sensitive_data_exposure` oracle needed to recognize secret-looking names it had
never seen (`user_password_confirmation`, `refreshTokens`). Two rules would mean a
finding could report a key as a leaked secret and show its value in its own
evidence. Withholding a whole observation whenever it touched a sensitive field
would also hide what is never a secret: a latency, a status, a declared keyword.

### Decision

**One predicate names a secret.** `is_sensitive_field_name` matches the known
credentials, secret stems in any word of a snake, kebab or camelCase name,
compound stems with separators removed, short words standing alone and hashed
secrets, and exempts a token that is a counter or a cursor and a session
attribute. The exposure oracle and every redaction call it.

**An observation is redacted slot by slot.** When its `location` names a
sensitive request field, response pointer or response header, only the slots that
hold a value the exchange carried are withheld; `EXCHANGED_SLOTS` declares those
slots per invariant.

**Then by credentials and by value.** Response headers are withheld by a list of
their own (`set-cookie`, `www-authenticate`, `proxy-authenticate`, ...) and by the
predicate. Every credential a request of the finding sent is scrubbed in every
form; every value withheld by name, from the request and from earlier stateful
steps (what they sent and what came back), is scrubbed wherever it reappears,
text by equality at any length and by spelling from 8 characters, never a number
or a flag. The reproducer keeps the failing request's own values except its
sensitive fields and credentials, since those values are what reproduces it. The
URL drops userinfo, query and fragment, and shows the path values as the redacted
payload shows them.

### Rejected

- **Two rules, one for the oracle and one for redaction.** They drift, and the
  drift is a leak.
- **Withholding the whole observation.** It hides the numbers that make a finding
  readable.
- **Scrubbing the reproducer of everything the request sent.** It would no longer
  reproduce.

### Consequences

A name the predicate calls a secret is both reported and withheld. A new
invariant declares its exchanged slots or the extensibility gate fails. The trace
keeps the raw exchange: a replay sends what was recorded.

---

## ADR-158 — Sensitive data is judged on every successful response that declares a body, and a response's own secrets are withheld from its finding { #adr-158 }

**Status:** accepted · Supersedes in part [ADR-152](#adr-152) · `runtime/oracles/security/sensitive_data.py`, `runtime/oracles/response_walk.py`, `models/runtime/taxonomy.py`, `runtime/findings/redaction/sanitize.py`, `runtime/findings/redaction/finding.py`, `runtime/findings/grouper.py`; core `services/replay/rules.py`

### Context

`sensitive_data_exposure` judged only the successful response to a poisoned
request, and only `boundary`, `invalid` and `attack` poison. A plain `GET` that
returns a password hash in a `valid`, `mutation` or stateful request was never
judged, though a secret exposed is a defect with or without an attack. Judging
every 2xx naively breaks a contract-free judgement: a replay judges with no
declared responses, so every secret-looking key, `token` on a login response
included, would read as undeclared. And once ordinary responses are judged, the
secrets they return reach the finding's own evidence, which the redaction withheld
only by name.

### Decision

**Judged where the contract can say what is declared.** The oracle judges a 2xx
when its request was poisoned, as before, or when the response's status declares a
body schema. A secret-looking key is undeclared when the object that holds it does
not declare it, read through the same walker as `undeclared_response_field`
([ADR-157](strategies.md#adr-157)). Without a contract, only a poisoned request is
judged.

**A replay knows what it cannot see.** The registry marks the invariant
`contract_free_needs_poisoning`, and `observable_without_contract(invariant,
rule_id, poisoned=...)` answers per finding: the replay of an unpoisoned exposure
is `inconclusive`, never resolved.

**What a response returns is withheld like what a request sent.** Every text of at
least `MIN_SECRET_LENGTH` (8) characters that the body and header redaction
withhold from the failing response is scrubbed wherever it reappears in the
finding: a copy under a neutral key or in a `Location` header reads `***`.
Shorter values stay withheld by name only, so `active` or `Bearer` never corrupt
unrelated text.

**A sent credential never reaches a signature.** The signature's body fingerprint
reads a JSON body's top-level keys with every sent credential scrubbed, and so is
its `rule_id`, which an unconfirmed finding stores.

### Rejected

- **Judging every 2xx, declared or not.** A replay and a stateful transition
  probe would report declared tokens as leaks, and a replay's verdicts would be
  wrong.
- **Turning the oracle on only under `security` and `exposure`.** An exposed
  secret does not depend on the input; on the RealWorld target `default` reported
  no new exposure, so there was no noise to avoid.
- **Scrubbing every received value by value.** Short values appear everywhere,
  and the evidence would stop being readable.

### Consequences

Every strategy can report an exposed secret on an ordinary response, once per
endpoint and rule. A response schema that declares no body leaves an unpoisoned
2xx unjudged, since nothing says what it should contain. The reproducer keeps the
failing request's own values, as [ADR-152](#adr-152) requires.

---

## ADR-167 — A refuted finding is listed with the control that refuted it { #adr-167 }

**Status:** accepted · Supersedes in part [ADR-151](#adr-151) · `models/runtime/findings.py`, `models/runtime/results.py`, `runtime/findings/shrinker.py`, `runtime/findings/assembler.py`, `runtime/fuzzers/stateless/shrinking.py`; core `services/persistence/`, `services/report/constants.py`, `services/finding_summary/render.py`, `services/finding_summary/sentences/security.py`

### Context

A refuted finding was only counted, in `findings_refuted`
([ADR-151](#adr-151)). A whole-request rejection can now be refuted as a conflict
with stored state ([ADR-166](runners.md#adr-166)), and that refutation can be wrong
in one narrow case: a server with one generic body for every rejection. A count
gives the reader nothing to check. The same holds for a `mass_assignment` or
`input_induced_timeout` finding its control refuted.

### Decision

**`refuted` is a finding state.** `FindingState.REFUTED` joins the closed union as
`RefutedFinding(signature, occurrences, first_seen, control)`; the control is
required, since it is the evidence. The shrinker emits one per signature group
that had a refuting control, carrying the first one, and `findings_refuted` stays
the sum of their occurrences.

**The control is what refuted it.** For a whole-request rejection it is the request
that was **accepted**, not the resend that was rejected, which would contradict the
verdict. For `mass_assignment` it is the request without the smuggled key that
echoed it all the same; for `input_induced_timeout`, the valid request that timed
out too.

**A refuted group whose signature another member confirmed is kept.** Mixed
evidence is exactly what a reader must see.

**The core lists it and says why.** The core persists the state and its control
(the state column is free text, so no migration), reads them back in `get_run` and
`get_finding`, and the report lists the finding in `unconfirmed_findings` with
`state` `refuted`, its `control`, and a summary ending *"refuted: its control
request showed it is not a defect"*. The report's explanation of the state says a
refutation can be wrong and points at the control. The mass-assignment sentence of
a refuted finding says the response without the key echoed it too. Protocol
`0.1.23` adds `refuted` to `finding_states`; the report is `schema_version` 1.23.

### Rejected

- **Counting only.** It leaves nothing to check a refutation against. The concern
  that made [ADR-151](#adr-151) count only, that the entry would read as a defect,
  is met by where it is listed: among the unconfirmed findings, never in
  `defects`, labelled refuted.
- **Dropping a refuted group whose signature is also confirmed.** It hides the
  evidence that disagrees.

### Consequences

A client that branches on `state` sees a fourth value; the protocol change is
additive. `compare_runs` still diffs confirmed defects only, and a refuted finding
is never announced as `FindingObserved`.

---

## ADR-176 — A value violates its contract only when the engine can prove it: patterns read as ECMA-262 under a deterministic work budget, formats only where the checker decides { #adr-176 }

**Status:** accepted · Supersedes in part [ADR-118](engine.md#adr-118), [ADR-143](engine.md#adr-143) · `shared/violation.py`, `shared/ecma_pattern.py`, `shared/shape_check.py`, `shared/schema_check.py`, `models/schema.py`, `constants.py`, `runtime/oracles/input_validation.py`

### Context

`validate_value` leaves `pattern`, `format`, `uniqueItems` and the property counts
unchecked, so an oracle built on it alone never reports a server that accepts a
malformed date or a text outside a declared pattern. Judging those keywords
naively produces false findings. Python's `re` reads several ECMA constructs
differently (`\s`, `$`, `\Z`, backreferences, inline flags). An older draft's
format checker reads `time` without its offset. The checker rejects valid RFC 3339
texts (the year `0000`, a leap second). A catastrophic pattern can hang the run,
and a timeout makes the verdict depend on the machine. A false "violates" is a
false finding.

### Decision

**One predicate that only says "violates" with proof.**
`first_provable_violation(value, contract)` returns the first place the value
breaks its contract, or `None`. It decides everything `validate_value` decides, a
required field left out, `uniqueItems`, `minProperties`, `maxProperties`, a
`pattern` and a `format`. It shares the structural walk of the conformance check
(`first_shape_mismatch`) and differs only in its `ShapePolicy`: what the engine
cannot decide does not violate. The pattern is a Specification with a
parameterised verdict.

**Patterns as ECMA-262.** `ecma_match` returns `MATCHES`, `MISSES` or
`UNDECIDABLE`, and only `MISSES` proves a violation.

- One compilation with `re.ASCII`, so `\d`, `\w` and `\b` mean what ECMA means
  without `u`; `\s`, `\S`, `.` and `$` rewritten to ECMA's meaning outside a class.
- A guard of undecidable constructs before compiling: an escaped letter ECMA does
  not define, a backreference, `{,n}`, a possessive quantifier, `[]` or `[^]`,
  `\S` in a class, a surrogate escape, an inline flag group, and a text above
  U+FFFF.
- Two deterministic guards against backtracking: a star height of two or more is
  undecidable, and so is a text whose work, the product of each quantifier's
  reach over the text times the start positions, passes `MAX_PATTERN_WORK`
  (1 000 000).

**Formats only where the checker decides.** `DecidableFormat` names `email`,
`uuid`, `date`, `date-time`, `time`, `ipv4`, `ipv6`, `hostname`, `uri` and
`uri-reference`; the checker is `Draft202012Validator.FORMAT_CHECKER`. A test
requires every member to have a checker in the installed environment. The year
`0000` and a leap second are undecidable for the date and time formats. Every other
format never violates.

**Conformance reads the same dialect.** `contract_completeness` reads a pattern as
ECMA-262 too (an undecidable one does not show conformance) and formats with the
2020-12 checker, so a `time` needs its offset and a format the checker does not
know never shows conformance.

### Rejected

- **A regex timeout.** The verdict would depend on the machine, and a replay could
  judge a finding differently from the run that found it.
- **Compiling twice, with and without `re.UNICODE`, and requiring both to miss.**
  It is not sound with mixed classes (`^\s\W$` against `" é"`).
- **A regex dependency with ECMA semantics.** The guards close the dialect gap with
  the standard library; a new dependency would ship for one predicate.
- **A field `keyword` on the observation.** The keyword already travels as the key
  of `expected`; a new field changes three DTOs and the protocol.

### Consequences

A 2xx that accepts a value outside its declared `pattern` or `format` is an
`input_validation` finding with `expected: {"pattern": …}` or `{"format": …}`,
also when the value came from an attack payload or a boundary filler. Some
patterns are never judged (`(foo|bar)*`, any backreference), on purpose. On the
measured targets these findings appear only where a server does not validate the
format; the lab API's `email` field, which the server checks, yields none.

---

## ADR-177 — A violation reads a text as leniently as a server does, conformance reads it strictly, and the observation cites the text sent { #adr-177 }

**Status:** accepted · Supersedes in part [ADR-117](compiler.md#adr-117), [ADR-118](engine.md#adr-118) · `shared/wire/carried.py`, `shared/wire/texts.py`, `shared/wire/spelling.py`, `models/wire.py`, `runtime/oracles/sent_value.py`, `runtime/oracles/input_validation.py`, `runtime/http/injector.py`

### Context

Read through the strict literals ([ADR-117](compiler.md#adr-117)), `"1"` or
`"yes"` sent for a boolean, or `"+4"` for an integer, stays text and fails the
type, so a 2xx to it is an `input_validation` finding. A lenient server reads those
texts as the declared type and accepts them correctly: the finding is not proven.
An oracle that reads a field differently from how the injector sends it errs the
same way: a form field drawn `None` is not sent, a form array is sent item by item,
a path boolean is sent as the query spells it. Each gap is a false finding or a
lost one.

### Decision

**One reader of a value as it travels, shared by every judge.** `shared/wire/`
mirrors the injector zone by zone (`sent_on_wire`): the texts a path, query,
header or form field carried, or a JSON body's value. A query, header or form
field drawn `None` is absent (`is_omitted_field`, the one rule the injector uses
too). A header is read without the whitespace HTTP strips around it.

**The texts are read as the declared type.** An array reads each text as an item;
a scalar reads its one text. Several texts for a scalar, an object on a text wire,
an array of composites on one, and an array in a path or header are
`UNREADABLE`, which proves nothing.

**Three readings, by purpose.** `TextReading.LENIENT` (the widest common server
reading) for a violation, `STRICT` (the wire literals) for conformance, `AS_SENT`
for the citation. A text some lenient server reads as the type does not violate
the type; its other keywords are judged on the value read. The observation's
`observed` is the text sent (`"+4"`), so a reader sees what went out.

The separation is the one between the two policies of the predicate
([ADR-176](#adr-176)): a violation is proven against the most forgiving reading, a
conformance against the strictest.

### Rejected

- **Strict for both.** `"1"` for a boolean becomes a proven violation that a
  lenient server never committed.
- **Lenient for both.** A request holding `" 7"` for an integer would count as
  conforming, and a 400 to it would blame the contract.
- **Citing the value read.** A reader of `observed: 4` cannot tell that `"+4"`
  went out.

### Consequences

The generator, the injector and the oracle agree on every zone. Every
`input_validation` finding on a text wire is proven against a lenient server; a
form `None` is a missing field, and a form or query array is judged item by item.
Arrays and objects on a text wire are never judged by `input_validation`, though
their requests still reach the robustness and security oracles.

---

## ADR-182 — A finding whose control got an answer that cannot judge it is left unverified { #adr-182 }

**Status:** accepted · Supersedes in part [ADR-151](#adr-151) · `runtime/fuzzers/stateless/control_checks.py`, `runtime/fuzzers/stateless/control_verdict.py`, `runtime/fuzzers/stateless/control_payloads.py`, `models/runtime/results.py`; core `services/finding_summary/sentences/security.py`

### Context

An answered control that does not show the finding's signal can fail to show it
for reasons unrelated to the finding. A mass-assignment control rejected with a
409 for a uniqueness conflict echoes nothing, a 204 has no body to echo in, and a
503 to a whole-request control is no rejection of the same kind. Counting each of
those as a confirmation confirms a finding the control never judged
([ADR-151](#adr-151) only set aside a control that got no answer). With
mass-assignment keys injected inside every object, and common sentinels (`admin`,
`true`), the exposure grows.

### Decision

**Each control declares which answers can judge its finding.**
`ControlCheck.judges(reproduction, control)` is a field of the check, not a
cascade in the shrink:

| Invariant | An answer judges when it is |
| --- | --- |
| `mass_assignment` | a 2xx whose body holds an object an echo could be found in |
| `input_induced_timeout` | a 2xx, or a timeout |
| `contract_completeness` (rule `request`) | a 2xx, or a 4xx with the reproduction's own status |

**The verdict asks `judges` first.** A judgeable answer refutes when it shows the
signal and confirms when it does not. An answer that cannot judge leaves the
finding `unverified`, with the control as its evidence; no answer at all does the
same. A resent whole-request control passes the same test, so a 503 to the resend
leaves the finding unverified. The internal verdict `CONTROL_REJECTED` sits
beside `CONTROL_UNANSWERED`; neither travels on the protocol.

**The mass-assignment control varies what can collide.** Its payload rotates the
open strings it does not take from the run's corpus, so a uniqueness rule does not
reject it.

The core's summary says why: "the request was not accepted" or "the response held
nothing to echo", with the control's status.

### Rejected

- **Confirming on any answer without the signal.** A rejection says nothing about
  the echo.
- **Refuting on a rejected control.** A rejection is no evidence the finding is
  false either.
- **One acceptance rule for every control.** A timeout control and an echo control
  are judged by different answers.

### Consequences

A finding is confirmed only by a control that could have refuted it. On the
measured targets no finding is left unverified this way; the rule matters on
servers that reject a replayed request by state. A timeout streak's
infrastructure check is not a finding's control and keeps its own rule.

---

## ADR-186 — A rejection is confirmed only against a value the run shows free { #adr-186 }

**Status:** accepted · Extended by [ADR-211](#adr-211) · Supersedes in part [ADR-166](runners.md#adr-166), [ADR-183](runners.md#adr-183) · `runtime/http/accepted_values.py`, `runtime/fuzzers/stateless/free_controls.py`, `runtime/fuzzers/stateless/sibling_verdict.py`, `runtime/fuzzers/stateless/control_verdict.py`

### Context

A control that rotates a string assumes the rotation is a value the server has never
seen. During a run that assumption fails: the fuzzer stores values, a short string
rotates onto one already taken, and a rejection for a unique field reads exactly like
a rule. A confirmation resting on that control reports a rule the server does not
have. The target knows which values it holds, but the run can only see what it was
told.

### Decision

**The run records what the target accepted, and a control reads it.**
`AcceptedValues` keeps, per endpoint, each 2xx to an unsafe method: the request by
caller, and each body and query scalar by field. A control that vouches for a
rejection sends only values that record does not hold. A full record treats every
value as taken.

**The same request accepted earlier refutes without a send** (`source` `earlier`).

**With no free control, a sibling judges.** The sibling changes every movable value
and is judged only if accepted: a rejection it gets is no evidence either way, and
running out of tries leaves the finding `unverified`.

**A rotated named value tells content from occupancy.** When a sibling is accepted and
the rejection names fields, each named value is rotated alone. Rejected alike every
time, the rule reads the value's content.

**A vouching control needs the run behind it.** A rejection stays `unverified` when the
run never saw this caller accepted, or when the response shows a store refusing a write.

**The same test scopes a leak.** A leak moves from a field to the whole request only
against a rest of free values ([Information disclosure](../disclosure.md#scope)).

### Rejected

- **Rotating harder and trusting the result.** More characters make a collision less
  likely, and leave the verdict unproven.
- **Confirming on the reproduced rejection when nothing can be sent.** A finding with
  no control has not been judged.
- **Refuting whenever a sibling is accepted.** One acceptance does not show the
  rejection depended on state; a value's content can differ between the two.

### Consequences

A control can spend up to `CONTROL_SEND_CAP` (10) requests, inside the shrink's wall.
More findings on stateful targets end `unverified`, which is the honest answer when
nothing could judge them. "Free" is only as wide as the run: a value stored by an
earlier run reads as free, and a quota that fills mid-run can still confirm
([Known limits](../control-requests.md#known-limits)).

---

## ADR-192 — An intrinsic verdict is its own evidence; a verdict that judges needs a control { #adr-192 }

**Status:** accepted · Extended by [ADR-210](#adr-210) · `runtime/runners/performance/runner.py`, `runtime/runners/shrink_phase.py`, `runtime/runners/auth/runner.py`, `runtime/findings/stats.py`, `models/runtime/taxonomy.py`

### Context

Every runner runs the whole oracle chain on what it sends, but not every runner
controls what each oracle reports. Some verdicts need nothing beyond the
observation: a latency measured, a 5xx or a dropped connection, a caller the policy
excludes getting a 2xx. Others judge the answer against the contract (a schema, a
status code, a rejection) and can be wrong for reasons a single observation does
not rule out. Under load, a `performance` run meets both; an `auth` crossing
controls access, its own question, and nothing the contract states.

### Decision

**An intrinsic verdict is reported as observed.** In `performance`, a
`latency_sla` or `latency_degradation` finding, and a crash (`CRASH_INVARIANTS`:
`not_a_server_error`, `resilience_degradation`), are materialized without a
shrink. A degradation is measured twice before it is reported; a crash seen under
load is not refuted by an unloaded re-send that does not reproduce it. In `auth`, an
`access_control` finding, whose control is the crossing itself, and a crash are
confirmed.

**A verdict that judges needs a control.** In `performance`, every finding judged
against the contract goes through the shrink phase stateless uses, in a shared
module (`shrink_phase.py`): re-send, minimize, control. It can end `flaky`,
`refuted` or `unverified`. In `auth`, which has no such control, it is an
`UnverifiedFinding`, counted in `findings_unverified`.

### Rejected

- **Shrinking latency findings.** A latency sample re-sent alone measures another
  load; the reproducer would not be the evidence.
- **Shrinking crashes found under load.** The re-send runs without the load that
  provoked the crash, and would turn a real crash `flaky`.
- **Dropping contract findings from `auth`.** They are real observations; the run
  only lacks the control to confirm them.

### Consequences

A `performance` run spends shrink requests on its contract findings, counted in
`requests_shrink`. An `auth` report may list unverified findings beside its
confirmed access breaches and crashes.

---

## ADR-202 — A finding that stands on a rule the model assumed is an LLM suspicion, never a defect { #adr-202 }

**Status:** accepted · Builds on [ADR-201](../../core/adr/inference.md#adr-201) · `models/runtime/grounds.py`, `models/runtime/taxonomy.py`, `models/runtime/crash_report.py`, `models/runtime/findings.py`, `models/runtime/events.py`, `runtime/oracles/grounds.py`, `runtime/findings/standing.py`, `runtime/findings/stats.py`, `runtime/fuzzers/stateless/folding.py`; core `services/report/builder/entry.py`, `services/report/grounds_text.py`, `services/compare/service.py`, `controllers/finding_code.py`

### Context

A producer's contract gives rules the specification does not declare, and each
rule now says what it rests on ([ADR-201](../../core/adr/inference.md#adr-201)): a
quote found in the code or the operation, or the model's assumption. A server
that breaks a stated rule breaks its own code's promise. A server that breaks an
assumed rule may be wrong, or the model may be: a minimum of one on a quantity
the API lets be zero is the model's guess, not the API's defect. Counting both as
defects makes a run with a model look worse than the same run without one, for
reasons no one can check, and turns a clean signal into a list of guesses.

### Decision

**The engine settles each reproduced finding by the grounds of the rule it
cites.** Every verdict that cites a producer's rule carries that rule's grounds,
read by the invariant broken: the inferred keyword the poisoned value broke, the
business rule the verdict names, the seed case's expectation, or the access
policy, unless the specification's own security already requires a credential.
A finding of an invariant that stands on the very rule it cites
(`rests_on_its_rule`: `input_validation`, `contract_completeness`,
`semantic_property`, `expected_rejection`, `expected_acceptance`, `access_control`)
whose rule's `basis` is `assumed` settles as `LlmSuspicionFinding`, state
`llm_suspicion`. Every other reproduced finding settles `confirmed`, as before: a
rule the specification declares, a stated rule, or one no producer grounded.

**A suspicion is reported apart and counted apart.** `findings_llm_suspicions`
counts them after deduplication, like `findings_unique`, in the run and per
endpoint; they never enter `findings_confirmed`,
`findings_unique` or the run's signal, so a run whose only findings are
suspicions is `clean`. The report document lists them in `llm_suspicions`,
shaped like `defects`; a finding in `get_run` and `get_finding` has `kind`
`llm_suspicion`; the `finding` event carries `state`; `compare_runs` matches them
in `llm_suspicion_changes`, apart from `changes`.

**A suspicion is reproduced like a defect.** It went through the same shrink,
re-send and control. The only difference is the standing of its rule, so a
reader judges one rule, not the server's behaviour.

**A downgraded rule is a suspicion.** A rule the model called stated without a
quote found is `assumed` (`grounds.downgraded`), and its findings are
suspicions.

**A finding absorbs another only when it stands at least as firm.** Where one
invariant subsumes another on the same response (a broken rule over a seed case's
expected rejection, a case's expected acceptance over a rejected valid request),
the subsuming finding hides the other unless it rests on an assumed rule and the
other does not. A suspicion never hides a defect: one response can
give both, and both are reported. Resting on an assumed rule has one definition
(`rests_on_an_assumed_rule`), shared by the settlement and the absorption.

### Rejected

- **Dropping findings against assumed rules.** The rules worth assuming are the
  ones no source declares; a server that accepts a negative quantity is often a
  real bug, and only a person can tell.
- **A lower severity instead of a separate state.** A low defect still counts as
  a defect and still degrades the signal; the question a reader answers is not
  how serious it is but whether the rule holds.
- **Settling in the core.** The engine knows which rule a verdict cites; the core
  would have to re-derive it from the observation.

### Consequences

A run with a producer reports fewer defects and a separate list of suspicions,
each with the quote-less rule it stands on. A client before protocol `0.2.6`
does not see `llm_suspicions` and, through the `finding` event, shows a
suspicion live as a finding while the run's document keeps it out of `defects`.
A replay judges no suspicion: against a replay, every suspicion that is not
`new` is `inconclusive`.

---

## ADR-203 — A seed case is judged against the outcome it expects, only when it was sent whole and does not contradict its own contract { #adr-203 }

**Status:** accepted · `models/contracts` (kernel `specforge_contracts.seed`), `models/runtime/invariant.py`, `models/runtime/taxonomy.py`, `models/runtime/intent.py`, `models/runtime/contract_usage.py`, `runtime/oracles/case_expectation.py`, `runtime/oracles/precedence.py`, `runtime/fuzzers/stateless/seed_sends.py`, `runtime/fuzzers/stateless/seed_contradictions.py`, `runtime/fuzzers/stateless/control_judgement.py`, `runtime/oracles/semantic/declared.py`

### Context

A field's `examples` seed one value at a time. Handlers branch on combinations:
a discount above the subtotal, a loan whose installments exceed its term, a
coupon valid only for one country. A producer that reads the handler can name
those combinations as whole requests, and often knows what the server should do
with each. Drawing values never meets most of them, and a case sent without its
expectation is judged only by the generic oracles.

### Decision

**A contract carries seed cases.** Each has an `id`, a `description` for the
reader, `values` (each field's value, a body field by its dotted path) and an
optional `expects`, `rejected` or `accepted`, with its own grounds. An endpoint
carries at most `MAX_SEED_CASES` (20).

**Every case is sent once per identity, as given, before any draw.** The valid pass of
`stateless` and of `performance`'s `flat` variant sends each case on the
simplest valid request, its values written in. Its request is marked
`origin` `seeded` with the case's id and description. A value for a path
parameter is dropped when the contract is adopted: a path names a stored
resource, never a seeded value.

**Two invariants judge the expectation.** `expected_rejection`: the case expects
rejection and the server answered 2xx. `expected_acceptance`: it expects
acceptance and the server answered 400 or 422. Both are of category `business_rule`,
severity `medium`, with the case's id as `rule_id`. A 5xx stays a `not_a_server_error`
finding; any other answer is not judged.

**A case is judged only when it is what it says.** It is sent unjudged
(`unjudged_because`) when one of its values could not be sent, declared nowhere,
of another type or with no place to land (`value_left_out`), or when it expects
acceptance of a value its own field's contract provably forbids, a text past its
`maxLength` or a value outside its `enum` (`forbidden_acceptance`). Such a case
is still sent, so a server error it provokes is still a finding. A case
expecting rejection is judged whatever its values break.

**A rule outranks a case on the same response.** `input_validation` and
`semantic_property` subsume `expected_rejection`: when the response that accepted a
case also breaks an input rule or a business rule, only that rule's finding is
reported. `expected_acceptance` subsumes `contract_completeness`: the case states
the stronger claim about the same rejection. Either absorption holds only when the
absorbing finding stands at least as firm ([ADR-202](#adr-202)): a suspicion never
hides a defect.

**A case expecting acceptance is judged only on a rejection of its own values.**
A 400 or 422 that names only a field the case leaves free, or that refuses what the
store already holds, is not the case's finding: it is judged as the rejection of a
request sent as declared (`contract_completeness`), with that finding's controls.
When the reproduced rejection refuses values the run had already seen accepted at
the endpoint, the store may now hold them, and the finding is left unverified
rather than confirmed.

### Rejected

- **Judging every case sent.** A case with a value left out is another request;
  judging it against the whole case's expectation blames the server for a
  request nobody wrote.
- **Dropping a self-contradicting case.** It still exercises the handler, and a
  server error on it is a defect whatever the case expects.
- **Sending cases as draws.** A case drawn now and then may never be sent in a
  short run; one send per case is cheap and certain.

### Consequences

A run with a producer reports `expected_*` findings beside the rule findings, and
an expectation the model assumed settles as an LLM suspicion
([ADR-202](#adr-202)). The cases are sent on top of the strategy's budget
([ADR-204](measurement.md#adr-204)), and each one's use is in the endpoint's
contract account, `judged_against_expects` saying whether it was judged.

---

## ADR-210 — A latency finding shows the payload slow most often, and its request is re-sent alone to say whether it is slow by itself { #adr-210 }

**Status:** accepted · Extends [ADR-192](#adr-192) · `runtime/findings/representative.py`, `runtime/runners/performance/latency_control.py`, `runtime/runners/performance/constants.py`, `runtime/runners/performance/runner.py`, `runtime/fuzzers/stateless/shrinking.py`, `models/runtime/evidence.py`, `models/runtime/observation.py`

### Context

A `latency_sla` finding groups every slow sample of one endpoint. Its report
showed the first one seen, which under a ramp of load is often an ordinary
request that happened to queue. A reader could not tell whether the request is
slow because of what it carries or only because the server was busy, and the
two call for different fixes: an index or a query plan, against capacity.

[ADR-192](#adr-192) keeps a latency finding unshrunk: a sample re-sent alone
measures another load, so it cannot refute the finding. It can still describe it.

### Decision

**The report shows the payload slow most often.** Among the group's slow
samples, the payload sent most often is the representative; on a tie, the one
with the slowest sample, then the first seen.

**Its request is re-sent alone once the load is over.** `LATENCY_CONTROL_SAMPLES`
(3) times, one after another. The finding's `control` holds the median as
`latency_ms` and every send's latency, in order, as `latency_samples_ms`. When
every send came back clean and the median is within `latency_sla_ms`, the
observation's marker is `slow_only_under_load`; without it, the request is slow
by itself.

**The finding stays confirmed either way.** The sends describe the finding; they
do not judge it. Its `control` is `null` when the run was halted or the sends
were cut short.

### Rejected

- **Refuting a finding that is fast alone.** The SLA was breached under the load
  the run was asked to apply; that is the finding.
- **The slowest sample as the representative.** One outlier is the least
  representative sample of a group.
- **One send alone.** A single latency is as noisy as the sample it explains; the
  median of three is the cheapest number that is not.

### Consequences

A `performance` run sends three more requests per latency finding, after the
load. A reader of the finding sees whether to look at the request or at the
capacity, and a client shows each latency of `latency_samples_ms`.

---

## ADR-211 — A finding stays on the keyword its request first broke, a rejection worded for another field is not this field's, and an accepted write is confirmed on fresh strings { #adr-211 }

**Status:** accepted · Supersedes in part [ADR-150](#adr-150) · Extends [ADR-186](#adr-186) · `runtime/findings/broken_keyword.py`, `runtime/findings/grouper.py`, `runtime/findings/shrinker.py`, `runtime/oracles/rejection_attribution.py`, `runtime/oracles/contract_completeness.py`, `runtime/fuzzers/stateless/enforcement.py`, `runtime/fuzzers/stateless/control_verdict.py`, `runtime/fuzzers/stateless/untaken_resend.py`, `runtime/oracles/inferred_rule.py`, `runtime/oracles/input_validation.py`, `runtime/fuzzers/stateless/constants.py`, `models/runtime/observation.py`

### Context

Grounds made the identity of a finding's rule matter: one field can carry a
stated `maximum` and an assumed `minimum`, and a finding settles by the grounds
of the one it breaks ([ADR-202](#adr-202)). Four ways of confirming a finding
could move it to the wrong rule, or to no rule at all:

- A breach of one keyword could shrink onto a value breaking another keyword of
  the same field, and settle by that keyword's grounds: a stated maximum ended
  as a suspicion of an assumed minimum.
- A rejection message in free text that named another field was read as the
  poisoned field's rule being enforced.
- A server that accepts the value under test but rejects others breaking the
  same rule enforces the rule in part; the control that accepted the value
  refuted the finding.
- A write the target accepted, re-sent to confirm it, could be refused only
  because the first send had taken its unique strings.

### Decision

**The broken keyword tells two violations of one field apart.** For
`input_validation` and `contract_completeness`, the pre-shrink grouping, the
shrink and the materialized report key a finding by the inferred keyword its
request breaks, so a shrink never crosses from one keyword to another. A control
still judges a rejection by its rule alone.

**A rejection worded for another field is that field's.** A 400 or 422 whose
message spells, as a whole word, a declared field off the poisoned branch and
none on it does not confirm that the server enforces the poisoned field's rule.

**An accepted value is tried against the rest of its rule.** When the control
accepts a value only an inferred rule forbids, up to `ENFORCEMENT_WITNESSES` (3)
other values breaking part of the same rule go in the same plain request. One
rejected as invalid confirms the finding, marked `partly_enforced_rule`. Every
one accepted marks it `unenforced_inferred_rule`: refuted when the rule has no
grounds, as before, and reproduced when it has them, so it stands as its grounds
say, `confirmed` for a stated rule and an LLM suspicion for an assumed one. Any
other answer leaves it unverified.

**An accepted write is re-sent on fresh strings when its value is now taken.**
When confirming a finding the target accepted, a re-sent write refused as taken
(a `409`, or a store refusing what it holds) goes once more, its free strings
rotated to values the run never saw accepted, the first of `UNTAKEN_ROTATIONS`
(64) candidate rotations that qualifies. The value under test, a seed case's
values and the values from the run's corpus stay as sent. The one re-send serves
the reproduction, the shrink and the report.

**A value breaking several inferred keywords rests on the firmest.** When the
first keyword the validator reports for a field rests on an assumption, the finding
cites the first broken keyword the producer did not assume. Its grounds, the
keyword that tells it apart and its observation all name that keyword, so a text
past a stated `maxLength` that also breaks an assumed `pattern` is a defect on the
`maxLength`.

### Rejected

- **Keying by the field alone.** It is the cause of the cross-keyword shrink: the
  two keywords are two rules with two grounds.
- **Refuting a partly enforced rule.** The server applies the rule elsewhere;
  accepting this value is the defect.
- **Retrying a taken write with the same strings.** It is refused for the same
  reason, and the finding would read flaky for a cause the run itself created.

### Consequences

More `input_validation` findings are confirmed, marked `partly_enforced_rule`,
where they were refuted. A field with two inferred keywords can carry one
finding per keyword. Confirming a write can cost one more request.
