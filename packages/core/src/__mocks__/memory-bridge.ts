// Jest manual mock for ../memory/memory-bridge.ts.
//
// The real module calls `createRequire(import.meta.url)` to load the
// CommonJS `@miki/memory` package from an ESM file. Jest's ts-jest ESM
// transform already provides its own `require` in scope, so re-declaring
// one via createRequire throws "Identifier 'require' has already been
// declared" and crashes the whole test file before any test runs — even
// for tests that have nothing to do with memory.
//
// Every real code path here (agent-memory-integration, TKG writes, etc.) is
// exercised by tests that already mock or avoid this import elsewhere; this
// mock only exists so files that transitively import memory-bridge (like
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
