---
name: scexpert-design-tokens
description: The SCExpert NG visual system — theme tokens, type scale, control metrics and dialog anatomy, read from src/theme.ts and measured on the live app
metadata:
  type: reference
  source: softela-ai
---

Related: the frontend architecture reference and the code-documentation-style reference.

## Source of truth and how the theme actually works

(Verified against the frontend `dev-ng` branch, plus live measurement on a running test deployment.)

- Single source of truth is `src/theme.ts`. It exports `themeVariables` — light
  block at `:7-414`, dark block at `:415-821`, 300+ CSS custom properties —
  plus `applyThemeVariables()` and `createAppTheme()`. `@softela/basic` re-exports
  MUI's `createTheme` unmodified; it is a thin wrapper package, not a custom
  theme factory.
- `applyThemeVariables` (`src/theme.ts:988-994`) sets `data-theme="light"|"dark"`
  on BOTH `<html>` and `<body>`, then writes every variable as an INLINE style
  on `:root` and `body` (`:1023-1028`). **There is no stylesheet rule** — a
  runtime scan of `document.styleSheets` finds nothing, because the tokens
  exist as inline properties on the two root elements, not in any sheet.
  Record this explicitly; it is the trap that makes a naive inspection
  conclude the app has no design tokens.
- `?theme=light|dark` in the URL overrides the mode
  (`src/utils/themeUrlParams.ts:7-34`). A user-chosen accent colour can
  override `--main-border-color` at runtime and cascades into several derived
  tokens (`src/theme.ts:914-1022`).
- There is NO `shape.borderRadius`/`spacing` override, and NO
  `MuiButton`/`MuiTextField`/`MuiOutlinedInput` entry under the theme's
  `components` — button and input styling comes from global class selectors in
  `getGlobalStyles` (`src/theme.ts:1576-2482`) instead. `MuiDialog.styleOverrides.paper`
  at `:2517-2525` (light) / `:2626-2634` (dark) is where the dialog border,
  radius and shadow come from.
- Icons are inline SVG through MUI's `SvgIcon`, drawn from an approved-icon
  list (`node_modules/@softela/basic/dist/lib/Icon/Icon.d.ts:3-331`) and used as
  `<Icon name="…" fontSize="small" />` — not an icon font.

### Fonts and type scale

```css
@import url("https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap");
font-family: "Roboto", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

Values below were measured live on the App Component editor screen,
via `getComputedStyle` — treat as fact, not derived from the theme file:

| role | measured value |
|---|---|
| body / input text | **14px**, 400, colour `--primary-text-color` |
| form field label | **10.5px**, 400, `line-height: 15px`, `letter-spacing: .1px`, colour `--secondary-text-color`, **4px gap ABOVE the input** |
| dialog title | **17.5px**, 500, no border under it |
| dialog action button | **13px**, 500, **UPPERCASE** |
| outlined button inside dialog content | 12.25px, 500, uppercase |
| filter chip | **11.375px**, **600** |

The label is a static `Typography` sitting ABOVE the input — **never** MUI's
floating `InputLabel`. It is small and tight (10.5px + 4px gap); that density
is a large part of why the product reads the way it does.

### Colour tokens — light

```css
:root {
  --bg-primary:            #F6F6F7;   /* page / app background */
  --paper-bg-color:        #ffffff;   /* every surface, card, dialog paper */
  --primary-text-color:    #000000;
  --secondary-text-color:  #667085;   /* also --form-label-color */
  --border-color:          #DEDEE1;
  --divider-color:         rgba(0,0,0,0.12);

  --main-border-color:     #E1BB3A;   /* THE product accent: warm gold.
                                         MUI palette.primary.main, the input
                                         focus border, the tab indicator,
                                         and the contained-button fill. */
  --accent-primary:        #2196f3;   /* links / informational accents */

  --form-input-bg:           #ffffff;
  --form-input-border-color: #BFC0C4;
  --readonly-input-bg:       #EFEFF1;
  --readonly-input-text-color: rgba(0,0,0,0.6);

  --row-hover-bg:          #F6F6F7;
  --row-selected-bg:       #ECECEF;

  --error-color:           #EB5757;
  --error-bg:              #ffebee;
  --status-success:        #219653;
  --status-warning:        #F2994A;

  --dialog-header-bg:      #F8F8F9;
  --dialog-border:         #CDCDD1;
  --dialog-border-radius:  8px;
  --dialog-shadow: 0 12px 32px rgba(15,23,42,.18), 0 3px 10px rgba(15,23,42,.08);

  --button-highlight:      var(--main-border-color);
  --button-highlight-text: var(--secondary-text-color);

  --scrollbar-thumb:       #DEDEE1;
  --scrollbar-thumb-hover: #CBCBD0;
}
```

### Colour tokens — dark (overrides)

```css
  --bg-primary:            #121722;
  --paper-bg-color:        #202735;
  --primary-text-color:    #F4F6FA;
  --secondary-text-color:  #A8B0BF;
  --border-color:          #354055;
  --divider-color:         #354055;

  --main-border-color:     #E1BB3A;   /* unchanged in dark */
  --accent-primary:        #2196f3;   /* unchanged in dark */

  --form-input-bg:           #202735;
  --form-input-border-color: #536079;
  --readonly-input-bg:       #293244;
  --readonly-input-text-color: var(--primary-text-color);

  --row-hover-bg:          #2A3548;
  --row-selected-bg:       #32405A;

  --error-color:           #EB5757;
  --error-bg:              rgba(211,47,47,0.16);
  --status-success:        #219653;
  --status-warning:        #F2994A;

  --dialog-header-bg:      #2A3345;
  --dialog-border:         #5B6980;
  --dialog-shadow: 0 18px 48px rgba(0,0,0,.56), 0 4px 14px rgba(0,0,0,.34);

  --button-highlight:      #C2A44B;
  --button-highlight-text: #171B24;

  --scrollbar-thumb:       #465064;
  --scrollbar-thumb-hover: #5B667B;
```

### Controls

**Text input** — MUI outlined, `size="small"`, measured live: height **37px**,
inner padding `8.5px 14px`, font 14px, radius **4px**, background transparent.
Border is **2px** in every state; colour `rgba(0,0,0,0.23)` at rest (`#536079`
in dark) and **`--main-border-color` (gold) on focus only** — there is NO
hover state. Disabled/read-only inputs take `--readonly-input-bg` /
`--readonly-input-text-color`.

**Form row** — label ABOVE the input, single column, **64px label-to-label
pitch** (10.5px label + 4px gap + 37px input + ~12px breathing room).

**Dialog** — paper: `border-radius: 8px`, `border: 1px solid var(--dialog-border)`,
`box-shadow: var(--dialog-shadow)`, background `--paper-bg-color`; default
width `min(100vw - 32px, 900px)`; **backdrop** `rgba(0,0,0,0.5)`. Title bar:
`DialogTitle` with padding `16px 24px`, **17.5px/500**, no `border-bottom` —
spacing alone separates zones, not rules. Content: padding `0 24px 20px`.
Action bar: padding `8px`, `justify-content: flex-end`, `gap: 8px`, no
`border-top`. Action buttons:

```css
height: 32px; min-width: 75px; padding: 0 12px;
border-radius: 6px;
font-size: 13px; font-weight: 500; line-height: 1;
text-transform: uppercase; box-shadow: none;
```

Contained-primary is a gold `#E1BB3A` fill with **slate-grey `#667085` text,
not white** — a deliberate, very recognisable choice, flat, no elevation.
Cancel/secondary is transparent with `--secondary-text-color`. Order is Cancel
first, primary second. An outlined button in dialog CONTENT (not the action
bar) differs: `color: var(--main-border-color)`, `border: 1px solid
rgba(225,187,58,.5)`, radius `8px`, height 33px, padding `5px 15px`, 12.25px
uppercase.

**Radii are deliberately not uniform**: 4px on inputs, 6px on dialog action
buttons, 8px on dialog paper and on outlined content buttons. It is real; do
not normalise it.

**Chips** — two distinct styles:
- *Filter chip* (neutral, sits beside a grid title): `height: 24px`,
  `border-radius: 16px` (full pill), `background: #DBD9D9`
  (`--row-selected-bg` in dark), text `--primary-text-color`, `11.375px/600`,
  padding `0 8px`.
- *Status chip* (semantic): `height: 21px`, `border-radius: 4px`,
  `padding: 0 8px`, `12px/500`, background = semantic colour at 12% alpha,
  text = semantic colour at full strength.

**Scrollbars**

```css
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-track { background-color: transparent; }
*::-webkit-scrollbar-thumb { background-color: var(--scrollbar-thumb); border-radius: 4px; }
*::-webkit-scrollbar-thumb:hover { background-color: var(--scrollbar-thumb-hover); }
html, body, * { scrollbar-color: var(--scrollbar-thumb) transparent; }
```

### What makes it read as SCExpert — the traits to reproduce

1. Roboto everywhere, 14px body, 10.5px labels above inputs.
2. Flat, light-grey `#F6F6F7` ground with pure white surfaces; hairline
   `#DEDEE1` borders; almost no shadows except dialogs.
3. Chunky **2px** input borders that turn warm gold on focus only (no hover
   state) — the single most recognisable thing in the UI.
4. Small dense controls: 37px inputs, 32px buttons, 21-24px chips.
5. Uppercase 13px dialog buttons in a fixed 75x32 box with 6px radius, the
   primary one filled gold with slate-grey text (not white).
6. 8px-radius dialog paper with a visible 1px border, not just a shadow.
7. Muted blue-grey secondary text `#667085` for every label and caption.
8. Thin 8px scrollbars.
9. Deliberately non-uniform radii (4/6/8px) — never normalised to one value.
