// Jest manual mock for the shared @miki/memory/core runtime bridge.
//
// Runtime tests use the package-owned CommonJS bridge. This mock keeps unrelated
// core tests isolated from persistent memory initialization.
//
// Every real code path here (agent-memory-integration, TKG writes, etc.) is
// exercised by tests that already mock or avoid this import elsewhere; this
// mock only exists so files that transitively import the memory runtime (like
// tools/executor/shell.ts) can be loaded under Jest at all. Tests that
// specifically want to assert memory-logging *behavior* should mock this
// module explicitly with jest.mock() and provide their own getMemory().
export function initMemory(_dataDir: string): null {
  return null;
}

export function getMemory(): null {
  return null;
}

export function closeMemory(): void {
  // no-op
}
