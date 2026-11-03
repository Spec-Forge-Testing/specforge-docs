# Witnesses of inferred rules

A produced contract can declare a rule the spec leaves out: a `minLength` the code
applies, a `maximum` it checks. Every valid draw then obeys the rule, so without a
dedicated request the rule would never be crossed in a valid pass. A **witness** is
that request: the pass's simplest payload with one field at a value the spec takes
and only the inferred rule forbids. This page covers how a witness is built, its
limits and what it reports. The code is `strategy_compiler/witness_values.py` and
`runtime/fuzzers/stateless/witnesses.py`.

## Where it runs

A stateless valid pass sends its minimal request, then one witness per inferred
keyword. They go a round at a time: each field that infers a keyword, in (zone,
path) order, sends its next witness before any field sends a second, so one
field's keywords never crowd out another field's first. Witnesses are part of the
valid pass, so every strategy sends them, `smoke` and `exposure` included. Without
a produced contract no field infers anything and there are none.

They count inside the pass's share and go first, each looked for only once the
pass asks for it. A share smaller than the witnesses sends the first ones it fits,
and each field whose tries the share never reached is logged as a lost witness, a
warning of the `specforge_engine` logger that the core writes to its stderr.
A witness is marked `RequestOrigin.WITNESS` in its request intent. It is already
the simplest value its rule allows, so the shrink does not search it and goes
straight to re-sending it and judging its control.

## The value of a witness

Most keywords derive the nearest value past the rule's edge, with nothing to search.
A derived value that fails the check is discarded and the next one is tried.

| Inferred keyword | Values tried | Without a witness when |
| --- | --- | --- |
| `minLength` *n* | *n − 1* filler characters, then `""` | *n* is 0 or less |
| `maxLength` *n* | *n + 1* filler characters | the spec's bound is as tight, or the length passes the limit |
| `maximum`, `minimum` | The next step past the edge, plus the next double when any number fits | the arithmetic overflows |
| `exclusiveMaximum`, `exclusiveMinimum` | The edge itself when any number fits, else the next step past it | the arithmetic overflows |
| `minItems` *n* | An array of *n − 1* | *n* is not above the spec's bound, or the size passes the limit |
| `maxItems` *n* | An array of *n + 1* | the spec's bound is as tight, or the size passes the limit |
| Any other (`pattern`, `format`, ...) | A search among the `boundary` phase's poison candidates | nothing found within the search bound |

When `minLength`'s *n − 1* passes the limit, only `""` is tried. An array repeats one
drawn element, unless `uniqueItems` requires each to be drawn. On a text wire, an
element the wire would read as left out is replaced by a simple non-empty one.

## Limits { #limits }

A value past a limit is never trimmed. The field simply has no witness, since a
trimmed value would not break the rule it is there to test.

| Constant | Value | Bounds |
| --- | --- | --- |
| `MAX_WITNESS_ARRAY_SIZE` | 64 | Elements in a derived array |
| `MAX_WITNESS_TEXT_LENGTH` | 1024 | Characters in a path, query or header value, below HTTP line limits, so a transport's 400 is never read as the rule's |
| `MAX_WITNESS_BODY_TEXT_LENGTH` | 65536 | Characters in a body value |
| `MAX_WITNESS_UNIQUE_WEIGHT` | 128 | An array with `uniqueItems`: its size times the leaves one element can send. An element holding an array with no `maxItems` is past it |
| `WITNESS_SEARCH_EXAMPLES` | 64 | Candidates one search judges, shrink included |
| `WITNESS_ELEMENT_EXAMPLES` | 16 | Draws that settle the element replacing an empty text |
| `WITNESS_WALL_BUDGET_S` | 5 s | Searching across one endpoint's plan; derived values are never cut |

A witness is sent only if the request meets the spec's view of every field and only
an inferred rule forbids the value. A field the minimal payload holds no place for
goes on a draw that holds it, which later fields reuse.

## What it reports

| The server | Finding | How it is judged |
| --- | --- | --- |
| Rejects it (400, 422) | `contract_completeness` with marker `inferred_rule` | [Plain request](control-requests.md#inferred-rule) |
| Rejects it with a database error in the body | `contract_completeness` with marker `inferred_rule_database_error` | [Plain request](control-requests.md#inferred-rule) |
| Accepts it | `input_validation` | [Plain request](control-requests.md#inferred-rule) |

The `inferred_rule` finding says the server enforces a rule only the produced
contract declares, so the spec should declare it too. Its observation holds the
keyword in `expected`, the value in `observed` and the field in `location`. Its
`rule_id` is the field's path without array indexes, the id a rejection naming that
field gets. A rejection naming a field on another branch reports nothing here.

A rejection whose body shows a database error outside the echo of what was sent
gets the marker
`inferred_rule_database_error` instead. The finding and its rule are the same; its
summary says the error does not show the server applies the rule, since a store
failing on a value is not a rule refusing it. A database error is any
[disclosure marker](disclosure.md#markers) of the SQL, Mongo or ORM rows but
`sql_statement`: a statement alone may be a validation message quoting what it
refuses.

!!! note "Two findings of one rule"
    A witness and the `boundary` draw that crosses the same rule are two findings
    with the same `rule_id`. A defect is told apart by its reproducer, not its rule,
    and the two send different values.

**The rule the finding names is the produced contract's.** The observation's
`expected` carries the inferred keyword and its value, and the control judges
whether the server rejects the value for that field, not where its own edge lies.
When the server applies another bound (the contract infers `maxLength: 10`, the
server cuts at 50), a value past both is rejected, the attribution's valid value and
the [known answer](control-requests.md#known-answer) are accepted, and the finding is confirmed citing `maxLength: 10`. Read the value as
the produced contract's claim, confirmed in direction, not in size.

**One field can carry several `contract_completeness` findings.** With a produced
contract, a rejection that blames the field on an unpoisoned request and a rejection
of a poisoned value only the inferred rule forbids are two assertions, with two
signatures; and findings are signed per phase, so the same rejection seen in two
phases is two findings. They point at one gap in the spec, with separate evidence.

## Stateful runs { #stateful }

A stateful step sends a witness in place of its valid draw in one step out of ten
(`VALID_STEPS_PER_WITNESS_STEP`, 9 valid draws to 1), so the machine still builds
the state its sequences need. The witnesses are the same ones a stateless pass
finds, looked for once per endpoint and run on the endpoint's simplest valid
draw:

- A witness whose field a consumed pool value would overwrite is never sent.
- Once a confirmed defect of the endpoint sent a witness's value at its field, the
  witness is no longer drawn there. Another endpoint sending the same value keeps
  its own witness, so it can report its own defect.
- A step that sent a witness is judged like any other, and its finding by the
  same [plain request](control-requests.md#inferred-rule) after its minimal
  sequence is re-sent.

## Where to change it

| To change | Edit |
| --- | --- |
| The limits | `strategy_compiler/constants.py`, `runtime/fuzzers/stateless/constants.py` |
| The value derived for a keyword | `_EXACT_DERIVATIONS`, `_SIZED_DERIVATIONS` in `witness_values.py` |
| When a request counts as a witness | `witnesses_an_inferred_rule` in `runtime/oracles/inferred_rule.py` |
| How often a stateful step sends one | `VALID_STEPS_PER_WITNESS_STEP` in `runtime/fuzzers/stateful/constants.py` |
| Which body errors mark a database error | `_DATABASE_ERROR_MARKERS` in `runtime/oracles/security/disclosure_markers.py` |

### Adding a derivation for a keyword

Add the function to the matching table in `witness_values.py`. It takes the field's
contract and its generation context:

```python
_EXACT_DERIVATIONS = MappingProxyType({
    ...,
    SchemaKeyword.MY_KEYWORD: _past_my_keyword,
})
```

Return the values to try, in order. The check in `witnesses.py` discards any that do
not witness the rule, so a derivation never needs to re-judge them.

Decisions: [ADR-187](adr/runners.md#adr-187), [ADR-191](adr/runners.md#adr-191).
