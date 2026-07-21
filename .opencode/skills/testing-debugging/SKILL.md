---
name: testing-debugging
description: Use when the user asks about testing, debugging, QA, test strategies, TDD, or troubleshooting failures. Write tests, debug failures, and implement quality strategies across unit, integration, and E2E layers.
---

# Testing & Debugging

## Test pyramid
```
E2E (10%)     — Playwright, Cypress
Integration (20%) — supertest, Testing Library
Unit (70%)    — Vitest, Jest
```

## TDD cycle
1. Write failing test (red)
2. Write minimal code to pass (green)
3. Refactor (clean)
4. Repeat

## Unit testing patterns
```ts
describe("calculateTotal", () => {
  it("sums item prices with tax", () => {
    expect(calculateTotal([{ price: 10 }, { price: 20 }], 0.1))
      .toBe(33); // (10+20) * 1.1
  });

  it("handles empty cart", () => {
    expect(calculateTotal([], 0.1)).toBe(0);
  });

  it("throws on negative tax", () => {
    expect(() => calculateTotal([], -1)).toThrow("invalid tax");
  });
});
```

## Debugging protocol
1. **Reproduce**: exact steps, input, environment
2. **Isolate**: binary search (comment half, test, repeat)
3. **Read errors**: first line of stack trace = where it broke
4. **Check assumptions**: verify input types, null checks, async order
5. **Check logs**: structured logger > console.log
6. **Fix + add test**: prove fix works, prevent regression

## Common bug patterns
| Symptom | Likely cause |
|---------|-------------|
| "undefined is not a function" | Import failure / wrong this binding |
| Infinite loop | Missing base case in recursion / useEffect deps |
| Stale state | Closure over old value / missing deps array |
| Off-by-one | `<` vs `<=`, index vs length |
| Silent fail | Uncaught async error / empty catch block |

## Debugging tools
- `node --inspect` + Chrome DevTools
- VS Code: breakpoints, watch, call stack
- `console.table()`, `console.trace()`, `console.time()`
- Network tab: request/response, timing, cookies
- React DevTools: component tree, state, props, profiler
