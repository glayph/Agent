---
name: accessibility
description: Use when the user asks about accessibility, a11y, inclusive design, WCAG, screen readers, keyboard navigation, or ARIA. Ensure web interfaces are usable by people of all abilities following WCAG 2.2 standards.
---

# Accessibility (Inclusive Design)

## WCAG 2.2 conformance levels
- **A**: minimum — 30 criteria (must pass)
- **AA**: acceptable — 20 additional (target this)
- **AAA**: optimal — 28 additional (aspirational)

## Perceivable
- **1.1.1** Non-text content: all images need alt text (decorative: alt="")
- **1.2.x** Captions, audio descriptions for media
- **1.3.x** Info and relationships: use semantic HTML, not `aria-` when native works
- **1.4.1** Use of color: don't rely on color alone (add icons, patterns, text)
- **1.4.3** Contrast: text ≥ 4.5:1, large text ≥ 3:1
- **1.4.4** Resize text: 200% zoom without loss
- **1.4.11** Non-text contrast: UI components ≥ 3:1
- **1.4.12** Text spacing: no loss if line-height 1.5, spacing 0.16em
- **1.4.13** Hover/focus: persistent, dismissible content

## Operable
- **2.1.1** Keyboard: all functionality via keyboard
- **2.4.3** Focus order: logical tab sequence
- **2.4.7** Focus visible: clear focus indicator (3px outline minimum)
- **2.5.5** Target size: ≥ 24×24px (AA) / ≥ 44×44px (AAA)
- **2.5.8** Target spacing: adjacent targets with gap

## Understandable
- **3.2.x** Predictable: consistent navigation, same behavior
- **3.3.x** Input assistance: labels, error suggestions, undo

## Robust
- **4.1.2** Name, role, value: proper ARIA on custom widgets
- **4.1.3** Status messages: `role="status"` or `aria-live`

## Inclusive design checklist
- [ ] All functionality available via keyboard
- [ ] Visible focus indicators on all interactive elements
- [ ] Color contrast ≥ 4.5:1 for body text
- [ ] Touch targets ≥ 44px with adequate spacing
- [ ] Form errors are announced and associated with inputs
- [ ] Motion/animations respect `prefers-reduced-motion`
- [ ] Dark mode: `prefers-color-scheme: dark`
- [ ] Reduced data: `prefers-reduced-data`
