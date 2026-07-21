---
name: user-centered-design
description: Use when the user asks for UX research, user-centered design, usability analysis, persona creation, user flows, accessibility, or design thinking. Apply UCD methodologies to evaluate and improve software from the user's perspective.
---

# User-Centered Design & Research

## Research methods

### Heuristic evaluation (Nielsen's 10)
Check against: visibility, match real world, user control, consistency, error prevention, recognition, flexibility, minimalism, recovery, help.

### Cognitive walkthrough
For each user action ask: will user know what to do? will they notice correct action? will they understand feedback?

### Accessibility audit (WCAG 2.1)
- A: color contrast (4.5:1), alt text, keyboard nav
- AA: focus indicators, resize text 200%, error identification
- AAA: sign language, extended descriptions

## Deliverable templates

### Persona
```
Name, Role, Goals, Pain points, Tech literacy, Environment
```

### User flow
```
Trigger → Screen → Action → Feedback → Next screen
```

### Usability issue report
```
ID, Severity (critical/major/minor/cosmetic), Location, Description, WCAG ref, Suggested fix
```

## Design principles
- **Progressive disclosure** — show advanced options only when needed
- **Error forgiveness** — undo, confirm before destructive actions
- **Consistent mental model** — match platform conventions
- **Feedback loops** — every action gets a visible response within 200ms
- **Fitts's law** — target size ≥ 44x44px (mobile), ≥ 32x32px (desktop)

## Research process
1. Define: user segments, goals, success metrics
2. Collect: analytics, surveys, interviews, session recordings
3. Analyze: affinity mapping, pain point clustering, journey mapping
4. Recommend: prioritized fixes with effort vs impact
