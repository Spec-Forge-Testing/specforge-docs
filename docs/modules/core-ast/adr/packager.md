# Core AST — Decision records — Packager

Part of the [Core AST decision records](index.md). Packager-stage decisions: how
the selected files and snippets are assembled into the payload the LLM reads.

---

## ADR-040 — The code travels in CDATA, and the renderer touches no disk { #adr-040 }

**Status:** accepted · `packager/`

### Context

The payload is an XML block the model reads. Source code inside XML is hostile
content: it contains `<`, `>`, `&`, quotes, and occasionally something that looks
like markup.

### Decision

Code goes inside `CDATA`, so the model reads it exactly as written rather than
entity-escaped — `&lt;div&gt;` is not what the author wrote and not what the
model should reason about. Attributes, which cannot use CDATA, are escaped
normally.

The renderer (`xml.py`) does **no I/O**: the caller hands it content already
read. Reading the bundle's files is the facade's job, and it is the only I/O in
the stage.

### Consequences

CDATA has one terminator, `]]>`, and a source file may contain it — rare in most
languages, ordinary in anything manipulating XML. `_cdata` splits it into
`]]]]><![CDATA[>`, which is the standard escape and the reason that function
exists. Without it the section closes early and the rest of the payload is
malformed markup the model reads as instructions.

The purity split is what lets the assembly be tested with strings instead of a
temporary directory, and it is why an unreadable file becomes a `SelectedFile`
carrying an `error` rather than an exception: the renderer receives it as data
and emits `<file path="…" error="…"/>`, so the model is told the file is missing
instead of silently not seeing it.

---

## ADR-041 — Token count uses tiktoken when it is installed, a heuristic when it is not { #adr-041 }

**Status:** accepted · `packager/tokens.py`

### Context

`LLMPayload.estimated_tokens` is what a caller uses to decide whether the bundle
fits a model's context window. Counting exactly means tokenising with the target
model's encoder, which means depending on `tiktoken`.

### Decision

`tiktoken` is an optional extra. When present, the count is real, with the
`cl100k_base` encoding. When absent, it is `len(text) // 4`.

### Consequences

The field is named `estimated_tokens` for a reason: without the extra installed
the number is a rule of thumb, and four characters per token is roughly right for
English prose and roughly wrong for source code, which is denser in punctuation.
A caller sizing a prompt against a hard limit should install the extra rather
than trust the fallback.

The encoding is pinned to `cl100k_base`, which is GPT-3.5/4's. For a different
model family the count is close but not exact — closer than the heuristic, and
the reason it is one constant rather than a parameter is that no caller has
needed a second one yet.
