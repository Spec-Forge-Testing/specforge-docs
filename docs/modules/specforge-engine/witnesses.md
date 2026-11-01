# Witnesses of inferred rules

A produced contract can declare a rule the spec leaves out: a `minLength` the code
applies, a `maximum` it checks. Every valid draw then obeys the rule, so without a
dedicated request the rule would never be crossed in a valid pass. A **witness** is
that request: the pass's simplest payload with one field at a value the spec takes
and only the inferred rule forbids. This page covers how a witness is built, its
limits and what it reports. The code is `strategy_compiler/witness_values.py` and
`runtime/fuzzers/stateless/witnesses.py`.

## Where it runs

A stateless valid pass sends its minimal request, then one witness per field that
infers a keyword, in (zone, path) order. Witnesses are part of the valid pass, so
every strategy sends them, `smoke` and `exposure` included. Without a produced
contract no field infers anything and there are none.

They count inside the pass's share and go first, each looked for only once the
pass asks for it. A share smaller than the witnesses sends the first ones it fits.
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
| Accepts it | `input_validation` | [Plain request](control-requests.md#inferred-rule) |

The `inferred_rule` finding says the server enforces a rule only the produced
contract declares, so the spec should declare it too. Its observation holds the
keyword in `expected`, the value in `observed` and the field in `location`. Its
`rule_id` is the field's path without array indexes, the id a rejection naming that
field gets. A rejection naming a field on another branch reports nothing here.

!!! note "Two findings of one rule"
    A witness and the `boundary` draw that crosses the same rule are two findings
    with the same `rule_id`. A defect is told apart by its reproducer, not its rule,
    and the two send different values.

## Stateful runs { #stateful }

A stateful run sends no witnesses. With a produced contract, its valid draws obey
the inferred rules, so they do not provoke the rejection those rules describe. A
state machine that forced invalid values would break the sequences a contract makes
reachable.

Field-level `contract_completeness` findings on inferred rules therefore come from
stateless runs. To see them, run stateless as well as stateful. Without a produced
contract, a stateful run can still report such a rejection, since its draws then
ignore the rule.

## Where to change it

| To change | Edit |
| --- | --- |
| The limits | `strategy_compiler/constants.py`, `runtime/fuzzers/stateless/constants.py` |
| The value derived for a keyword | `_EXACT_DERIVATIONS`, `_SIZED_DERIVATIONS` in `witness_values.py` |
| When a request counts as a witness | `witnesses_an_inferred_rule` in `runtime/oracles/inferred_rule.py` |

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

Decision: [ADR-187](adr/runners.md#adr-187).
