# Spec Forge Engine — Decision records — Findings

Part of the [Spec Forge Engine decision records](index.md). Decisions about what a
finding is: how it is classified, what it records about the breach, how two
findings are told apart, when a control request rules one out, and what is
withheld from its evidence. The behaviour is described in
[Findings: taxonomy and evidence](../findings.md).

---

## ADR-148 — One registry in the engine classifies every invariant, and the core derives the classification when it reads { #adr-148 }

**Status:** accepted · Supersedes in part [ADR-125](../../core/adr/core.md#adr-125), [ADR-139](../../core/adr/core.md#adr-139) · `models/runtime/taxonomy.py`, `models/runtime/vocabulary.py`, `models/runtime/crash_report.py`; core `services/deps/engine_vocabulary.py`, `services/catalog/vocabulary.py`, `services/report/ordering.py`

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
in `models/runtime/vocabulary.py`.

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

**Status:** accepted · `models/runtime/findings.py`, `runtime/findings/grouper.py`, `runtime/findings/shrinker.py`, `runtime/findings/cause_walk.py`, `runtime/findings/causes.py`, `runtime/findings/constants.py`

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
`hacker` cell spent 19 % (median) to 31 % (mean) more shrink requests and 4 % more
wall time, for two or three more reports per run, every planted bug still found in
all repetitions. Most of that cost is the poisoned field in the signature: more
`attack` groups, each with its shrink. Restricting the walk to unpoisoned groups,
and halving the second shrink's budget, are what keep the walk itself cheap.

---

## ADR-151 — A finding its control request refutes is counted apart from a flaky one, and a control that gets no answer leaves it unverified { #adr-151 }

**Status:** accepted · Supersedes in part [ADR-138](engine.md#adr-138) · `models/runtime/results.py`, `models/runtime/stats.py`, `runtime/fuzzers/stateless/shrinking.py`, `runtime/fuzzers/stateless/control.py`, `runtime/fuzzers/stateless/timeout_control.py`, `runtime/findings/shrinker.py`

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

**Status:** accepted · Supersedes in part [ADR-060](engine.md#adr-060), [ADR-103](engine.md#adr-103) · `shared/sensitive_names.py`, `runtime/findings/finding_redaction.py`, `runtime/findings/exchanged_slots.py`, `runtime/findings/redaction.py`, `runtime/findings/evidence_url.py`, `runtime/findings/materializer.py`, `runtime/oracles/security/sensitive_data.py`

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
