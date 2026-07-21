---
name: responsive-design
description: "Build layouts that work from 320px mobile to ultrawide desktop using mobile-first methodology."
version: 1.0.0
author: Hiro
license: MIT
platforms: [linux, macos, windows]
metadata:
  Hiro:
    tags: [responsive, mobile-first, cross-device, adaptive]
    related_skills: [css-styling]
---

# Responsive / Mobile-First Design

## Core principle
Start with the **smallest screen** layout. Add complexity at each breakpoint. Never remove — only enhance.

## Breakpoint system
```
Default (320px+)   → mobile portrait
640px (sm)         → mobile landscape / small tablet
768px (md)         → tablet portrait
1024px (lg)        → tablet landscape / small desktop
1280px (xl)        → desktop
1536px (2xl)       → large desktop
```

## Fluid techniques

### Typography
```css
font-size: clamp(1rem, 0.5rem + 2vw, 1.5rem);
```

### Spacing
```css
padding: clamp(1rem, 3vw, 2rem);
```

### Container width
```css
width: min(100% - 2rem, 1200px);
margin-inline: auto;
```

## Layout patterns

### Stack → Row
```css
/* Mobile: stacked */
display: flex; flex-direction: column; gap: 1rem;
/* Tablet+: side-by-side */
@media (min-width: 768px) {
  flex-direction: row;
}
```

### Single → Multi-column
```css
grid-template-columns: 1fr;
@media (min-width: 640px) { grid-template-columns: repeat(2, 1fr); }
@media (min-width: 1024px) { grid-template-columns: repeat(3, 1fr); }
```

### Navigation: hamburger → full
```css
nav ul { display: none; }        /* mobile: hidden */
.menu-btn { display: block; }    /* mobile: hamburger */
@media (min-width: 768px) {
  nav ul { display: flex; }
  .menu-btn { display: none; }
}
```

## Images & media
```css
/* Responsive images */
img { max-width: 100%; height: auto; }
/* Picture element */
<picture>
  <source srcset="large.webp" media="(min-width: 1024px)">
  <source srcset="small.webp" media="(min-width: 640px)">
  <img src="fallback.jpg" alt="">
</picture>
```

## Touch targets
- Minimum 44×44px (mobile) — WCAG 2.5.5
- Minimum 8px gap between touch targets
- Hover states: only on `hover: hover` devices

## Testing checklist
- [ ] 320px, 375px, 640px, 768px, 1024px, 1280px
- [ ] No horizontal scroll
- [ ] Text not cut off at any width
- [ ] Forms usable on mobile keyboard
- [ ] Touch targets well-spaced
- [ ] Reduced motion respected
