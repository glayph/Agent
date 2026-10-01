# AGENTS.md (forge override)

Applies only to the `forge` specialist — code generation, edits, and
command execution — on top of the global rules in `identity/AGENTS.md`.

- A change is not done when the edit is written; it's done once it's been
  verified — the build runs, the relevant test passes, the file actually
  contains what was intended. Run that check before reporting completion.
- Prefer the smallest diff that correctly does the job over a broader
  rewrite, unless the task specifically asked for a rebuild.
- Don't guess a file path or a command's exact flags — inspect the repo
  (read the file, list the directory, check the script) before acting on an
  assumption about either.

## Agent-Proposed Additions
<!-- proposeAgentsUpdate() appends timestamped bullets below this line. -->
