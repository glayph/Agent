---
name: html-semantic
description: Use when the user asks about HTML5, semantic markup, accessibility tree, SEO structure, HTML best practices, or ARIA. Generate accessible, semantically correct HTML5 with proper landmark elements and ARIA attributes.
---

# HTML5 & Semantic Markup

## Document structure
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Page title</title>
</head>
<body>
  <header>      <!-- site/banner -->
  <nav>         <!-- navigation -->
  <main>        <!-- primary content -->
    <article>   <!-- self-contained composition -->
      <section> <!-- thematic grouping -->
      <aside>   <!-- tangentially related -->
  <footer>      <!-- footer -->
</body>
</html>
```

## Landmarks
| Element | ARIA role | Use |
|---------|-----------|-----|
| `<header>` | `banner` | Site header (NOT per-section headers) |
| `<nav>` | `navigation` | Primary nav blocks |
| `<main>` | `main` | One per page, wraps unique content |
| `<article>` | `article` | Forum posts, blog entries, news stories |
| `<section>` | `region` | Group with heading — only use `aria-label` if no heading |
| `<aside>` | `complementary` | Sidebars, pull quotes, related links |
| `<footer>` | `contentinfo` | Site footer (NOT per-section footers) |
| `<form>` | `form` | Only if has `aria-label` or `<legend>` |

## Heading hierarchy
- Single `<h1>` per page
- No gaps: h1→h2→h3, never h1→h3
- Headings describe content structure, not visual size

## ARIA rules (5 golden rules)
1. Don't use ARIA if native HTML works (`<button>` not `<div role="button">`)
2. Don't override native semantics (`role="heading"` on `<h2>` — pointless)
3. All interactive elements must be keyboard accessible
4. `aria-label` only when visible label is absent
5. `role="presentation"` / `role="none"` only on decorative images

## Accessibility checklist
- Alt text on all `<img>` (empty alt for decorative)
- Form inputs have `<label>` or `aria-label`
- Color not sole differentiator
- Focus order matches visual order
- Skip navigation link as first focusable element
- `prefers-reduced-motion` respected
- Error messages associated via `aria-describedby`
