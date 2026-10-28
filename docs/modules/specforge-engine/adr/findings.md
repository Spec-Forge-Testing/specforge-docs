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

**Status:** accepted · `models/runtime/findings.py`, `runtime/findings/grouper.py`, `runtime/findings/shrinker.py`, `runtime/findings/causes/walk.py`, `runtime/findings/causes/triggers.py`, `runtime/findings/constants.py`

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
format; BugBank's `email` field, which the server checks, yields none.

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
