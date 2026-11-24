# Changelog

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
