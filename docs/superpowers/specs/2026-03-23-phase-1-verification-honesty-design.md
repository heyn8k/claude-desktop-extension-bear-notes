# Phase 1: Verification Honesty — Design Spec

**Date:** 2026-03-23
**Status:** Draft
**Goal:** Make the bear-mcp verification layer honest and, where empirically supported, stronger. No tool overstates certainty. Tests reflect current behavior. The specification matches reality.

**What this is not:** A feature phase. No new tools, no new parameters, no new user-facing capabilities. This is the foundation that makes future features trustworthy.

---

## Architecture Decision

SQLite read-after-write is the primary verification model. It checks persisted state — what Bear actually wrote to disk — which is a stronger trust source than Bear's x-callback-url self-report. This is not a workaround for the lack of a callback receiver. It is the correct design.

The x-callback-url bridge (via xcall, macOS Shortcuts, or a custom native helper) remains a future consideration for additional confirmation signal, lower-latency feedback, or richer return data on create/add-text/add-file operations. It is not a prerequisite for trustworthy verification, and is not in scope for Phase 1.

---

## Response Model

### Three-tier certainty labeling for successful outcomes

| Tier | Label | Meaning |
|------|-------|---------|
| **content matched** | `(content matched)` | Expected persisted body equals actual persisted body after any agreed normalization |
| **state confirmed** | `(state confirmed)` | Relevant DB state change confirmed (flag, tag, row existence, heuristic checks passed) |
| **dispatched, unverified** | `(dispatched, unverified)` | Request sent to Bear, no trustworthy post-state confirmation |

### Failures are a separate category

Failures are not a downgraded success tier. They are explicit error responses with diagnostic detail:
- "Write verification FAILED" with specific findings (doubled content, tag wipe, unchanged text)
- "Note not found" / "Section not found" / soft errors with suggested remediation

### Tier assignment rules

1. Each execution path within a tool earns its own tier based on what was actually checked. A single tool may emit different tiers depending on which path executes.
2. The emitted tier must match the strongest evidence actually checked by that path. No path claims a tier it hasn't earned.
3. Heuristic post-write checks (text changed, no doubled content, tags preserved) earn "state confirmed", not "content matched". Content matched requires exact expected-vs-actual comparison.
4. Once expected-vs-actual comparison exists (Track 2), heuristics become failure diagnostics only. They explain *why* content didn't match — they never rescue a mismatch back into a success tier.

---

## Per-Tool Verification Matrix (Current State)

This table documents what each tool's verification actually checks today. It is the baseline that Track 2 improves against.

| Tool | Path | Evidence Checked | Track 1 Tier | Limitations | Fallback |
|------|------|-----------------|--------------|-------------|----------|
| `bear-create-note` | Poll succeeds | Note row exists with expected title | state confirmed | Title collision: `awaitNoteCreation` matches most recent note with exact title in 10s window. If two notes share a title, may match the wrong one. | dispatched, unverified (poll timeout or no title to poll) |
| `bear-create-note` | Poll fails/no title | None | dispatched, unverified | No post-state confirmation possible | — |
| `bear-add-text` | Verification passes | Text changed + no doubled YAML/H1 + tags preserved | state confirmed | Heuristic checks only — does not compare expected vs. actual body content | Explicit failure with diagnostics |
| `bear-replace-text` | Verification passes | Text changed + no doubled YAML/H1 + tags preserved | state confirmed | Heuristic checks only — does not compare expected vs. actual body content | Explicit failure with diagnostics |
| `bear-add-file` | File row found | Filename row exists in ZSFNOTEFILE linked to note | state confirmed | Checks row existence, not file content integrity. Size comparison deferred (see Scope Boundary). | dispatched, unverified (poll timeout or no ID) |
| `bear-add-tag` | Verification passes | Text changed + no doubled YAML/H1 + tags preserved | state confirmed | Heuristic checks only — does not compare expected vs. actual body content | Explicit failure with diagnostics |
| `bear-add-tag` | Tags already present | Tags checked in DB, all present | state confirmed (no-op) | No write performed; confirms current state only | — |
| `bear-archive-note` | Flag confirmed | ZARCHIVED = 1 in SQLite | state confirmed | — | dispatched, unverified (poll timeout) |
| `bear-trash-note` | Flag confirmed | ZTRASHED = 1 in SQLite | state confirmed | — | dispatched, unverified (poll timeout) |
| `bear-rename-tag` | Old gone + new present | `!tagExists(old) && tagExists(new)` | state confirmed | Does not verify note membership preservation. If new tag already existed independently, check passes without confirming rename scope. | dispatched, unverified (poll timeout) |
| `bear-delete-tag` | Tag absent | `!tagExists(name)` | state confirmed | Global absence check. Does not verify which notes were affected. | dispatched, unverified (poll timeout) |
| `bear-upsert-note` (replace) | Verification passes | Text changed + no doubled YAML/H1 + tags preserved | state confirmed | Heuristic checks only — does not compare expected vs. actual body content | Explicit failure with diagnostics |
| `bear-upsert-note` (create) | Poll succeeds | Note row exists with expected title | state confirmed | Same title collision risk as `bear-create-note` | dispatched, unverified (poll timeout or no title) |
| `bear-upsert-note` (idempotent) | Content already matches | Pre-write body equals proposed body | state confirmed (no-op) | No write performed; confirms current state only | — |

**Note:** For text-write operations in Track 1, "state confirmed" means heuristic post-write checks passed, not exact expected-vs-actual content equality. This distinction is load-bearing and must be documented in the specification.

---

## Track 1: Honesty

Ships unconditionally. No dependencies on empirical testing. Leaves the repo in a more truthful state even if Track 2 stalls.

### T1.1 — Three-tier response labeling

Replace all verification-related response strings with the three-tier model defined above. Three categories of strings to update:

**Success strings** (~8 in `main.ts`, ~1 in `utils.ts`): Currently say "(verified)" or "and verified". Replace with appropriate tier label.

**Timeout/fallback strings** (~5 in `main.ts`, ~1 in `utils.ts`): Currently say "sent but verification failed" or "(unverified — could not recover note ID)". Replace with "dispatched, unverified" language. These are a distinct group — they represent poll timeouts and unrecoverable IDs, not verification check failures.

**No-op success strings** (~2 in `main.ts`): Currently return unlabeled responses when no write is needed — "Tags already present" (`main.ts:720`) and "Note already matches the provided content" (`main.ts:1032`). These are successful outcomes that must emit a tier per the verification matrix: "state confirmed (no-op)" since we checked current state and confirmed no action was needed.

**Failure strings** (~2 in `main.ts`, ~1 in `utils.ts`): Currently say "verification FAILED" with diagnostic detail. These remain explicit failures with diagnostics — they are not relabeled as a tier.

**Files:** `src/main.ts`, `src/utils.ts`

### T1.2 — Fix stale system test assertions

Update failing system test assertions to match new response wording.

**Prerequisites:**
- Run `npm run test:system` and produce an actual inventory of failing assertions. Do not carry forward the unverified count of "9" — count the real failures and categorize each one.
- Confirm all failures are pure string assertion mismatches, not tests of verification behavior that changes under new labeling. If any test asserts on verification behavior rather than response strings, that is a separate task.
- Note: some tests may be stale against the *current* code (e.g., asserting "deleted successfully" when the code already says "Tag deleted (verified)"). These need updating to match Phase 1 labels directly — there is no intermediate step.

**Test quality improvement:**
- Where practical, refactor assertions to use substring/semantic matching rather than exact sentence matching. Tests should assert: (a) operation outcome, and (b) certainty tier label is present. This reduces brittleness for future wording changes.

**Files:** `tests/system/*.test.ts`

### T1.3 — Correct all overclaim surfaces

Audit and fix every document that currently claims stronger guarantees than the code provides:

- **SPECIFICATION.md**: Replace false claim about Bear's x-callback-url capabilities with accurate description. Document the three-tier verification model as the project's verification contract. Describe SQLite read-after-write as the primary trust model by design, not by limitation.
- **README.md**: Ensure "write verification" language references the three-tier model. No unqualified "verified writes" claims.
- **manifest.json**: Audit tool descriptions for verification language.
- **Context docs** (`.claude/contexts/`): Audit for stale verification claims.
- **MCP server instructions** (in `main.ts` server config): Audit for overclaim language.
- **Per-tool description strings** (in `main.ts` tool registrations): These are user-facing text that Claude reads when selecting tools. Examples: `bear-trash-note` says "Verifies the note was actually trashed via database check"; `bear-upsert-note` says "Returns the note as it actually exists after the operation." Audit each description for language that overstates what the verification actually does.

**Files:** `.claude/contexts/SPECIFICATION.md`, `README.md`, `manifest.json`, `src/main.ts` (server instructions block + all tool description strings), any other docs found during audit

### T1.4 — Document current verification semantics

Add the per-tool verification matrix (from this spec) to the specification as the current verification contract. Format as a table, not narrative prose. Include columns: tool, path, evidence checked, current tier, limitations, fallback behavior.

This becomes the baseline that Track 2 improves against and the reference for future audits.

**Files:** `.claude/contexts/SPECIFICATION.md`

---

## Track 2: Verification Upgrade

Gated on an empirical test of Bear's normalization behavior. Only ships what the evidence supports.

### T2.0 — Define acceptance criteria (before testing)

Commit acceptance criteria before running any tests:

- **Clean:** Across 20+ unique content patterns, each tested via at least a create path and a mutation path (as defined in T2.1), the persisted text in SQLite equals the sent text as JavaScript strings after DB read-back. No transformations observed. **Result:** Implement exact string comparison.

- **Predictable:** Bear applies deterministic, reproducible transformations that can be expressed as a small fixed normalization function. The function does not depend on ambiguous context, timing, or hidden state. Transformations are consistent across the tested operation types (create, append, prepend, replace_all, and header-targeted mutation). **Result:** Implement comparison with the normalization function applied to both expected and actual before comparing.

- **Unpredictable:** Transformations vary by operation type, content shape, timing, or hidden state in a way that cannot be reproduced confidently. **Result:** No content comparison shipped. Text writes remain "state confirmed" with current heuristic checks. Findings documented. No label upgrade without deterministic comparison support.

**Files:** Committed as a test fixture or document before T2.1 runs.

### T2.1 — Empirical normalization test

A dedicated test suite run against a live Bear installation.

**Critical: bypass ALL preprocessing layers.** Two layers apply `.trim()` before Bear sees text: the MCP tool schemas (e.g., `main.ts:136-139`) and `buildBearUrl` itself (`bear-urls.ts:57`). If the test writes through either layer, it measures our own preprocessing, not Bear's persistence behavior. The normalization test must construct x-callback-urls manually and pass them directly to `executeBearXCallbackApi` (or raw `open -g` commands) to send completely unmodified text to Bear. This separates two distinct questions:
1. What does our schema do to input? (Known: `.trim()` strips leading/trailing whitespace)
2. What does Bear do to what it receives? (Unknown: this is what the test measures)

**Test isolation:**
- All test notes use a dedicated prefix (e.g., `[BEAR-MCP-TEST]`) and tag
- Cleanup in afterAll removes test notes
- Suite can be re-run safely without affecting user notes
- Test patterns must not collide with real user notes by title

**Content pattern matrix** (minimum 20 unique patterns):
- Plain text, single paragraph
- Markdown with headers (H1, H2, H3)
- YAML frontmatter block
- Trailing newlines (0, 1, 2, 3)
- Trailing whitespace on lines
- `\r\n` vs `\n` line endings
- Inline Bear tags at end of body
- Unicode content (emoji, accented characters, CJK)
- Large body (10KB+)
- Empty sections between headers
- Bear wiki-links (`[[Note Title]]` and `[[Note Title|Display Text]]`)
- Mixed content (YAML + headers + tags + wiki-links)

**Operation type coverage:**
Each content pattern must be tested via at least two distinct Bear API paths: one create and one mutation. This is the minimum coverage because Bear may normalize differently for create vs. add-text operations. Each operation type must be tested with multiple content patterns:
- `/create` (create path)
- `/add-text` append (mutation path)
- `/add-text` prepend (mutation path)
- `/add-text` replace_all (mutation path — used by full-body replace, upsert replace, and add-tag)
- `/add-text` with `header` parameter (header-targeted mutation — minimum 3 content patterns as a deliberate exception to the broader "multiple patterns" rule; this is reduced coverage because the Bear API endpoint is the same, but the `header` parameter changes the request shape)

Header-targeted append/prepend routes through the same `handleNoteTextUpdate` code path but sends a different request shape to Bear (the `header` parameter is included in the URL). While field experience suggests Bear does not normalize differently based on section targeting, this is an assumption that must be spot-checked: include at least one header-targeted mutation in the test matrix. If results differ from note-level mutation, expand coverage. Document findings either way.

Section replace uses splice + replace_all, which is the same Bear API call as full-body replace_all. Testing replace_all covers both paths at the Bear API level.

**Read-back timing:**
Use the same bounded polling semantics as the real verification path (25ms intervals, 2s timeout). Do not read "immediately" — test persisted behavior, not timing artifacts.

**Committed artifacts:**
- Test harness (runnable, in `tests/system/`)
- Compact findings document: what was tested, what was observed, conclusion (clean/predictable/unpredictable)
- Sanitized results table (no real note content, user IDs, or machine-specific data)

**Files:** `tests/system/normalization.test.ts`, `docs/normalization-findings.md`

### T2.2 — Implement content comparison (if T2.1 result is clean or predictable)

Two implementation components:

#### Central expected-body computation

Define a `computeExpectedBody` function in `src/utils.ts` that takes the operation type, current body, new text, and context (header, tags) and returns the expected post-write body. This centralizes the formulas instead of scattering them across call sites:

| Operation | Expected body formula | Status |
|-----------|----------------------|--------|
| Full-body replace / upsert replace | `appendTagsToBody(text, preWriteTags)` | Already computed at call sites |
| Section replace | `spliceSection()` output + `appendTagsToBody` | Already computed at call sites |
| Append | current body + `\n` + new text (mirrors `new_line: 'yes'` in the Bear URL, which inserts a newline before appended text; if current body already ends with `\n`, Bear does not double it — verify empirically in T2.1) | Needs computation |
| Prepend | new text + `\n` + current body (mirrors `new_line: 'yes'`; same newline-doubling question applies) | Needs computation |
| Add-tag | `appendTagsToBody(existingNote.text, allTags)` | Already computed at call sites |
| Create / upsert-create | sent text | Create operations use poll-by-title (existence check), not content read-back. They remain "state confirmed" in Phase 1. Extending create verification to include content read-back is explicitly out of scope. |

#### Upgraded `verifyNoteAfterWrite`

Upgrade `verifyNoteAfterWrite` to accept the expected post-write body as a parameter:

1. Each call site passes the expected body (computed via `computeExpectedBody`) before writing
2. Apply normalization function (if predictable, per T2.1 findings) to both expected and actual
3. Compare strings
4. Match → operation earns "content matched"
5. No match → fall through to heuristic checks for diagnostic detail, report failure

**Fail-closed rule:** The expected-vs-actual comparison decides success. Heuristics are failure diagnostics only — they explain *why* content didn't match. Heuristics never rescue a mismatch back into "content matched" or "state confirmed." A mismatch is a failure, period.

Only paths with working expected-vs-actual comparison are upgraded to "content matched." All other paths remain "state confirmed" or "dispatched, unverified."

**Files:** `src/utils.ts` (`computeExpectedBody`, `verifyNoteAfterWrite`), `src/main.ts` (call sites), `src/utils.ts` (`handleNoteTextUpdate`)

### T2.3 — If normalization is unpredictable

No content comparison shipped. Instead:
- Normalization findings documented in specification
- Text write operations remain "state confirmed" with current heuristic checks
- Verification matrix updated to reflect findings
- No label upgrade without deterministic comparison support
- Phase 2 can revisit with alternative approaches

---

## Scope Boundary

**Not in Phase 1:**
- File attachment content verification (size comparison via `ZSFNOTEFILE.ZFILESIZE` against decoded base64 byte length) — Phase 2
- New tools (bear-check-structure, bear-diff, structured reading) — Phase 2
- OCR toggle on bear-open-note — Phase 2
- Exact-title lookup for upsert/add-file resolution — Phase 2
- x-callback-url bridge — future consideration, not on current roadmap

**Rationale for deferring exact-title lookup:** While identified as a genuine safety improvement, it is a query-path change that doesn't affect verification honesty. Phase 1 is focused exclusively on making the verification layer truthful. Exact-title lookup ships in Phase 2 alongside the feature work it supports.

---

## Success Criteria

Phase 1 is complete when Track 1 ships. Track 2 either ships or its findings are documented explaining why content comparison was not viable.

### Track 1 ship criteria (required for Phase 1 completion)

1. All existing unit tests pass (53).
2. All system tests pass, including updated assertions. (Actual failure count to be inventoried before execution — do not assume "9" without verification.)
3. No write-tool success response uses the word "verified."
4. Every write-tool success path emits exactly one of: `content matched`, `state confirmed`, or `dispatched, unverified`.
5. Every write-tool failure path remains an explicit failure with diagnostics, not a downgraded success tier.
6. For every write-tool success path, the emitted tier matches the strongest evidence actually checked by that path.
7. System tests for write operations assert both operation outcome and certainty tier.
8. The verification matrix in the spec matches actual code behavior path-by-path.
9. No user-facing docs, tool descriptions, or context docs claim stronger guarantees than the code provides.

### Track 2 criteria (required for Phase 1 closure, not for Track 1 shipment)

10. Normalization acceptance criteria are committed before the empirical test runs.
11. Normalization findings are documented and committed regardless of outcome.
12. If normalization is deterministic enough to support reproducible comparison, only those paths with expected-vs-actual comparison earn "content matched." All other paths remain "state confirmed" or "dispatched, unverified."
13. If normalization is unpredictable, no content comparison ships and this is documented as the reason. Text writes remain "state confirmed."
