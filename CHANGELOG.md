# Changelog

## 1.2.0

- New invariant V11: a claim marked time-sensitive (`as_of: true`) must cite
  evidence whose `as_of` — the ledger entry's retrieval time — is no older than
  `maxEvidenceAgeHours` (default 24). Stale or untimestamped evidence now fails
  instead of silently passing, which is what a "current price / latest version"
  answer needs.
- `answer_verify` returns lossless JSON: a failure without a detail used to carry
  an `undefined` field, which the tool boundary rejected.
- 154 tests.

## 1.1.0

- New `answer_verify` tool: submit the answer with one claim per factual
  assertion, each citing a ledger id and the exact quoted excerpt. Quotes are
  compared against the cited entry's stored result, so a fabricated number fails
  even when some tool call succeeded earlier in the turn. Without this, the
  turn-end audit could only check that completion language had *any* successful
  call behind it.
- The injected contract now asks for `answer_verify` before an answer that
  contains factual claims.

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
