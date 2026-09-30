# policy
Status: implemented
**Job:** Classify a ToolCall from the reviewed tool registry (`policies/tools.yaml`) and return a PolicyDecision; propose classes for unreviewed tools during setup
**Depends on:** types, shared configuration I/O (`src/config-file.ts`)
**Does NOT:** ask humans, call tools, or let a name pattern or an MCP annotation decide a call
**Spec:** docs/spec.md §4, 8 · **Decision:** ADR-004

Two inputs, one authority:
- `tools.yaml` (see `policies/tools.example.yaml`): per server, per tool, `class: read|write|risky` with `reviewedBy`/`reviewedAt`. `evaluate()` reads only this. Unknown server or tool → `require_approval`, risk `unreviewed`.
- `suggestions.yaml`: name regexes read only by `suggestClass()`, together with MCP annotations from servers marked `trusted`. Output is a proposal for the reviewer, nothing more.

Identity rules (spec §8): server keys are exact, case-sensitive, own-property lookups (`Object.hasOwn`); `github/constructor` and server `__proto__` are unreviewed, and the loader refuses those keys outright. Built-in tools live under the exact keys `builtin:claude-code` and `builtin:codex`, which MCP hook names cannot produce (Claude Code allows only `[A-Za-z0-9_-]` in MCP server names); the loader refuses any other key with a `:`, any non-builtin key that normalises to `claudecode`, `builtinclaudecode`, `codex`, or `builtincodex`, and any two keys that become equal under NFKC plus lowercase. Tool keys must match
`^[A-Za-z0-9_.-]{1,128}$`; lookups remain exact and case-sensitive.

Invariant: nothing downgrades. `escalateWhen` may raise a row's class for matching arguments; the loader refuses an escalation whose `to` is not above the base class, and `evaluate()` takes the max anyway.

ADR-009 adds optional `storeArgs: string[]` to each reviewed tool: argument field names permitted
to be stored in cleartext. Names are exact and case-sensitive, must match `[A-Za-z0-9_-]{1,64}`,
and must be unique. Reserved keys (`__proto__`, `constructor`, `prototype`, and names on
`Object.prototype`) are refused. Only top-level names are supported: dots, including
`options.branch`, are refused rather than interpreted as nested paths. Absent `storeArgs`
and `storeArgs: []` both permit no clear args. `clearArgFields(registry, server, tool)` returns
`readonly string[]` using own-property server/tool/allowlist lookups; unreviewed tools return
`[]` regardless of server trust. This registry metadata does not change tool classification.
ADR-009 assigns hashing of other argument fields and defense-in-depth redaction of clear fields
to the ledger; this module only declares and validates the allowlist.

Loaders validate every field before returning typed records. YAML maps stay `Map`s until
schema validation; dictionaries are projected with `Object.fromEntries`. Duplicate keys,
non-string keys, parse warnings/errors, invalid regexes, and invalid review dates are refused.
YAML merge processing is disabled. Ordinary aliases use the parser's default expansion limit.
Prototype-named argument patterns remain legal; only own arguments match them.
Empty `argPattern` mappings and empty-string regexes are refused at load.
Proxy names follow the frozen regex, minimum length and reserved-name checks. Upstream collision
checks apply Codex sanitisation (non-ASCII-alphanumeric/underscore → underscore), take the first
`__` segment visible to hooks, trim trailing underscores and lowercase before comparing against
the proxy name. This also refuses upstream suffixes such as `--foo`, `-_foo` and `_-foo`.

All configuration loaders require the literal integer spelling `version: 1` (also JSON `1`);
quoted strings, aliases, floats, hexadecimal, padded integers and exponent spellings are refused.
On POSIX, configuration files must belong to the process real uid (`process.getuid()`)
and must not be group/world-writable (`mode & 0o022`); `0600` and `0644` are supported.
The shared reader checks and reads the same open descriptor, then closes it even on error.
Owner/mode checks are skipped on Windows, where these POSIX semantics do not apply.

Suggestions use the first name match and any present trusted annotations. Conflicting hints
select risky over read; absent annotations contribute nothing. Within present annotations,
`readOnlyHint: true` suggests read unless `destructiveHint: true` explicitly conflicts;
otherwise only `destructiveHint: false` suggests write, and omitted destructiveHint suggests risky.
This follows the [MCP annotation defaults](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations)
(verified 2026-09-30). Advice never changes runtime authority. Frozen spec §8's “else write” wording
should follow at the next ADR; `docs/spec.md` remains unchanged. The default applies only when
neither source contributes. No function writes registry files or supplies reviewer metadata.
The existing registry decision table exercises the real loader/evaluator and compares every row
with the retained test helper (also still needed by unfinished hook tests). Generated cases cover
argument shapes, all escalation ranks, AND predicates, ties and malformed schemas. The oracle
checks parsed objects independently; it shares only the regex-subset validator. Source spelling,
YAML duplicate keys and file permissions are checked by loader tests before parsing loses them.

Due diligence, checked 2026-09-30 against installed `yaml` 2.9.1:
- [V] [Official YAML docs](https://eemeli.org/yaml/#parse-options) specify `uniqueKeys: true`;
  duplicates produce `DUPLICATE_KEY`. [ToJS docs](https://eemeli.org/yaml/#tojs-options)
  specify `mapAsMap: true` and the default alias expansion limit of 100. Regression tests pin both
  duplicate rejection and nested Maps, including a literal `__proto__` key.
- [V] The docs do not promise special `__proto__` behavior for objects. The installed
  `dist/nodes/addPairToJSMap.js` and [upstream source](https://github.com/eemeli/yaml/blob/main/src/nodes/addPairToJSMap.ts)
  use `Map.set` for Maps and `Object.defineProperty` for inherited object keys. Tests confirm
  default object parsing makes `__proto__` own without changing the prototype; production uses Maps.
- [H] A configured proxy suffix is random enough to resist guessing. The loader validates syntax
  and length, not entropy or managed Codex configuration. This is local best-effort gating.
- [H] Reviewer names identify actual human review. Schema validation can require metadata, not
  establish that a human performed the review. Configuration authors remain trusted.

Regexes use a conservative subset, including in suggestions: at most 512 UTF-16 code units,
one quantifier total (`*`, `+`, `?`, `{n}`, `{n,m}`, `{n,}`), on a single character/class only;
finite counts must be ≤1024. Groups and alternatives are allowed but groups cannot be quantified; expanding alternatives
across concatenated groups may produce at most 256 paths, or 16 when any quantifier is present.
Lookaround, backreferences, named groups, lazy quantifiers, and numeric/hex/Unicode escapes
are refused. Character classes and escaped punctuation are supported. This intentionally rejects
some safe regexes to exclude nested repetition, ambiguous repeated alternatives and overlapping
repetition. Invalid syntax is also refused. Compiled escalation regexes are cached per tool entry;
editing escalation rules invalidates that entry's cache without changing public contract shapes.

Only primitives are converted to text. Any object/array/function argument value counts as matched
without invoking coercion; text over 1024 UTF-16 code units also counts as matched. The cap is checked
before regex execution. Missing arguments still do not match, and all predicates in a rule must match.
Null/non-object `args` are treated as an empty argument mapping. Unknown classes in hand-built
registries receive the complete `require_approval / unreviewed` decision.
The ReDoS regression runs in a supervised child with a 2-second SIGKILL deadline; the reported
pattern must be refused or its 41-character attack must escalate in under 50 ms.
