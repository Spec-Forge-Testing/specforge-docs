# Proving a violation

A finding that says a server accepted a value outside its contract is only as good
as the proof that the value was outside it. The engine answers that question with
one predicate, `first_provable_violation(value, contract)`
(`shared/violation.py`): the first place the value **provably** breaks its declared
contract, or `None`. What the engine cannot decide never counts as a violation.
This page covers what the predicate decides, how it reads a declared `pattern` and
`format`, how a value is read back as it travelled, and the values the compiler
draws to break a pattern or a format.

## Two readings of the same contract

The engine asks the contract two opposite questions, and each errs on its safe
side ([ADR-176](adr/findings.md#adr-176)):

| Question | Asked by | When it cannot decide |
| --- | --- | --- |
| Does the value provably **break** its contract? | the `input_validation` oracle, the mutation classifier, the probe filter | the value does not break it |
| Does the value provably **meet** its contract? | the `contract_completeness` oracle (`meets_declared_shape`) | the value does not meet it |

Both walk the same structure (`first_shape_mismatch`, `shared/shape_check.py`)
with a `ShapePolicy` that says what a `pattern` or `format` it cannot decide
means. A value that neither question can settle leaves both oracles silent.

`first_provable_violation` decides everything `validate_value` decides (type,
range, `multipleOf`, length, `enum`, `minItems`/`maxItems`, the items and required
properties at any depth), a required field left out, `uniqueItems`,
`minProperties`, `maxProperties`, and a declared `pattern` and `format`, with the
rules below.

## Patterns read as ECMA-262

OpenAPI's `pattern` is an ECMA-262 regular expression, and Python's `re` reads
some of its constructs differently. `ecma_match(pattern, text)`
(`shared/ecma_pattern.py`) returns one of three `PatternMatch` members:
`MATCHES`, `MISSES` or `UNDECIDABLE`. Only `MISSES` proves a violation.

**One compilation, with ECMA's meaning.** The pattern is tokenized and compiled
once with `re.ASCII`, which makes `\d`, `\w` and `\b` mean what they mean in ECMA
without the `u` flag. Four tokens are rewritten outside a class: `\s` and `\S` to
ECMA's `WhiteSpace` and `LineTerminator` set (U+FEFF included), `.` to anything
but a line terminator, and `$` to the end of the text. A pattern Python cannot
compile is undecidable, and logged at `debug`.

**Undecidable constructs.** A pattern holding any of these is left undecided,
because Python compiles it with another meaning or ECMA has no such construct:

- an escaped letter outside `dDwWsSbBtnrfvxu` (`\A`, `\Z`, `\z`, `\a`, `\U`);
- a backreference `\1` to `\9`;
- a quantifier written `{,n}`, or a possessive one (`a++`);
- the empty classes `[]` and `[^]`, and `\S` inside a class;
- a surrogate escape `\uD800` to `\uDFFF`;
- an inline flag group `(?i)` or any group opener ECMA lacks.

A text with a character above U+FFFF is undecidable too: ECMA without `u` counts
UTF-16 units, Python counts code points.

**A deterministic work budget.** Backtracking can explode, so two guards run
before the match, and both depend only on the pattern and the text:

- **Star height.** A repeated group that holds a quantifier or an alternation
  (`^([a-z]+)*$`, `(foo|bar)*`) is undecidable.
- **Work.** The product of each quantifier's reach over the text, times the start
  positions, must stay within `MAX_PATTERN_WORK` (1 000 000); past it, the pattern
  is undecidable for that text.

There is no timeout: a verdict that depended on the machine would let a replay
judge a finding differently from the run that found it.

## Formats the checker can decide

A `format` proves a violation only when it is a member of `DecidableFormat` and the
JSON Schema 2020-12 format checker (`Draft202012Validator.FORMAT_CHECKER`)
rejects the text. `DECIDABLE_FORMATS` is derived from the table that names one
breaking text per format:

| `DecidableFormat` | A text its checker rejects |
| --- | --- |
| `email` | `plainaddress` |
| `uuid` | `not-a-uuid` |
| `date` | `2024-13-45` |
| `date-time` | `2024-01-01` |
| `time` | `12:00:00` (no offset) |
| `ipv4` | `256.1.1.1` |
| `ipv6` | `1::2::3` |
| `hostname` | `-bad-` |
| `uri` | `relative/path` |
| `uri-reference` | `%zz` |

The checker rejects two RFC 3339 texts that are valid, the year `0000` and a leap
second `:60`; for `date`, `date-time` and `time` those texts are undecidable. Every
other format (`password`, `binary`, `byte`, `color`, `regex`, any unknown name)
never proves a violation.

Conformance reads formats with the same 2020-12 checker: a `time` must carry its
offset to conform, and a format the checker does not know is never shown met, so a
request holding one does not provably conform. `password` and `binary` restrict
nothing.

## Reading a value as it travels { #reading-a-value-as-it-travels }

A value is judged as the server received it, not as it was drawn
([ADR-177](adr/findings.md#adr-177)). `shared/wire/` mirrors how the injector sends
each zone:

| Zone | What travels |
| --- | --- |
| `path` | one text in OpenAPI's `simple` style ([Requests](requests.md#how-a-value-is-spelled)) |
| `query` | one text per array item, else one text |
| `header` | one text in the `simple` style, without the whitespace HTTP strips around it |
| `body`, JSON | the value itself, types and `null` included |
| `body`, form or multipart | one text per array item, else one text: a string as drawn, any other value as its JSON text |

A query, header or form field drawn `None` is not sent, and reads as **absent**,
which breaks the contract only when the field is required.

**The texts are read as the declared type.** A declared array reads each text as
an item. A declared scalar reads its one text; several texts for a scalar are
unreadable, because which one the server keeps depends on its framework. An
object on a text wire and an array of objects or arrays on one are unreadable too,
and so is an array in a path or header, where a comma inside an item cannot be
told from the separator. Unreadable proves nothing either way (`UNREADABLE`).

**A violation reads leniently, conformance strictly.** `TextReading` names the
three readings:

| `TextReading` | A text read as | Used for |
| --- | --- | --- |
| `LENIENT` | the widest common server reading: `int()` for an integer (`" 7"`, `"+7"`), a finite `float()` for a number, `true`/`1`/`yes`/`on`/`t`/`y` and their negatives for a boolean, case-insensitive | a provable violation |
| `STRICT` | the wire literal only: `-?[0-9]+`, a decimal with an optional exponent, `true` or `false` | conformance |
| `AS_SENT` | the text itself | citing what was sent |

A text a lenient server reads as the declared type is not a proven violation of
that type, and its other keywords are judged on the value it reads as: `"+4"` for
an integer is `4`. The observation cites the text that was sent (`"+4"`), not the
value read. A conforming request has to conform under the strict reading, so a
text only a lenient server accepts never makes a request provably conform.

## Probes that break a pattern or a format

A string that declares a `pattern` or a `format` is poisoned in `invalid` with
named probes, so it has an invalid value even with no length bound
([ADR-178](adr/compiler.md#adr-178)). `SHAPE_PROBES`
(`strategy_compiler/format_constants.py`) are eight texts: a blank, `a`, `0`,
`-1`, `!`, `a b`, a non-ASCII letter and a 256-character run. A decidable format
adds its breaking text from the table above.

The filter runs at compile time: a probe is kept when `first_provable_violation`
says it breaks the field's contract and it fits the zone's alphabet (a header
carries no space). The survivors are drawn with `sampled_from`, beside the field's
other invalid candidates. When none survives, the string still has no invalid
value from its shape.

## A known format within its declared length

A string with a known format draws a valid text of that format within its declared
`minLength` and `maxLength` ([ADR-179](adr/compiler.md#adr-179)). When the
format's own regex fits the declared length whole, it is drawn from that regex;
otherwise a builder of `FORMAT_BUILDERS` (`fields/default/format_builders.py`)
draws a text at a length that fits:

| Format | How it is built within a length |
| --- | --- |
| `email`, `uri`, `ipv4`, `hostname`, `date-time` | by parts, each drawn at a length that fits; the shortest are `a@b.c` and `a:b` |
| `byte` | whole base64 groups of four characters |
| `uuid`, `date` | their fixed-length regex |

An endpoint is excluded, listed with its reason, only when no valid text of the
format has a declared length (`no email text is 0 to 4 characters long`).

With a `pattern` too, the author's pattern is drawn and kept to texts the format's
checker accepts when it can decide. A `date` with a declared range and a pattern is
drawn from the range within the length, and a text the pattern provably misses is
dropped.
