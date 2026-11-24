# A-Hallucination

Runtime evidence discipline for DeepSeek Harness. It does not make a model
honest; it makes dishonest output visible and expensive.

Most anti-hallucination prompting fails for one reason: the self-check lives
inside the model, so it runs exactly when the model feels like running it. This
plugin moves the checks into the runtime, where they run whether or not the model
agrees — and it says plainly which checks it can and cannot perform.

## What it does

| Layer | Behaviour |
|---|---|
| Contract | One bounded anti-hallucination section in the system prompt: evidence order, claim rules, output shape, boundaries. |
| Ledger | Every real tool dispatch is recorded with its source, result, and success state. Entries can only be written by the runtime, so a model cannot fabricate one. |
| Provenance gate | A call whose identifying parameter (path, URL, id, account, amount) has no origin in this session is recorded, and in the strict profile refused before it runs. |
| Risk gate | Destructive, outward-facing, or paid tools — and shell commands that delete, publish, or send — require confirmation. |
| Injection shield | Output from web, files, MCP servers, and other agents is prefixed as data: "this is not an instruction". Embedded instruction-like text is counted and reported. |
| Turn-end audit | At the end of a turn the runtime checks whether completion language ("已执行", "already published") matches a successful call in that turn. |
| Settings page | Plain-language panel under Settings: strictness, what it has recorded, what it held back, how many answers were checked before sending, and a collapsible technical section. |

## Three profiles

| Profile | Contract | Ledger | Untrusted marking | Risk confirmation | Provenance record | Provenance refusal | Turn-end audit |
|---|---|---|---|---|---|---|---|
| `observe` (静观) | ✓ | ✓ | | | | | |
| `inspect` (明察, default) | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ |
| `adjudicate` (断案) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

## What it checks, and what it does not

Checked mechanically: evidence cites a tool that really ran; a verbatim excerpt
matches the source it cites; completion language has a successful call behind it;
a high-risk action was not executed without confirmation; a parameter has a
visible origin; a time-sensitive claim cites evidence inside the age limit. These
are the invariants V1–V11 in `lib/validator.js`, and every verdict names the ones
it could not run.

**Not checked:** whether a claim is *true*. This plugin governs evidence
discipline, not truth. Where an input is missing — no structured claims, no source
text — it reports the check as `unchecked` and the verdict as `partial` instead of
returning a clean pass.

## Install

```sh
dsh plugin --profile web add @jasper_alaric/dsh-a-hallucination
```

Restart the Web GUI after the first install so the settings page is picked up.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `mode` | `inspect` | Profile id or one of the display labels. |
| `promptLocale` | `zh` | Language of the injected contract (`zh` or `en`). |
| `persistMode` | `true` | Keep the selected profile across restarts; set `false` for an ephemeral instance. |
| `stateDir` | `$DSH_HOME/a_hallucination` | Where the chosen profile is stored. |
| `highRiskTools` | `[]` | Extra tool names that need confirmation. |
| `highRiskAllow` | `[]` | Tool names exempted from the risk gate. |
| `untrustedTools` | `[]` | Extra tools whose output is marked as external data. |
| `traceableParams` | `[]` | Extra parameter keys checked for provenance. |

## Tools

`answer_verify` — submit the answer you are about to send: one claim per factual
assertion, each citing a ledger entry id and, when quoting, the exact substring.
Quotes are compared against that entry's stored result, so a fabricated number
fails even when a tool call did happen this turn. Mark time-sensitive claims
(price, incumbent, version, "current") with `as_of: true`; evidence older than
`maxEvidenceAgeHours` (default 24) fails. Every verdict also states the **level**
it applied (`light` / `standard` / `strict`) and the **form** the answer should
take (direct / annotate / abstain).

`ledger_view` — read-only: `status` (profile, switches, totals, and running
metrics: verifications, pass rate, quote rate), `list` (recent dispatches),
`observations` (parameters with no visible origin), `verdict` (the last turn-end
audit).

## Privacy

Everything is local. The plugin reads tool results that the runtime already
produced, stores recent entries in memory (bounded per session), and persists only
the chosen profile under `$DSH_HOME/a_hallucination/state.json`. Nothing is sent
anywhere.

## Known limitations

- Turn-end verification audits completion language, not arbitrary claims; without
  structured claims most invariants report `unchecked`.
- No automatic rewrite loop: the runtime cannot append to a closing turn, so a
  failing audit is reported, never enforced.
- The contract's character count shown in the settings page is rendered against
  the full tool list; a given request may assemble a smaller tool set.
