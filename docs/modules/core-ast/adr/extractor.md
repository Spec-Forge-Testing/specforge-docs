# Core AST — Decision records — Extractor

Part of the [Core AST decision records](index.md). Extractor-stage decisions:
once the locator has named a file and a handler, how its exact source is cut
out of the tree.

---

## ADR-023 — The function is cut by byte offsets, decorators included { #adr-023 }

**Status:** accepted · `extractor/function.py`

### Context

Once the handler's node is found, its source has to be handed to the LLM. The
obvious approach is line numbers: take `start_point[0]` to `end_point[0]` and
join those lines.

### Decision

The slice is `source_bytes[start_byte:end_byte]` — byte offsets from the node
itself, on the raw bytes, decoded only at the end.

Bytes and not decoded text because tree-sitter's offsets **are** byte offsets: a
multibyte character anywhere earlier in the file shifts every character index,
and slicing a `str` by those numbers returns something else. It is silent when it
happens — the snippet is merely wrong, not malformed.

The slice is then widened upward to include a decorator when the node's parent is
one. A handler without its decorator is missing the route it serves and whatever
validation the framework declares there, which is most of what the LLM needs to
infer the endpoint's contract.

### Consequences

Indentation, comments and blank lines inside the function survive exactly as
written — the LLM reads the code the way the author left it, not a reflowed
version. `ExtractedContext` still carries `start_line` / `end_line`, but as
metadata for humans, never as the way the code was obtained.

---

## ADR-024 — A handler name can be a dotted path, resolved segment by segment { #adr-024 }

**Status:** accepted · `extractor/function.py`

### Context

The handler is not always a module-level symbol. A Koa controller exports
`module.exports = { feed: { async get(ctx) {} } }` and the route points at
`ctrl.feed.get`, so the name to extract is `feed.get`. No node in the tree is
called `feed.get`.

### Decision

A target containing a dot is walked one segment at a time: find `feed`, then find
`get` **inside the subtree** the previous segment resolved to.

### Consequences

The scoping is what makes it correct rather than merely working: a file usually
has more than one `get`, and searching the whole tree for the last segment would
return whichever came first. It also means an intermediate segment must itself be
captured as a definition — which is why `typescript.scm` captures an object key
whose value is a function or an object, and only those two, so that ordinary
configuration keys do not become definitions.
