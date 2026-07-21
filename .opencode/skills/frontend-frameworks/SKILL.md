---
name: frontend-frameworks
description: Use when the user asks about React, Vue, Svelte, Solid, Astro, Next.js, Nuxt, or frontend framework choices, patterns, and comparisons. Provide framework-specific guidance, component patterns, and SSR/SSG/CSR architecture advice.
---

# Front-End Frameworks

## Framework decision matrix

| Need | Choice |
|------|--------|
| Full SPA | React, Vue, Solid |
| SSR/SSG | Next.js, Nuxt, Astro, SvelteKit |
| Static content | Astro (zero JS by default) |
| Micro-frontends | Single-spa, Module Federation |
| Lightweight reactive | Solid, Preact, Svelte |
| Mobile + web | React Native + React |

## React patterns
- Components: function + hooks (no classes)
- State: `useState` for local, `useReducer` for complex, Zustand/Jotai for global
- Side effects: `useEffect` only for synchronization (not lifecycle)
- Memoization: `useMemo`/`useCallback` only for expensive computations
- Forms: React Hook Form + Zod validation
- Data fetching: TanStack Query (React Query)

## Vue patterns
- Composition API over Options API
- `<script setup>` for components
- Pinia for state management
- `v-model` for two-way binding
- `<KeepAlive>` for cached views

## SSR patterns (framework-agnostic)
- Hydrate interactive islands only (islands architecture)
- Stream HTML to the client
- Preload critical data on the server
- Avoid `window` access during SSR — guard with `typeof window`
- Use `Suspense` boundaries for streaming

## Performance targets
- LCP < 2.5s, TTI < 3.5s, CLS < 0.1
- First load JS bundle < 150KB (gzipped)
- Code-split by routes, lazy-load below-fold
- Prefetch link `rel="prefetch"` for likely next page

## Testing
| Layer | Tool |
|-------|------|
| Unit | Vitest, Testing Library |
| Component | Storybook, Testing Library |
| E2E | Playwright, Cypress |
| Visual | Percy, Chromatic |
