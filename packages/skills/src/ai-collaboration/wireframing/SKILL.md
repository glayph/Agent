---
name: wireframing
description: "Generate text-based wireframes, screen flows, and interactive prototype specs for web and mobile."
version: 1.0.0
author: Hiro
license: MIT
platforms: [linux, macos, windows]
metadata:
  Hiro:
    tags: [wireframing, prototyping, mockups, interaction-design]
    related_skills: [visual-design, user-centered-design]
---

# Wireframing & Prototyping

## Fidelity levels

### Low-fidelity (concept)
- Box-and-line diagrams showing layout zones
- No color, no images, no real text
- Label: Header, Nav, Content, Sidebar, Footer

### Medium-fidelity (structure)
- Realistic content placement, spacing, hierarchy
- Grayscale with 3-4 shades for depth
- Actual UI element types (input, button, card, table)

### High-fidelity (visual)
- Full color, typography, icons, spacing (8px grid)
- States: default, hover, active, disabled, error, loading, empty

## Output format (ASCII wireframes)

```
+-----------------------------------------------+
|  LOGO                    [Search...]  [Login]  |
+-----------------------------------------------+
|  Dashboard  |  +---------------------------+   |
|  Projects   |  |  Activity Feed            |   |
|  Settings   |  |  - User X committed       |   |
|  Help       |  |  - PR #42 merged          |   |
|             |  |  - Build #7 passed        |   |
|             |  +---------------------------+   |
+-----------------------------------------------+
```

## Screen flow notation
```
[Home] → click "Sign Up" → [Registration] → submit → [Verify Email] → [Dashboard]
                                                        ↓ error
                                                   [Registration] + inline validation
```

## Prototyping specs
For each screen include: elements list, interaction triggers, state changes, transitions (duration + easing), responsive breakpoints (mobile 375px, tablet 768px, desktop 1280px).

## Tools reference
- Figma: frames, auto layout, components, variants, prototyping
- Penpot: open-source Figma alternative
- Excalidraw: quick hand-drawn style wireframes
- Balsamiq: low-fi wireframing
