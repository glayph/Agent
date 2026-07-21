---
name: css-styling
description: Use when the user asks about CSS, styling, Grid, Flexbox, layouts, responsive design, animations, Tailwind, or CSS architecture. Generate production-ready CSS with modern layout techniques and responsive patterns.
---

# CSS & Styling (Grid, Flexbox)

## Layout decision tree
```
Need 1D row/column?                → flexbox
Need 2D grid (rows + columns)?     → grid
Need content-based sizing?          → flexbox
Need fixed track sizes?             → grid
Need gap/alignment only?            → flexbox
Need overlap/placement control?     → grid
```

## Flexbox patterns

### Centering
```css
display: flex; justify-content: center; align-items: center;
```

### Sticky footer
```css
body { display: flex; flex-direction: column; min-height: 100vh; }
main { flex: 1; }
```

### Equal-width columns
```css
.container { display: flex; }
.col { flex: 1; }
```

### Responsive nav
```css
nav { display: flex; gap: 1rem; flex-wrap: wrap; }
```

## Grid patterns

### Holy grail layout
```css
grid-template:
  "header header"  auto
  "sidebar main"   1fr
  "footer footer"  auto / 250px 1fr;
```

### Auto-fill responsive cards
```css
grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
```

## Responsive strategy
- Mobile-first: `min-width` breakpoints
- Breakpoints: 640px sm, 768px md, 1024px lg, 1280px xl
- Use `clamp()` for fluid typography: `clamp(1rem, 2.5vw, 1.5rem)`
- Container queries for component-level responsiveness

## CSS architecture (CUBE)
- **Composition**: layout only (grid, flex, gap)
- **Utility**: single-purpose (colors, spacing, type)
- **Block**: component-specific (card, button, modal)
- **Exception**: overrides (`[data-state="active"]`)

## Tailwind conventions
```
flex items-center justify-between p-4 gap-2
grid grid-cols-[250px_1fr] gap-6
sm:grid-cols-2 lg:grid-cols-3
dark:bg-gray-800
```
Prefer composition utilities over custom CSS. Use `@apply` only in component files.

## Common patterns
- Aspect ratio: `aspect-ratio: 16/9`
- Clamp text lines: `display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;`
- Smooth scroll: `scroll-behavior: smooth; scroll-margin-top: 80px;`
