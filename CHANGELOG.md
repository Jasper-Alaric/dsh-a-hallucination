# Changelog

## 1.3.0

- L3 verification level: every verdict reports `light`, `standard` or `strict`,
  derived from whether the answer cites evidence or makes a time-sensitive claim.
- L6 output governance: the verdict states the shape the answer should take —
  direct, annotate, or abstain with what is missing.
- L7 metrics: pass/partial/fail counts, quote rate, level mix and failure codes
  per session, shown in `ledger_view status` and the settings data.
- Evidence carries `locator` (tool call id or path/URL).
- The contract gained the A–H task routing line and an actionable abstention
  template (what is missing, up to 3 questions, conditional answer).

## 1.2.0

- New invariant V11: a claim marked time-sensitive (`as_of: true`) must cite
  evidence whose `as_of` — the ledger entry's retrieval time — is no older than
  `maxEvidenceAgeHours` (default 24).
- `answer_verify` returns lossless JSON; a failure without a detail used to carry
  an `undefined` field that the tool boundary rejected.

## 1.1.0

- New `answer_verify` tool: one claim per factual assertion, each citing a ledger
  id and the exact quoted excerpt, compared against that entry's stored result.
- The contract asks for `answer_verify` before an answer with factual claims.

## 1.0.0

First release.

- Bounded anti-hallucination contract injected as a system-prompt section, in
  Chinese or English.
- Per-session evidence ledger written only by real tool dispatches, with turn
  attribution from the assistant stream.
- Provenance gate over identifying parameters (string or number), with a record-only
  mode and a refusing mode.
- Risk gate over tool names, action verbs, and shell command text.
- Injection shield that marks web, file, MCP, and A2A output as data and reports
  instruction-like fragments.
- Turn-end audit of completion language against real successful calls, reported as
  `pass`, `partial`, or `downgrade`, with every unchecked invariant named.
- `ledger_view` tool: `status`, `list`, `observations`, `verdict`.
- Settings page in plain language with a collapsible technical section.
- Durable profile selection under `$DSH_HOME/a_hallucination/state.json`.
- 142 tests, including composition cases on the real Cordis runtime.

### Deliberate omissions

- No automatic rewrite loop: a closing turn cannot receive messages, so a failing
  audit is reported rather than enforced.
- No claim extraction from prose: without structured claims the validator names
  the invariants it could not check instead of guessing.
