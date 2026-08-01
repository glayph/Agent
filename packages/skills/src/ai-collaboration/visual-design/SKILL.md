---
name: visual-design
description: "Provide design system specs, color palettes, typography scales, and design tool guidance."
version: 1.0.0
author: Hiro
license: MIT
platforms: [linux, macos, windows]
metadata:
  Hiro:
    tags: [ui-design, visual-design, design-systems, color, typography]
    related_skills: [css-styling, responsive-design, wireframing]
---

# Visual Design (UI) & Design Tools

## Design system foundations

### Color system
```yaml
primary:   #6366F1 (indigo 500)
secondary: #EC4899 (pink 500)
neutral:   #6B7280 (gray 500)
success:   #10B981 (emerald 500)
warning:   #F59E0B (amber 500)
error:     #EF4444 (red 500)
```
Scale: 50/100/200/300/400/500/600/700/800/900 (light→dark)

### Typography scale (rem)
```
xs: 0.75  (12px)
sm: 0.875 (14px)
base: 1   (16px)
lg: 1.125 (18px)
xl: 1.25  (20px)
2xl: 1.5  (24px)
3xl: 1.875 (30px)
```
Line-height: 1.5 body, 1.25 headings. Font: system-ui sans-serif.

### Spacing (4px grid)
```
0.5: 2px   1: 4px   2: 8px   3: 12px   4: 16px
5: 20px    6: 24px   8: 32px   10: 40px   12: 48px
```

### Elevation (shadows)
```
sm:  0 1px 2px rgba(0,0,0,0.05)
md:  0 4px 6px rgba(0,0,0,0.07)
lg:  0 10px 15px rgba(0,0,0,0.1)
xl:  0 20px 25px rgba(0,0,0,0.15)
```

## Design principles
- 8px grid for all spacing and sizing
- Consistent border-radius: sm 4px, md 8px, lg 12px, full 9999px
- Touch targets ≥ 44px (mobile), ≥ 32px (desktop)
- Max content width: 640px (mobile), 1024px (tablet), 1280px (desktop)
- Reduce motion: respect `prefers-reduced-motion`

## Tools
- **Figma**: auto layout, components, variants, variables, prototyping
- **Penpot**: open-source Figma alternative
- **Tailwind CSS**: utility-first implementation
- **shadcn/ui**: copy-paste component library
- **Radix UI**: headless, accessible primitives

## Design-to-code
- Extract: colors → CSS vars, spacing → Tailwind scale, typography → font tokens
- Component tree: map Figma frames → React components
- States: default, hover, focus, active, disabled, error
- Responsive: mobile-first, breakpoints at 640/768/1024/1280px
