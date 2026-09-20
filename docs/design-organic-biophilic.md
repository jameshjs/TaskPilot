---
version: "alpha"
name: "Organic Biophilic"
description: "Biophilic organic interface. Ideal for landing pages, saas. AI-ready template."
colors:
  primary: "#228B22"
  secondary: "#8B4513"
  tertiary: "#87CEEB"
  neutral: "#F5F5DC"
typography:
  h1:
    fontFamily: System UI stack
    fontSize: 2.25rem
    fontWeight: 700
  body-md:
    fontFamily: System UI stack
    fontSize: 1rem
    fontWeight: 400
  label-caps:
    fontFamily: System UI stack
    fontSize: 0.75rem
    fontWeight: 500
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral}"
    padding: 12px
---

## Overview

Biophilic organic interface. Edward O. Wilson coined "biophilia" in 1984 — the idea that
humans are hardwired to seek connection with nature. Architects and interior designers
ran with it for decades; digital design did not, being busy with flat design and
geometric minimalism.

Then the pandemic locked everyone indoors and screens needed to breathe. Calm apps
exploded. Wellness startups ditched the clinical white-and-blue palette for moss greens
and terracotta. The organic shape — the wobbly, imperfect blob — became the anti-grid, a
quiet rebellion against pixel-perfect rigidity.

Post-2022 this is no longer a trend but a vertical. Sustainability brands expect it,
health platforms demand it. The visual language of "natural" has its own grammar now:
corners pushed to extremes, earth tones that feel like soil after rain, illustrations
that move like water.

- Density: 5/10 — Balanced
- Variance: 8/10 — Expressive
- Motion: 4/10 — Subtle
- **Style:** Natural, Organic, Sustainable, Calming
- **Era:** 2020s Sustainable
- **Light/Dark:** Full / Full

## Colors

- **#228B22** — Primary surface or dominant colour
- **#8B4513** — Secondary surface or text colour
- **#87CEEB** — Supporting palette colour
- **#F5F5DC** — Supporting palette colour

## Typography

- **Display / Hero:** System UI stack — weight 700, tight tracking
- **Body:** System UI stack — weight 400, 16px/1.6, max 72ch per line
- **UI Labels / Captions:** System UI stack — 0.875rem, weight 500, slight letter-spacing
- **Monospace:** JetBrains Mono — code, metadata, technical values

Scale: Hero clamp(2.5rem, 5vw, 4rem) · H1 2.25rem · H2 1.5rem · Body 1rem/1.6 · Small 0.875rem

## Layout

- CSS Grid primary. Max-width 1280px centred, 1.5rem side padding.
- Base spacing unit 0.5rem (8px).
- Section vertical gaps clamp(4rem, 8vw, 8rem).
- Asymmetric hero and feature grids. No 3-equal-column layouts.
- Multi-column collapses below 768px. No horizontal overflow.
- z-index contract: base 0 / sticky-nav 100 / overlay 200 / modal 300 / toast 500.

## Elevation & Depth

Rounded corners 16–24px, organic curves, natural shadows, flowing SVG shapes.

- Physics: ease-out, 200–300ms.
- Entry: fade + translateY (16px → 0) over 420ms ease-out; list stagger 80ms.
- Hover: colour shift + shadow adjustment over 200ms.
- Page transitions: fade only, 200ms.
- Only `transform` and `opacity` animated.

## Shapes

Base corner radius 24px.

## Components

- **Primary Button:** 1.5rem radius, accent fill, hover 8% darken + lift shadow, active -1px press, weight 600, no outer glow.
- **Secondary / Ghost:** outline, 1.5px border in muted colour, text in primary colour, hover subtle fill.
- **Cards:** 1.5rem radius, surface background, shadow `0 2px 12px rgba(0,0,0,0.06)`, 1px border.
- **Inputs:** label above, 1px border, focus ring 2px accent offset 2px, error below in semantic red, no floating labels.
- **Navigation:** primary surface background, active item accent indicator, weight 500 when active.
- **Skeletons:** shimmer matching component dimensions. No circular spinners.
- **Empty States:** icon composition + descriptive text + action button.

## Do's and Don'ts

- No emojis in UI — icon system only (Lucide, Heroicons)
- No pure black (#000000) — off-black or charcoal
- No oversaturated accents (saturation cap 80%)
- No 3-column equal-width feature layouts
- No `h-screen` — use `min-h-[100dvh]`
- No AI copywriting clichés: "Elevate", "Seamless", "Unleash", "Next-Gen"
- No broken external image links
- No generic lorem ipsum

Do: earth tones dominant · organic curves · subtle natural textures · green accents ·
rounded everywhere · calming feel.

---

# Adaptations for TaskPilot

The spec targets landing pages and SaaS dashboards. TaskPilot is a ~360px Chrome side
panel plus an overlay injected into arbitrary web pages. Recorded here so the departures
are reviewable rather than accidental.

## Contrast: the given palette does not pass, and was adjusted

Measured against WCAG 2.2 AA (4.5:1 for normal text):

| Combination | Given | Verdict |
|---|---|---|
| primary `#228B22` on neutral `#F5F5DC` | 3.97:1 | fails normal text |
| neutral on primary (the specified primary button) | 3.97:1 | fails button label |
| tertiary `#87CEEB` on neutral | 1.57:1 | unusable as text |

The hues are kept as the identity; the values are darkened until they pass. Greens and
browns read as the same colours, just deeper:

| Token | Value | On canvas |
|---|---|---|
| `--green` | `#1F7A1F` | 4.94:1 |
| `--brown` | `#7A3D11` | 7.62:1 |
| `--sky` | `#2E6F8E` | 5.04:1 |
| `--ink` | `#2B2A26` | 13.05:1 |
| `--body` | `#5C5A52` | 6.27:1 |

`#87CEEB` survives as `--sky-fill`, used only for decorative fills and never for text.
`#F5F5DC` informs `--canvas` `#F7F4E9`, desaturated slightly to give text headroom.

Every token passes AA in both light and dark. Charcoal `#2B2A26` replaces black, per the
spec's own rule.

## Scale

Type and spacing are shifted down for a 360px column: body 14px rather than 16px, H1
17px rather than 2.25rem. The 8px base unit is kept. Section gaps are 20px rather than
`clamp(4rem, 8vw, 8rem)` — that clamp is for a 1280px page.

Radius is kept generous but proportional: 24px would swallow a 30px-tall control, so
cards use 18px, controls 12px, and the fully-rounded 999px is used for pills.

## Layout rules that do not apply

The 1280px container, asymmetric hero, zig-zag feature grid, and the 768px collapse are
page-composition rules with no analogue in a single-column panel. The panel is one
column at every width. `min-h-[100dvh]` is adopted in place of `100vh`.

## Emoji

The spec forbids emoji in UI. All chrome emoji are replaced with inline Lucide-derived
SVG icons (`src/sidepanel/icons.tsx`).

Emoji still appear in two places, both sourced from the backend and out of scope for a
frontend change: workspace titles from the `/plan` agent (`session.emoji`) and tab-group
names from `/tabs/organize`, which the model is prompted to emit with an emoji. Removing
those requires a prompt change in `backend/src/agents.ts`.
