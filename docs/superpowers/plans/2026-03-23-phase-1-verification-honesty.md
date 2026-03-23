# Phase 1: Verification Honesty — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bear-mcp verification layer honest — no tool overstates certainty — and, where empirically supported, upgrade it to expected-vs-actual content comparison.

**Architecture:** Two parallel tracks. Track 1 (Tasks 1–5) ships unconditionally: relabel all response strings to a three-tier model, fix stale tests, correct documentation. Track 2 (Tasks 6–9) is gated on empirical testing of Bear's normalization behavior: if Bear preserves text exactly, upgrade verification to full content comparison.

**Tech Stack:** TypeScript, Node.js 24, `node:sqlite`, vitest (unit), custom system tests against live Bear

**Spec:** `docs/superpowers/specs/2026-03-23-phase-1-verification-honesty-design.md`

---

## File Structure

**Modified files (Track 1):**
- `src/main.ts` — response strings in all 10 write-tool handlers + tool descriptions + server instructions
- `src/utils.ts` — response strings in `handleNoteTextUpdate`
- `tests/system/tag-management.test.ts` — stale string assertions
- `tests/system/*.test.ts` — any other stale assertions (inventory first)
- `.claude/contexts/SPECIFICATION.md` — false API claim, verification matrix
- `README.md` — overclaim language
- `manifest.json` — overclaim in tool descriptions

**Modified files (Track 2, conditional):**
- `src/utils.ts` — `computeExpectedBody` function, `verifyNoteAfterWrite` upgrade
- `src/main.ts` — pass expected body at call sites

**New files (Track 2):**
- `tests/system/normalization.test.ts` — empirical normalization test harness
- `docs/normalization-acceptance-criteria.md` — committed before testing
- `docs/normalization-findings.md` — results regardless of outcome

---

## Track 1: Honesty

### Task 1: Relabel success response strings in main.ts

**Files:**
- Modify: `src/main.ts:179,526,754,807,871,925,1061,1088,1148`

- [ ] **Step 1: Replace bear-create-note success string**

In `src/main.ts:179`, replace:
```typescript
const responseLines: string[] = ['Note created (verified).', ''];
```
with:
```typescript
const responseLines: string[] = ['Note created (state confirmed).', ''];
```

- [ ] **Step 2: Replace bear-add-file success string**

In `src/main.ts:526`, replace:
```typescript
return createToolResponse(`File "${filename}" added (verified).\n\n${noteIdentifier}`);
```
with:
```typescript
return createToolResponse(`File "${filename}" added (state confirmed).\n\n${noteIdentifier}`);
```

- [ ] **Step 3: Replace bear-add-tag success string**

In `src/main.ts:754`, replace:
```typescript
`Tags added (verified).\n\nNote: "${existingNote.title}"\nTags: ${tagList}\nNote ID: ${id}`
```
with:
```typescript
`Tags added (state confirmed).\n\nNote: "${existingNote.title}"\nTags: ${tagList}\nNote ID: ${id}`
```

- [ ] **Step 4: Replace bear-archive-note success string**

In `src/main.ts:807`, replace:
```typescript
`Note archived (verified).\n\nNote: "${existingNote.title}"\nID: ${id}`
```
with:
```typescript
`Note archived (state confirmed).\n\nNote: "${existingNote.title}"\nID: ${id}`
```

- [ ] **Step 5: Replace bear-rename-tag success string**

In `src/main.ts:871`, replace:
```typescript
return createToolResponse(`Tag renamed (verified).\n\nFrom: #${name}\nTo: #${new_name}`);
```
with:
```typescript
return createToolResponse(`Tag renamed (state confirmed).\n\nFrom: #${name}\nTo: #${new_name}`);
```

- [ ] **Step 6: Replace bear-delete-tag success string**

In `src/main.ts:925`, replace:
```typescript
return createToolResponse(`Tag deleted (verified).\n\nTag: #${name}`);
```
with:
```typescript
return createToolResponse(`Tag deleted (state confirmed).\n\nTag: #${name}`);
```

- [ ] **Step 7: Replace bear-upsert-note replace success string**

In `src/main.ts:1061`, replace:
```typescript
`Note replaced and verified.\n\nNote ID: ${resolvedId}\nTitle: "${updatedNote?.title}"\n\n---\n\n${noteBody}`
```
with:
```typescript
`Note replaced (state confirmed).\n\nNote ID: ${resolvedId}\nTitle: "${updatedNote?.title}"\n\n---\n\n${noteBody}`
```

- [ ] **Step 8: Replace bear-upsert-note create success string**

In `src/main.ts:1088`, replace:
```typescript
`Note created and verified.\n\nNote ID: ${createdId}\nTitle: "${createdNote?.title}"\n\n---\n\n${noteBody}`
```
with:
```typescript
`Note created (state confirmed).\n\nNote ID: ${createdId}\nTitle: "${createdNote?.title}"\n\n---\n\n${noteBody}`
```

- [ ] **Step 9: Replace bear-trash-note success string**

In `src/main.ts:1148`, replace:
```typescript
`Note trashed and verified.\n\nNote: "${existingNote.title}"\nID: ${id}`
```
with:
```typescript
`Note trashed (state confirmed).\n\nNote: "${existingNote.title}"\nID: ${id}`
```

- [ ] **Step 10: Run unit tests**

Run: `npm test`
Expected: All 53 unit tests pass (response string changes don't affect unit tests)

- [ ] **Step 11: Commit**

```bash
git add src/main.ts
git commit -m "refactor: relabel success response strings — '(verified)' → '(state confirmed)'"
```

---

### Task 2: Relabel handleNoteTextUpdate success string in utils.ts

**Files:**
- Modify: `src/utils.ts:465`

- [ ] **Step 1: Replace the success string**

In `src/utils.ts:465`, replace:
```typescript
      `Text ${action} ${preposition} note "${existingNote.title}" (verified).`,
```
with:
```typescript
      `Text ${action} ${preposition} note "${existingNote.title}" (state confirmed).`,
```

- [ ] **Step 2: Run unit tests**

Run: `npm test`
Expected: All 53 pass

- [ ] **Step 3: Commit**

```bash
git add src/utils.ts
git commit -m "refactor: relabel handleNoteTextUpdate success — '(verified)' → '(state confirmed)'"
```

---

### Task 3: Relabel timeout/fallback and failure strings

**Files:**
- Modify: `src/main.ts:188,532,537,814,877,931,1093,1155`
- Modify: `src/utils.ts:453`

- [ ] **Step 1: Replace bear-create-note fallback**

In `src/main.ts:188`, replace:
```typescript
        'Note created (unverified — could not recover note ID).',
```
with:
```typescript
        'Note created (dispatched, unverified — could not recover note ID).',
```

- [ ] **Step 2: Replace bear-add-file timeout**

In `src/main.ts:532`, replace:
```typescript
          `File add sent but verification failed — "${filename}" not yet in database.\n\n${noteIdentifier}\nCheck Bear manually.`
```
with:
```typescript
          `File add (dispatched, unverified) — "${filename}" not yet in database.\n\n${noteIdentifier}\nCheck Bear manually.`
```

- [ ] **Step 3: Replace bear-add-file fallback**

In `src/main.ts:537`, replace:
```typescript
        `File "${filename}" added (unverified — could not resolve note ID).\n\n${noteIdentifier}`
```
with:
```typescript
        `File "${filename}" added (dispatched, unverified — could not resolve note ID).\n\n${noteIdentifier}`
```

- [ ] **Step 4: Replace bear-archive-note timeout**

In `src/main.ts:814`, replace:
```typescript
        `Archive command sent but verification failed — note "${existingNote.title}" may not be archived.\n\nID: ${id}\nCheck Bear manually.`
```
with:
```typescript
        `Note archive (dispatched, unverified) — could not confirm note "${existingNote.title}" was archived.\n\nID: ${id}\nCheck Bear manually.`
```

- [ ] **Step 5: Replace bear-rename-tag timeout**

In `src/main.ts:877`, replace:
```typescript
        `Rename command sent but verification failed — could not confirm #${name} was renamed to #${new_name}.\n\nCheck Bear manually.`
```
with:
```typescript
        `Tag rename (dispatched, unverified) — could not confirm #${name} was renamed to #${new_name}.\n\nCheck Bear manually.`
```

- [ ] **Step 6: Replace bear-delete-tag timeout**

In `src/main.ts:931`, replace:
```typescript
        `Delete command sent but verification failed — #${name} may still exist.\n\nCheck Bear manually.`
```
with:
```typescript
        `Tag delete (dispatched, unverified) — #${name} may still exist.\n\nCheck Bear manually.`
```

- [ ] **Step 7: Replace bear-upsert-note create fallback**

In `src/main.ts:1093`, replace:
```typescript
          'Note created (unverified — could not recover note ID). Use bear-search-notes to confirm.'
```
with:
```typescript
          'Note created (dispatched, unverified — could not recover note ID). Use bear-search-notes to confirm.'
```

- [ ] **Step 8: Replace bear-trash-note timeout**

In `src/main.ts:1155`, replace:
```typescript
        `Trash command sent but verification failed — note "${existingNote.title}" may not be trashed.\n\nID: ${id}\nCheck Bear manually.`
```
with:
```typescript
        `Note trash (dispatched, unverified) — could not confirm note "${existingNote.title}" was trashed.\n\nID: ${id}\nCheck Bear manually.`
```

- [ ] **Step 9: Update failure strings — keep "FAILED" but remove "verification"**

In `src/utils.ts:453`, replace:
```typescript
      return createToolResponse(`Write verification FAILED for note "${existingNote.title}".
```
with:
```typescript
      return createToolResponse(`Write FAILED for note "${existingNote.title}".
```

In `src/main.ts:749`, replace:
```typescript
          `Tag add verification FAILED for note "${existingNote.title}".\n\n${failureDetails}\n\nNote ID: ${id}`
```
with:
```typescript
          `Tag add FAILED for note "${existingNote.title}".\n\n${failureDetails}\n\nNote ID: ${id}`
```

In `src/main.ts:1052`, replace:
```typescript
            `Upsert verification FAILED for note "${existingNote.title}".\n\n${failureDetails}\n\nNote ID: ${resolvedId}\nUse bear-open-note to inspect the current state.`
```
with:
```typescript
            `Upsert FAILED for note "${existingNote.title}".\n\n${failureDetails}\n\nNote ID: ${resolvedId}\nUse bear-open-note to inspect the current state.`
```

- [ ] **Step 10: Add tier labels to no-op success paths**

In `src/main.ts:720`, replace:
```typescript
          `Tags already present on note "${existingNote.title}".\n\nTags: ${tagList}\nNote ID: ${id}`
```
with:
```typescript
          `Tags already present (state confirmed).\n\nNote: "${existingNote.title}"\nTags: ${tagList}\nNote ID: ${id}`
```

In `src/main.ts:1035`, replace:
```typescript
            `Note already matches the provided content.\n\nNote ID: ${resolvedId}\nTitle: "${existingNote.title}"`
```
with:
```typescript
            `Note already matches the provided content (state confirmed).\n\nNote ID: ${resolvedId}\nTitle: "${existingNote.title}"`
```

- [ ] **Step 11: Grep for any remaining "verified" in response strings**

Run: `grep -n 'verified\|Verified\|VERIFIED' src/main.ts src/utils.ts | grep -v '^\s*//' | grep -v 'import'`
Expected: No matches in response strings. (Comments and variable names like `verification` are acceptable.)

- [ ] **Step 12: Run unit tests**

Run: `npm test`
Expected: All 53 pass

- [ ] **Step 13: Commit**

```bash
git add src/main.ts src/utils.ts
git commit -m "refactor: relabel fallback, failure, and no-op response strings to three-tier model"
```

---

### Task 4: Inventory and fix stale system test assertions

**Files:**
- Modify: `tests/system/tag-management.test.ts:50,94,141,180`
- Potentially modify: other `tests/system/*.test.ts` files

- [ ] **Step 1: Run system tests and inventory failures**

Run: `npm run test:system 2>&1 | tail -60`
Record the exact count and location of every failing assertion. Do not assume "9" — count the real number.

- [ ] **Step 2: Categorize each failure**

For each failure, determine:
- Is it a pure string assertion mismatch? (Fix in this task)
- Does it test verification behavior? (Separate task if any)

- [ ] **Step 3: Fix tag-management.test.ts assertions**

These are known stale assertions. Update to use substring matching for tier labels:

In `tests/system/tag-management.test.ts:50`, replace:
```typescript
    expect(result).toContain('renamed successfully');
```
with:
```typescript
    expect(result).toContain('state confirmed');
    expect(result).toContain('renamed');
```

In `tests/system/tag-management.test.ts:94`, replace:
```typescript
    expect(result).toContain('deleted successfully');
```
with:
```typescript
    expect(result).toContain('state confirmed');
    expect(result).toContain('deleted');
```

In `tests/system/tag-management.test.ts:141`, replace:
```typescript
    expect(result).toContain('renamed successfully');
```
with:
```typescript
    expect(result).toContain('state confirmed');
    expect(result).toContain('renamed');
```

In `tests/system/tag-management.test.ts:180`, replace:
```typescript
    expect(result).toContain('deleted successfully');
```
with:
```typescript
    expect(result).toContain('state confirmed');
    expect(result).toContain('deleted');
```

- [ ] **Step 4: Fix any other stale assertions found in Step 1**

Update each using the same substring/semantic pattern: assert operation outcome + tier label presence.

- [ ] **Step 5: Run system tests**

Run: `npm run test:system`
Expected: All tests pass (this requires Bear.app running on host)

- [ ] **Step 6: Commit**

```bash
git add tests/system/
git commit -m "test: update system test assertions to three-tier response model"
```

---

### Task 5: Correct overclaim surfaces and document verification matrix

**Files:**
- Modify: `.claude/contexts/SPECIFICATION.md`
- Modify: `README.md`
- Modify: `manifest.json:99,103`
- Modify: `src/main.ts:945,1108` (tool descriptions)

- [ ] **Step 1: Fix SPECIFICATION.md false API claim**

In `.claude/contexts/SPECIFICATION.md`, find the section about x-callback-url and replace the false claim. The current text at line 30 says:

> "Bear's x-callback-url has no x-success callback that works without a running server to receive it"

Replace with accurate text:

```markdown
### Bear's URL Scheme and Verification

Bear supports x-success callbacks that return useful data for several operations:
- `/create` returns `identifier` and `title`
- `/add-text` returns `note` (full body) and `title`
- `/add-file` returns `note` (full body)
- `/trash`, `/archive`, `/rename-tag`, `/delete-tag` have no documented return values

However, the MCP server cannot natively receive these callbacks — x-callback-url requires a macOS app bundle with a registered URL scheme to accept the response. The server is a Node.js process without URL scheme registration.

SQLite read-after-write is the primary verification model by design, not by limitation. It checks persisted state — what Bear actually wrote to disk — which is a stronger trust source than Bear's x-callback-url self-report. The x-callback-url bridge remains a future consideration for additional confirmation signal.
```

- [ ] **Step 2: Add verification contract to SPECIFICATION.md**

Append a new section documenting the three-tier model and verification matrix table from the spec (the full matrix with Tool, Path, Evidence Checked, Tier, Limitations, Fallback columns). Include the note: "For text-write operations, 'state confirmed' means heuristic post-write checks passed, not exact expected-vs-actual content equality."

- [ ] **Step 3: Fix README.md overclaim language**

In `README.md`, the opening line says "with write verification" and the "Write verification" section does not qualify what verification means. Update to reference the three-tier model. Replace:

```markdown
**Write verification:**
- Post-write read-back checks on all mutating operations
```

with:

```markdown
**Write verification (three-tier certainty model):**
- Post-write read-back checks on all mutating operations with explicit certainty labeling:
  - *content matched* — expected body equals actual persisted body
  - *state confirmed* — database state change confirmed (flag, tag, row)
  - *dispatched, unverified* — request sent, no post-state confirmation
```

- [ ] **Step 4: Fix manifest.json overclaim language**

In `manifest.json:99`, replace:
```json
      "description": "Create a new note or replace an existing one entirely, with tag preservation and verified write-back"
```
with:
```json
      "description": "Create a new note or replace an existing one entirely, with tag preservation and post-write state confirmation"
```

In `manifest.json:103`, replace:
```json
      "description": "Move a note to Bear's trash with database verification that the trash operation succeeded"
```
with:
```json
      "description": "Move a note to Bear's trash with database state confirmation"
```

- [ ] **Step 5: Fix tool description strings in main.ts**

In `src/main.ts:945`, replace:
```typescript
      'Create a new Bear note or replace an existing one entirely. If a note with the given ID exists (or a unique title match is found), replaces it with the provided content while preserving tags. If no match, creates a new note. Returns the note as it actually exists after the operation — not just "success".',
```
with:
```typescript
      'Create a new Bear note or replace an existing one entirely. If a note with the given ID exists (or a unique title match is found), replaces it with the provided content while preserving tags. If no match, creates a new note. Returns the note content after the operation for confirmation.',
```

In `src/main.ts:1108`, replace:
```typescript
      "Move a note to Bear's trash. Unlike archive, trashed notes are eventually deleted. Verifies the note was actually trashed via database check. Use bear-search-notes first to get the note ID.",
```
with:
```typescript
      "Move a note to Bear's trash. Unlike archive, trashed notes are eventually deleted. Confirms the trash state via database check. Use bear-search-notes first to get the note ID.",
```

- [ ] **Step 6: Scan for any remaining overclaim language**

Run: `grep -rn 'verified\|Verifies\|verification' README.md manifest.json .claude/contexts/SPECIFICATION.md src/main.ts | grep -v node_modules | grep -v '^\s*//'`

Review each match. Variable names (`verification`, `verifyNoteAfterWrite`) are fine. User-facing text claiming "verified" or "Verifies" should be fixed.

- [ ] **Step 7: Run unit tests**

Run: `npm test`
Expected: All 53 pass

- [ ] **Step 8: Commit**

```bash
git add .claude/contexts/SPECIFICATION.md README.md manifest.json src/main.ts
git commit -m "docs: correct overclaim surfaces — three-tier verification model, accurate API description"
```

---

## Track 2: Verification Upgrade

### Task 6: Commit normalization acceptance criteria

**Files:**
- Create: `docs/normalization-acceptance-criteria.md`

- [ ] **Step 1: Write acceptance criteria document**

Create `docs/normalization-acceptance-criteria.md`:

```markdown
# Bear Normalization Test — Acceptance Criteria

Committed before any normalization testing. Defines what outcomes mean.

## Clean
Across 20+ unique content patterns, each tested via create and mutation paths,
the persisted text in SQLite equals the sent text as JavaScript strings after
DB read-back. No transformations observed.

**Result:** Implement exact string comparison in `verifyNoteAfterWrite`.

## Predictable
Bear applies deterministic, reproducible transformations expressible as a small
fixed normalization function. The function does not depend on ambiguous context,
timing, or hidden state. Transformations are consistent across create, append,
prepend, replace_all, and header-targeted mutation.

**Result:** Implement comparison with normalization applied to both sides.

## Unpredictable
Transformations vary by operation type, content shape, timing, or hidden state.

**Result:** No content comparison shipped. Text writes remain "state confirmed."
```

- [ ] **Step 2: Commit**

```bash
git add docs/normalization-acceptance-criteria.md
git commit -m "docs: commit normalization acceptance criteria before empirical testing"
```

---

### Task 7: Build and run normalization test harness

**Files:**
- Create: `tests/system/normalization.test.ts`

**Important:** This test must bypass ALL preprocessing layers. It constructs x-callback-urls manually (not through `buildBearUrl` which trims) and passes them directly to `executeBearXCallbackApi`. It requires Bear.app running on the host.

- [ ] **Step 1: Create test harness skeleton**

Create `tests/system/normalization.test.ts` with:
- Helper function that constructs raw Bear x-callback-urls without any `.trim()`
- Helper function that reads back from SQLite using `getNoteRaw`
- Helper that polls with 25ms interval / 2s timeout (same as production verification)
- Test isolation: unique prefix `[BEAR-MCP-NORM-TEST]`, cleanup in `afterAll`
- At least 20 unique content patterns from the spec's matrix
- Each pattern tested via `/create` and `/add-text` (append + replace_all)
- At least 3 patterns tested via header-targeted `/add-text`
- Byte-for-byte string comparison of sent vs. persisted text
- Results collected into a structured summary

- [ ] **Step 2: Run the normalization test**

Run: `npm run test:system -- --testPathPattern normalization`
Record all results. For any mismatches, document exactly what changed.

- [ ] **Step 3: Classify result as clean/predictable/unpredictable**

Compare results against the acceptance criteria committed in Task 6.

- [ ] **Step 4: Write findings document**

Create `docs/normalization-findings.md` with:
- Date, Bear version, macOS version
- Summary of what was tested
- Results table (sanitized — no real content or machine-specific data)
- Classification: clean / predictable / unpredictable
- If predictable: exact normalization rules discovered
- If unpredictable: what varied and why content comparison is not viable

- [ ] **Step 5: Commit**

```bash
git add tests/system/normalization.test.ts docs/normalization-findings.md
git commit -m "test: empirical Bear normalization test — [RESULT: clean/predictable/unpredictable]"
```

---

### Task 8: Implement computeExpectedBody and upgrade verification (if clean or predictable)

**Gate:** Only proceed if Task 7 result is "clean" or "predictable."

**Files:**
- Modify: `src/utils.ts` — add `computeExpectedBody`, upgrade `verifyNoteAfterWrite`
- Modify: `src/main.ts` — pass expected body at call sites
- Create: `src/utils.test.ts` additions for `computeExpectedBody`

- [ ] **Step 1: Write failing tests for computeExpectedBody**

Add tests to the unit test suite for:
- Full-body replace: `computeExpectedBody('replace_all', currentBody, newText, { tags })` returns `appendTagsToBody(newText, tags)`
- Section replace: `computeExpectedBody('section_replace', currentBody, newText, { header, tags })` returns spliced body with tags
- Append: `computeExpectedBody('append', currentBody, newText, {})` returns `currentBody + '\n' + newText` (adjust based on T2.1 findings about `new_line: 'yes'` behavior)
- Prepend: `computeExpectedBody('prepend', currentBody, newText, {})` returns `newText + '\n' + currentBody`
- Add-tag: `computeExpectedBody('add_tag', currentBody, '', { tags })` returns `appendTagsToBody(currentBody, tags)`

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: New tests fail with "computeExpectedBody is not defined"

- [ ] **Step 3: Implement computeExpectedBody**

In `src/utils.ts`, add the function. Centralize all expected-body formulas. If T2.1 found predictable normalization, include the normalization function.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All tests pass including new ones

- [ ] **Step 5: Upgrade verifyNoteAfterWrite signature**

Add optional `expectedBody?: string` parameter. When provided:
1. Apply normalization (if any) to both expected and actual
2. Compare strings
3. If match: return `{ success: true, contentMatched: true }`
4. If no match: run existing heuristic checks for diagnostics, return failure
5. Heuristics never rescue a mismatch

When `expectedBody` is not provided, fall back to existing heuristic-only behavior.

- [ ] **Step 6: Update call sites to pass expected body**

In `src/utils.ts` (`handleNoteTextUpdate`): compute expected body before writing, pass to `verifyNoteAfterWrite`.

In `src/main.ts` (`bear-add-tag`): pass `bodyWithNewTags` as expected body.

In `src/main.ts` (`bear-upsert-note` replace): pass `bodyWithTags` as expected body.

- [ ] **Step 7: Update response strings to "content matched" for upgraded paths**

Where `verifyNoteAfterWrite` returns `contentMatched: true`, change the response tier from "(state confirmed)" to "(content matched)".

- [ ] **Step 8: Run all tests**

Run: `npm test && npm run test:system`
Expected: All pass

- [ ] **Step 9: Commit**

```bash
git add src/utils.ts src/main.ts tests/
git commit -m "feat: upgrade verification to expected-vs-actual content comparison

Adds computeExpectedBody for centralized expected-state computation.
verifyNoteAfterWrite now compares expected vs. actual when provided.
Qualifying paths upgraded from 'state confirmed' to 'content matched'.
Heuristic checks retained as failure diagnostics only."
```

---

### Task 9: Document findings if normalization is unpredictable

**Gate:** Only proceed if Task 7 result is "unpredictable."

**Files:**
- Modify: `.claude/contexts/SPECIFICATION.md`

- [ ] **Step 1: Document normalization findings in specification**

Add a section to SPECIFICATION.md documenting:
- What was tested
- Why content comparison is not viable
- That text writes remain "state confirmed" with heuristic checks
- That no label upgrade is possible without deterministic comparison support

- [ ] **Step 2: Commit**

```bash
git add .claude/contexts/SPECIFICATION.md
git commit -m "docs: document Bear normalization findings — content comparison not viable"
```

---

## Verification Checklist

After all tasks complete, verify these success criteria:

- [ ] `npm test` — all unit tests pass
- [ ] `npm run test:system` — all system tests pass
- [ ] `grep -rn 'verified' src/main.ts src/utils.ts` — no "(verified)" in response strings (variable names OK)
- [ ] Every write-tool success path emits one of: "content matched", "state confirmed", "dispatched, unverified"
- [ ] Every failure path remains an explicit failure with diagnostics
- [ ] README, manifest.json, SPECIFICATION.md, tool descriptions — no overclaims
- [ ] Normalization findings committed regardless of outcome
