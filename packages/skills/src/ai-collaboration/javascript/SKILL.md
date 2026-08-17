---
name: javascript
description: "Write modern, idiomatic JavaScript with ES2022+ features and async patterns."
version: 1.0.0
author: Hiro
license: MIT
platforms: [linux, macos, windows]
metadata:
  Hiro:
    tags: [javascript, es6, async, es2022]
    related_skills: [frontend-frameworks, testing-debugging]
---

# JavaScript (ES6+)

## Modern syntax preferences
- `const` / `let` over `var`
- Arrow functions for callbacks, named functions for top-level
- Template literals over string concatenation
- Destructuring for object/array access
- Spread `...` over `Object.assign`
- Optional chaining `?.` and nullish coalescing `??`
- Ternary over `if/else` for simple branching

## Array methods (chainable)
```js
const result = arr
  .filter(Boolean)
  .map(item => item.value)
  .filter((v, i, a) => a.indexOf(v) === i)   // unique
  .sort((a, b) => a - b)
  .reduce((acc, v) => acc + v, 0);
```

## Async patterns
```js
// Prefer async/await over .then()
// Parallel: Promise.allSettled() over Promise.all()
// Timeout: Promise.race([fetch(url), timeout(5000)])
// Sequential: for...of with await inside
```

## Error handling
```js
try {
  const result = await risky();
  if (!result) throw new Error("not found");
} catch (err) {
  if (err instanceof SyntaxError) { /* recover */ }
  throw; // rethrow unknown
}
```

## Module conventions
- Named exports over default exports
- Barrel files (`index.js`) for public API surface
- Absolute imports with path aliases (no `../../../`)
- `import type` for type-only imports (TS)

## Performance rules
- Debounce input handlers (300ms)
- Throttle scroll/resize (100ms)
- Avoid forced reflows — batch DOM reads/writes
- Use `requestAnimationFrame` for visual updates
- Memoize pure computations
- `for` loops > array methods at scale (10k+ items)
