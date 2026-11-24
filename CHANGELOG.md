# Changelog

## 1.3.2

- Evidence is minted per claim (`E1#C2`, with `source_id` still naming the ledger
  entry), so one ledger entry quoted by several claims can no longer lend its
  excerpt to an unquoted claim in either order.
- 已确认 followed by an execution verb (已确认删除/已确认发布/已确认支付) is a
  completion again and needs a successful call; a bare reasoning 已确认 stays
  unflagged.
- The English completion vocabulary covers "already published" and its siblings,
  matching the README's turn-end audit promise.
- V8 observes the runtime's `approval/asked` + `approval/decided` audit pair: an
  approved call clears V8, a call with no observed decision still fails, and the
  turn-end audit backfills the same confirmation record.
- Configured `traceableParams` now reach the ledger and V9, so the provenance gate
  and the verifier check one key list.
- Negation is decided per clause, so "已删除文件，未删除备份" still counts as a
  completed deletion.
- Composition tests derive the vendored Cordis path from the test file (or
  `DSH_CORDIS_URL`) and fail loudly instead of skipping.
- Both READMEs explain the local `@local/...` development name versus the
  published `@jasper_alaric/...` install name.
- Settings metrics are reachable again: `status()` now returns the session block
  (`startedAt`, `uptimeMs`, `metrics`), so "answers checked before sending" stops
  reporting null and counts every `answer_verify` call.
- A verified or derived claim without a quote now fails V3 instead of being
  skipped; V3 is reported as unchecked only when no verbatim evidence exists.
- Ledger entries carry `ok` (true unless the call errored), and V5/V6 use it, so a
  silent but successful call (`pwsh`, `rm`, `mkdir`) is no longer treated as a
  failed call.
- V5 no longer treats a bare 已完成/已确认 as a tool completion; "分析已完成" and
  "已确认这条推理自洽" pass, while 已删除/已执行 still fail without a call.
- Provenance roots default to cwd plus `$DSH_HOME`; an explicit `traceableRoots: []`
  now exempts nothing instead of falling back to cwd.
- Root matching resolves `..`, unifies separators, and folds case, so a traversal
  path is rejected and `E:/base/x` matches `E:\base`.
- Verbatim evidence is compared against up to 8000 characters kept in memory
  instead of the 1600-character display copy; an over-limit comparison reports how
  much of the result it could cover.
- `inferred` claims default to medium confidence, so V7 only asks for uncertainty
  wording on `unknown` or an explicit `low`.
- V8 is reachable: the gate records high-risk asks, and `answer_verify` reports
  them as an unconfirmed `action_confirmation` for the turn.
- V9 is reachable: `answer_verify` checks identifying parameters against the
  session corpus snapshot (`text()`), not an always-empty traceable list.
- V1 no longer lets a 40% substring cover a fact that carries a number or entity
  the claim omits; whole-fact containment still passes.
- Risk gate catches `curl --request POST`, `curl -XPOST`, `gh pr merge`, and
  shell-family names such as `terminal_exec`; mail-read tools such as
  `email_search` are no longer flagged as senders.
- A valid Chinese mode label no longer produces a "not a known profile" warning.
- V11 requires ISO 8601 with `Z` or an explicit offset, so a zone-less timestamp is
  reported as unparseable instead of being read in the host timezone.
- A one-character `id`/`ids`/`name` value is now checked by the provenance gate.
- Strict verification level now requires a real verbatim quote, matching the
  README, instead of merely an evidence id.
- `POST /a-hallucination/mode` rejects an unknown mode with 400 and leaves the
  active mode unchanged.
- `package.json` no longer declares the unused client locale injection.
- The dev bundle patch keeps a one-line comment; the release copy's comment still
  differs until the next sync.
- Both READMEs document every configuration key, and the V8/V9 descriptions now
  match the wired behaviour.

## 1.3.1

- The settings page shows how many answers were checked before sending, how many
  passed, how many needed fixes, and what share of claims carried a quote. Shows
  "none yet" instead of a rate when nothing has been measured.
- Client-only change: no verification behaviour differs from 1.3.0.

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
