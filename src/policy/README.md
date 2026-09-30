# policy
Status: implemented
**Job:** Classify a ToolCall from the reviewed tool registry (`policies/tools.yaml`) and return a PolicyDecision; propose classes for unreviewed tools during setup
**Depends on:** types
**Does NOT:** ask humans, call tools, or let a name pattern or an MCP annotation decide a call
**Spec:** docs/spec.md §4, 8 · **Decision:** ADR-004

Two inputs, one authority:
- `tools.yaml` (see `policies/tools.example.yaml`): per server, per tool, `class: read|write|risky` with `reviewedBy`/`reviewedAt`. `evaluate()` reads only this. Unknown server or tool → `require_approval`, risk `unreviewed`.
- `suggestions.yaml`: name regexes read only by `suggestClass()`, together with MCP annotations from servers marked `trusted`. Output is a proposal for the reviewer, nothing more.

Identity rules (spec §8): server keys are exact, case-sensitive, own-property lookups (`Object.hasOwn`); `github/constructor` and server `__proto__` are unreviewed, and the loader refuses those keys outright. Built-in tools live under the exact keys `builtin:claude-code` and `builtin:codex`, which MCP hook names cannot produce (Claude Code allows only `[A-Za-z0-9_-]` in MCP server names); the loader refuses any other key with a `:`, any non-builtin key that normalises to `claudecode`, `builtinclaudecode`, `codex`, or `builtincodex`, and any two keys that differ only by case.

Invariant: nothing downgrades. `escalateWhen` may raise a row's class for matching arguments; the loader refuses an escalation whose `to` is not above the base class, and `evaluate()` takes the max anyway.

Loaders validate every field before returning typed records. YAML maps stay `Map`s until
schema validation; dictionaries are projected with `Object.fromEntries`. Duplicate keys,
non-string keys, parse warnings/errors, invalid regexes, and invalid review dates are refused.
YAML merge processing is disabled. Ordinary aliases use the parser's default expansion limit.
Prototype-named argument patterns remain legal; only own arguments match them.
Proxy names follow the frozen regex, minimum length, reserved-name and upstream collision checks.

Suggestions use the first name match and any present trusted annotations. Conflicting hints
select risky over read; absent annotations contribute nothing. The default applies only when
neither source contributes. No function writes registry files or supplies reviewer metadata.
The existing registry decision table exercises the real loader/evaluator and compares every row
with the retained test helper (also still needed by unfinished hook tests).

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
across concatenated groups may produce at most 256 paths.
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
