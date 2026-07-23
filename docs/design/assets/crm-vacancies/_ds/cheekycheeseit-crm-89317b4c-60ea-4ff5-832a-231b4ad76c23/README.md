# CrmWeb (@crm/web@0.0.1)

This design system is the published @crm/web React library, bundled as a single
browser global. All 35 components are the real upstream code.

## Where things are

- `_ds_bundle.js` — the whole-DS bundle at the project root; loads every component to `window.CrmWeb`. First line is a `/* @ds-bundle: … */` metadata header.
- `styles.css` — the single stylesheet entry: it `@import`s the tokens, fonts, and component styles (`_ds_bundle.css`). Link this one file.
- `components/<group>/<Name>/<Name>.prompt.md` (example JSX + variants), `<Name>.d.ts` (types), `<Name>.html` (variant grid).
- `tokens/*.css` — CSS custom properties, names verbatim from upstream.
- `fonts/` — `@font-face` files + `fonts.css` (when the package ships fonts).

For a specific component, `read_file("components/<group>/<Name>/<Name>.prompt.md")`.

## Loading

Add these two lines to your page once (React must be on the page first):

```html
<link rel="stylesheet" href="styles.css">
<script src="_ds_bundle.js"></script>
```

Components are then available at `window.CrmWeb.*`. Mount into a dedicated child node (e.g. `<div id="ds-root">`), not the host page's own React root, so the two trees don't collide:

```jsx
const { Alert } = window.CrmWeb;
ReactDOM.createRoot(document.getElementById('ds-root')).render(<Alert />);
```

## Tokens

218 CSS custom properties from @crm/web. Names are
preserved verbatim from upstream. They are declared inside `_ds_bundle.css` (this DS ships one compiled stylesheet rather than separate token files).

- **color** (81): `--tw-border-style`, `--tw-shadow-color`, `--tw-inset-shadow-color`, …
- **spacing** (6): `--tw-space-y-reverse`, `--tw-space-x-reverse`, `--tw-inset-shadow`, …
- **typography** (15): `--tw-font-weight`, `--tw-tracking`, `--font-sans`, …
- **radius** (2): `--radius-2xl`, `--radius`
- **shadow** (8): `--tw-shadow`, `--tw-shadow-alpha`, `--tw-ring-shadow`, …
- **other** (106): `--tw-translate-x`, `--tw-translate-y`, `--tw-translate-z`, …

## Components

### general
- `Alert`
- `AlertDialog`
- `AmountCurrencyInput`
- `AnimatedTabs`
- `Avatar`
- `Badge`
- `Button`
- `Calendar`
- `Card`
- `Command`
- `CrmDialogContent`
- `DatePickerField`
- `Dialog`
- `DropdownMenu`
- `ImageUploadField`
- `Input`
- `Label`
- `PhoneInput`
- `Popover`
- `RadioGroup`
- `RoleSelect`
- `ScrollArea`
- `SegmentedToggle`
- `Select`
- `Separator`
- `ShareSlider`
- `Sheet`
- `Skeleton`
- `SliderNumberInput`
- `Table`
- `Tabs`
- `TechAutocompleteInput`
- `Textarea`
- `Toaster`
- `Tooltip`
