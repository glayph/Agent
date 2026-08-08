# Fix Progress Tracker (session started 2026-08-08)

Legend: [x] fixed+committed  [~] in progress  [ ] not started  [S] skipped (needs decision/out of scope)

## Already fixed (verified in git log before this session)
- [x] #46 tool_feedback wiring
- [x] #79 marketplace skill metadata persistence
- [x] #88 system index pagination
- [x] #105(goal) active goal injection into chat turns
- [x] #122 Health Flow ui branch verification
- [x] #101-107 (problem4.md skill API set - Go/TS skill error handling, race cond, validation, cache, dedup, tests)
- [x] #25 skills router mount order
- [x] #28 plugin sandbox env vars
- [x] #34 config/test-command-patterns route
- [x] #72 watchdog restart label
- [x] #80 MQTT mojibake
- [x] #87 model catalog delete 404
- [x] #1,2,3,4,5,6,7,8,9,10 (problem.md high/medium/low priority static issues)
- [x] #100 verify scripts help flag (doc says fixed, re-verify)
- [x] #108 context usage view details

## This session queue (priority order)
- [ ] #16 gateway litellm routes unauthenticated (SECURITY)
- [ ] #17 direct core control endpoints unauthenticated (SECURITY)
- [ ] #94 exec allow_remote not enforced (SECURITY)
- [ ] #98 symlink/junction ancestor bypass on write (SECURITY)
- [ ] #124 recursive copy follows symlink descendants (SECURITY)
- [ ] #18 .env CRLF injection (SECURITY)
- [ ] #11 CORS loopback bypass (SECURITY)
- [ ] #19 login throttle bucket collapse behind gateway (SECURITY)
- [ ] #106 heartbeat interval unit bug (ms vs s vs min) (CORRECTNESS, high impact)
- [ ] #92 cron allow_command written to tools.yaml but read from agent.yaml
- [ ] #76 session delete leaves stream_cache/agent_tasks rows
- [ ] #21 safety rollback doesn't remove added files
- [ ] #85 safe mode cannot be cleared
- [ ] #123 gateway log clear reports success on failure
- [ ] #63 discord mention_only default mismatch
- [ ] #48 chatty mode dead toggle
- [ ] #52 cron exec timeout not applied
- [ ] #107 heartbeat auto-actions weak completion heuristics
- [ ] remaining ~90 issues (UI/backend wiring, channel settings, etc.) - continue after above

## Notes
- agent.ts and providers/claude-native.ts are PROTECTED (per user's persistent instructions) - avoid edits; if unavoidable (import path only), disclose.
- Rebrand already 100% complete - no Hiro/xAgent/owlclaw references remain in source.
- Run `npx jest packages/core/ --no-coverage` after every fix.
- Commit + push after every fix individually.
