# Complex Issue Resolution Skill

A comprehensive guide for systematically fixing complex bugs from problem.md with proper tracking and verification.

---

## 🎯 Purpose

This skill helps you:
1. Identify and categorize complex issues that need fixing
2. Create actionable implementation plans
3. Track progress with clear status markers
4. Verify fixes with proper testing
5. Document changes for future reference

---

## 📋 Issue Categories

### 🔴 Critical (Security/Data Loss)
Issues that could cause security vulnerabilities or data loss
- **Priority**: Fix immediately
- **Testing**: Mandatory before marking as complete
- **Review**: Requires peer review

### 🟡 High Priority (Functionality)
Issues that break core functionality or user experience
- **Priority**: Fix in current sprint
- **Testing**: Required with manual verification
- **Review**: Recommended

### 🟢 Medium Priority (Enhancement)
Issues that improve code quality or developer experience
- **Priority**: Fix when convenient
- **Testing**: Automated tests preferred
- **Review**: Optional

### ⚪ Low Priority (Maintenance)
Issues that are technical debt or minor improvements
- **Priority**: Fix during refactoring
- **Testing**: Basic verification sufficient
- **Review**: Not required

---

## 🔧 Standard Fix Workflow

### Phase 1: Analysis (📊)
```markdown
## Issue #X: [Issue Title]

**Category**: [Critical/High/Medium/Low]
**Status**: 📊 Analyzing
**Assigned**: [Name/Date]

### Problem Statement
- What is broken?
- What should happen instead?
- Impact on users/system?

### Root Cause
- Why does this happen?
- Which components are affected?
- Are there related issues?

### Dependencies
- [ ] Requires feature X
- [ ] Needs library Y updated
- [ ] Blocks issue Z
```

### Phase 2: Planning (📝)
```markdown
**Status**: 📝 Planning

### Proposed Solution
1. Step-by-step approach
2. Alternative solutions considered
3. Trade-offs and risks

### Implementation Plan
- [ ] Update file A (estimated: 2h)
- [ ] Modify component B (estimated: 4h)
- [ ] Add tests (estimated: 2h)
- [ ] Update documentation (estimated: 1h)

**Total Estimate**: 9h
**Risk Level**: Medium
```

### Phase 3: Implementation (🔨)
```markdown
**Status**: 🔨 In Progress
**Started**: YYYY-MM-DD

### Changes Made
- [x] Updated `path/to/file.ts` - Added validation logic
- [x] Modified `path/to/component.tsx` - Fixed UI state
- [ ] Added tests to `path/to/test.ts` - In progress
- [ ] Updated documentation - Pending

### Code Review Checklist
- [ ] No breaking changes
- [ ] Backward compatibility maintained
- [ ] Error handling added
- [ ] Logging added for debugging
- [ ] Comments added for complex logic
```

### Phase 4: Testing (🧪)
```markdown
**Status**: 🧪 Testing

### Test Plan
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing completed
- [ ] Edge cases verified
- [ ] Performance tested

### Test Results
**Date**: YYYY-MM-DD
**Tester**: [Name]

| Test Case | Expected | Actual | Status |
|-----------|----------|--------|--------|
| Normal flow | X happens | X happened | ✅ |
| Edge case 1 | Y happens | Y happened | ✅ |
| Error case | Error shown | Error shown | ✅ |

### Issues Found
- None / [List any issues]
```

### Phase 5: Complete (✅)
```markdown
**Status**: ✅ Complete
**Completed**: YYYY-MM-DD

### Summary
- Fixed [describe what was fixed]
- Changed [list main changes]
- Tested [describe testing]

### Files Modified
- `path/to/file1.ts` - [description]
- `path/to/file2.tsx` - [description]
- `path/to/test.ts` - [description]

### Verification
- [x] All tests pass
- [x] No regression issues
- [x] Documentation updated
- [x] Code reviewed (if required)

### Follow-up Actions
- [ ] Monitor in production for 1 week
- [ ] Create ticket for related enhancement
- None required
```

---

## 🚫 Blocked/Skipped Issues

### Blocked (🚧)
```markdown
**Status**: 🚧 Blocked
**Blocked By**: [Reason]
**Date**: YYYY-MM-DD

### Blocking Reason
- Waiting for dependency X
- Requires decision from team
- External API not ready

### Unblock Criteria
- [ ] Dependency X released
- [ ] Decision made on approach
- [ ] API documentation available

**Expected Unblock Date**: YYYY-MM-DD
```

### Won't Fix (❌)
```markdown
**Status**: ❌ Won't Fix
**Reason**: [Explanation]
**Date**: YYYY-MM-DD

### Justification
- By design / Working as intended
- Risk/benefit analysis doesn't justify fix
- Replaced by different feature
- No longer relevant

### Alternative Solution
[If applicable, describe workaround or alternative]
```

---

## 📊 Progress Tracking Template

Use this template at the top of your issue tracking file:

```markdown
# Complex Issues - Progress Dashboard

**Last Updated**: YYYY-MM-DD

## Summary
- 🔴 Critical: X total (Y fixed, Z in progress)
- 🟡 High: X total (Y fixed, Z in progress)  
- 🟢 Medium: X total (Y fixed, Z in progress)
- ⚪ Low: X total (Y fixed, Z in progress)

**Overall Progress**: XX% (YY/ZZ issues resolved)

## Status Overview
| # | Issue | Category | Status | Assignee | Target |
|---|-------|----------|--------|----------|--------|
| 1 | Issue name | 🔴 Critical | 🔨 In Progress | Name | MM-DD |
| 2 | Issue name | 🟡 High | 📝 Planning | Name | MM-DD |
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
