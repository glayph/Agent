Complex Issue Resolution Skill

Purpose

Systematically fix issues from "problem.md" with:

Analyze → Plan → Implement → Test → Verify → Complete

Track open issues only under problems/. Do not keep solved-issue archives in-repo.

---

1. Priority

Priority| Meaning| Required Verification
🔴 Critical| Security / data loss| Full testing + review
🟠 High| Core functionality| Automated + manual
🟡 Medium| Reliability / quality| Automated preferred
🟢 Low| Maintenance / minor| Basic verification

---

2. Issue Structure

Each issue gets a dedicated directory:


Rule: Keep open issues in problems/. Remove entries once verified fixed.

---

3. Status

📊 Analyzing
📝 Planning
🔨 In Progress
🧪 Testing
🔍 Verifying
✅ Complete
🚧 Blocked
⏸️ Paused
🔄 Needs Revision
❌ Won't Fix

Normal flow:

📊 → 📝 → 🔨 → 🧪 → 🔍 → ✅

Failed testing/verification → "🔄 Needs Revision".

---

4. Analysis

Before modifying code:

1. Read the complete issue.
2. Inspect affected code.
3. Search related implementations.
4. Inspect existing tests.
5. Check dependencies and Git history when relevant.
6. Reproduce the issue when possible.
7. Identify the actual root cause.

Record in "analysis.md":

Problem
Expected behavior
Actual behavior
Impact
Evidence
Root cause
Affected components
Dependencies
Risks

Never treat an unverified hypothesis as the root cause.

---

5. Planning

Create "plan.md" containing:

Proposed solution
Alternatives (only if relevant)
Implementation steps
Dependencies
Risks
Acceptance criteria

Break complex work into independent chunks.

Each chunk must have:

Objective
Files/components
Tasks
Expected result
Verification
Status

---

6. Implementation

For each chunk:

1. Modify only required files.
2. Follow existing project conventions.
3. Preserve compatibility unless intentionally changed.
4. Add/update tests.
5. Handle errors appropriately.
6. Avoid unrelated refactoring.
7. Record meaningful changes in "implementation.md".

Do not:

- Delete tests to hide failures.
- Suppress errors.
- Make speculative changes.
- Mix unrelated fixes.
- Claim success without verification.

---

7. Testing

Testing must match the issue.

Check when applicable:

Type checking
Lint
Build
Unit tests
Integration tests
E2E tests
Manual verification
Edge cases
Error cases
Regression
Performance

Record in "testing.md":

Test
Expected
Actual
Result
Evidence

Do not write only "tests passed".

---

8. Verification

Testing proves the implementation behaves correctly.

Verification proves it actually solves the original issue.

Create "verification.md":

Original problem
Acceptance criteria
Verification results
Regression result
Remaining concerns

---

9. Completion Gate

An issue may become "✅ Complete" only when:

[x] Root cause identified
[x] Implementation complete
[x] Acceptance criteria satisfied
[x] Required tests pass
[x] Regression checked
[x] Verification completed
[x] progress/ updated

No evidence = No completion.

---

10. Blocked

Use "🚧 Blocked" only when work cannot continue.

Record:

Blocking reason
Dependency
Completed work
Unblock condition
Next action

Never invent an unblock date.

---

11. Needs Revision

Use "🔄 Needs Revision" when:

- Tests fail.
- Verification fails.
- Root cause was incorrect.
- Regression is introduced.
- Review finds a defect.

Record the failure and corrective action before continuing.

---

12. Won't Fix

Use "❌ Won't Fix" only with a documented reason:

Reason
Decision
Accepted risks
Alternative/workaround

---

13. Git Safety

Before and after meaningful changes:

git status
git diff

Use when relevant:

git log
git blame

Rules:

- Do not overwrite unrelated user changes.
- Do not perform destructive Git operations without explicit need.
- Keep issue changes focused.
- Record relevant commit hashes when available.

---

14. Resume Rule

When resuming interrupted work:

1. Read "progress/dashboard.md".
2. Read the active issue's "issue.md".
3. Read latest chunk.
4. Read "implementation.md", "testing.md", and "verification.md" as needed.
5. Check Git state.
6. Continue from the last incomplete task.

Do not repeat completed investigation without reason.

---

15. Security / Data Loss

For security or destructive-data issues:

- Treat as 🔴 Critical.
- Never expose secrets in progress files.
- Test unauthorized/error paths.
- Verify rollback/recovery where applicable.
- Require complete verification before "✅".

---

16. Dashboard

Maintain:

progress/dashboard.md

with only:

Last Updated
Priority totals
Overall progress
Active issues
Blocked issues
Recently completed issues

Update it whenever an issue changes status.

---

17. Core Rules

Understand before changing.

Evidence before assumptions.

Small focused changes over broad refactoring.

Test before completion.

Verify the original problem, not just the code.

Keep all progress in "progress/".

Never fabricate test results, causes, or completion status.
---

## It will create markdown files for work and if these are not needed then they will not be pushed to github. factoring.

Test before completion.

Verify the original problem, not just the code.

Keep all progress in "progress/".

Never fabricate test results, causes, or completion status. | MM-DD |
| 3 | Issue name | 🟢 Medium | ✅ Complete | Name | - |
| 4 | Issue name | ⚪ Low | 🚧 Blocked | - | TBD |

## Recent Activity
- **YYYY-MM-DD**: Completed issue #3 - [description]
- **YYYY-MM-DD**: Started issue #1 - [description]
- **YYYY-MM-DD**: Issue #4 blocked by [reason]
```

---

## 🎯 Quick Reference - Status Indicators

| Icon | Status | Meaning |
|------|--------|---------|
| 📊 | Analyzing | Understanding the problem |
| 📝 | Planning | Designing the solution |
| 🔨 | In Progress | Actively coding |
| 🧪 | Testing | Verifying the fix |
| ✅ | Complete | Done and verified |
| 🚧 | Blocked | Waiting on something |
| ⏸️ | Paused | Temporarily on hold |
| ❌ | Won't Fix | Intentionally not fixing |
| 🔄 | Needs Revision | Failed review, needs changes |

---

## 💡 Best Practices

### Before Starting
1. **Read the full issue** - Don't skip the evidence section
2. **Check dependencies** - Look for related issues
3. **Estimate realistically** - Better to overestimate than underdeliver
4. **Ask questions** - Clarify unclear requirements

### During Implementation
1. **Commit frequently** - Small, focused commits
2. **Write tests first** - TDD approach when possible
3. **Document as you go** - Don't leave it for later
4. **Keep it simple** - Don't over-engineer

### After Completion
1. **Verify thoroughly** - Test edge cases
2. **Clean up** - Remove debug code, format properly
3. **Update docs** - Keep documentation current
4. **Share knowledge** - Write clear commit messages

---

## 🔍 Common Pitfalls to Avoid

❌ **Don't**:
- Skip the analysis phase
- Fix without understanding root cause
- Make changes without tests
- Leave TODOs in production code
- Forget to update documentation
- Mix multiple unrelated fixes

✅ **Do**:
- Understand before coding
- Write tests that verify the fix
- Keep changes focused and minimal
- Document complex logic
- Update related documentation
- Commit logical chunks separately

---

## 📝 Example Issue Template

Here's a complete example for reference:

```markdown
## Issue #16: Gateway-owned LiteLLM control routes are not authenticated

**Category**: 🔴 Critical (Security)
**Status**: 📊 Analyzing
**Assigned**: Developer Name
**Created**: 2024-01-15
**Target**: 2024-01-18

### Problem Statement
LiteLLM control routes (`/gateway/litellm/*`) are exposed without authentication. Any client that can reach the gateway can read status, logs, and restart LiteLLM without credentials.

**Impact**: 
- Security vulnerability with LAN Access enabled
- Unauthorized LiteLLM restarts possible
- Sensitive log data exposure

### Root Cause
- Gateway applies CORS headers but no auth middleware
- Routes mounted at `packages/gateway/src/index.ts:648-700`
- Frontend assumes auth is handled, but gateway doesn't verify

### Dependencies
- [ ] None - can be fixed independently

---

**Status**: 📝 Planning
**Updated**: 2024-01-15

### Proposed Solution
Add authentication middleware to `/gateway/*` routes (except `/gateway/health`).

**Approach**:
1. Use existing `gatewayAuthMiddleware` 
2. Mount it before LiteLLM routes
3. Accept dashboard session cookie OR API key
4. Update frontend to pass credentials

**Alternatives Considered**:
- Route through `/api` - more complex, requires more changes
- Disable routes entirely - removes useful functionality

### Implementation Plan
- [ ] Add auth middleware to gateway routes (2h)
- [ ] Update frontend API calls (1h)
- [ ] Add integration tests (2h)
- [ ] Test with LAN Access enabled (1h)
- [ ] Update security docs (30m)

**Total Estimate**: 6.5h
**Risk Level**: Low (isolated change)

---

**Status**: 🔨 In Progress
**Started**: 2024-01-16

### Changes Made
- [x] Added auth check to `/gateway/litellm/*` routes
  - Modified `packages/gateway/src/index.ts:645-650`
  - Used existing `gatewayAuthMiddleware`
- [x] Updated frontend to include credentials
  - Modified `packages/ui/frontend/src/api/litellm.ts`
  - Added `credentials: 'include'` to fetch calls
- [x] Added tests
  - Created `packages/gateway/src/index.test.ts`
  - Tests: unauthenticated access, valid API key, valid session
- [ ] Documentation update - In progress

### Code Review Checklist
- [x] No breaking changes
- [x] Backward compatibility (API key still works)
- [x] Error handling (401 returned properly)
- [x] Logging (auth failures logged)
- [x] Comments added

---

**Status**: 🧪 Testing
**Updated**: 2024-01-17

### Test Plan
- [x] Unit tests pass
- [x] Integration tests pass
- [x] Manual testing completed
- [x] Edge cases verified
- [x] Performance tested (no impact)

### Test Results
**Date**: 2024-01-17
**Tester**: Developer Name

| Test Case | Expected | Actual | Status |
|-----------|----------|--------|--------|
| No auth header | 401 Unauthorized | 401 Unauthorized | ✅ |
| Invalid API key | 401 Unauthorized | 401 Unauthorized | ✅ |
| Valid API key | 200 OK | 200 OK | ✅ |
| Valid session cookie | 200 OK | 200 OK | ✅ |
| With LAN Access | Requires auth | Requires auth | ✅ |

### Issues Found
- None

---

**Status**: ✅ Complete
**Completed**: 2024-01-17

### Summary
Added authentication to all `/gateway/litellm/*` routes using existing `gatewayAuthMiddleware`. Routes now require either valid API key or dashboard session cookie.

### Files Modified
- `packages/gateway/src/index.ts` - Added auth middleware
- `packages/ui/frontend/src/api/litellm.ts` - Added credentials
- `packages/gateway/src/index.test.ts` - Added security tests
- `docs/security.md` - Updated authentication docs

### Verification
- [x] All tests pass (14/14 green)
- [x] No regression issues
- [x] Documentation updated
- [x] Code reviewed by: Reviewer Name

### Follow-up Actions
- [ ] Monitor error logs for auth failures (1 week)
- None further required
```

---

## 🎓 Learning Resources

### Understanding the Codebase
- Read `docs/architecture.md` for system overview
- Check `packages/*/README.md` for package details
- Review existing tests for usage examples

### Testing Strategies
- Unit tests: Test individual functions in isolation
- Integration tests: Test component interactions
- E2E tests: Test full user workflows
- Manual tests: Verify in browser/CLI

### Code Review Guidelines
- Focus on: correctness, readability, maintainability
- Check for: edge cases, error handling, performance
- Verify: tests exist and pass, docs updated

---

## 📞 Getting Help

### When Stuck
1. **Read the error message carefully** - Often tells you exactly what's wrong
2. **Check git history** - `git blame` and `git log` show why code exists
3. **Search the codebase** - Similar patterns might exist elsewhere
4. **Ask specific questions** - "Why does X happen?" not "How do I fix this?"

### Useful Commands
```bash
# Find similar code patterns
git grep "pattern to search"

# See recent changes to a file
git log -p -- path/to/file

# Find who wrote a line
git blame path/to/file

# Check test coverage
npm run test:coverage

# Run specific test file
npm test path/to/test.ts
```

---

**Remember**: 
- Quality over speed
- Test thoroughly
- Document clearly  
- Ask when unsure
- Learn from each fix

Happy bug fixing! 🐛➡️✅


---
Keep everything in chunks in the progress/ folder.
