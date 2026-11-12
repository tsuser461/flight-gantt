# Flights – Gantt: a timeline next to your AG Grid table

Developer handoff for the **Flights – Gantt V3** prototype: a timeline next to an AG Grid table, with code you can install and run.

- Prototype (interactive): https://claude.ai/artifact/SFDumZx4bKo3xyJbYo7jcV
- Open **Bar scenarios** in the prototype's top navigation. It draws every case with the real renderer and says what is true (If), what is drawn (Then) and what the label shows (Label). Use it as the visual spec and as your QA list. It exists **in the Claude prototype only**: it is not in this repo and you do not need to build it.
- This repo is a **runnable app** (Vite + React). `src/flight-gantt/` is the component code, the part you adapt into your app. `src/demo/` is a stand-in host page (top navigation, page header, filters) so you can try it. See "Try it" below.

---

## Try it (5 minutes)

You need Node 18 or newer (tested with Node 22).

```bash
npm install
npm run dev        # opens on http://localhost:5173
```

Other scripts: `npm run build` (production build into `dist/`) and `npm run preview` (serve that build).

**What you will see.** The Flights page with the 13 sample callsigns from `src/flight-gantt/sampleData.js`. The top bar has **prototype controls**: _Version_ (with or without the collapse view) and _Date range example_ (1 day or 2 days). "Now" is fixed at 21 Nov 2026 22:30 UTC in the sample data so that every state (Past ETD, Past ETA, Not scheduled and so on) is always on screen. The buttons in the page header (Update, Abort, Manage, Close, Create) are not wired: they only show a message.

**Where to start reading.** `src/flight-gantt/flightRules.js` holds the rules and has no React or AnyChart in it. Then `FlightGantt.jsx`, which puts the grid and the timeline together.

**Things you will notice**

- AnyChart draws a **trial watermark** until it has a licence key. Put yours in a `.env` file (copy `.env.example`): `VITE_ANYCHART_LICENSE_KEY=your-key`.
- Fonts (Open Sans, Material Symbols Outlined) load from Google Fonts in `index.html`, so the first run needs internet. Swap them for your own and replace `src/flight-gantt/Icon.jsx` with your icon component.
- `npm run build` prints a warning about `eval` in `anychart-bundle.min.js`. That is AnyChart's own bundle, not our code. It is about 2.5 MB and is split into its own chunk (see `vite.config.js`).

---

## 1. The idea in one paragraph

You already have an AG Grid table. We keep it. We put a **timeline** (an AnyChart Gantt, drawn with our own shapes) to the **right** of it, and drive both from **one flat row list**. Every table row has a timeline row at exactly the same height and in the same order, and vertical scroll is shared. That is what makes it a hybrid: AG Grid stays the source of truth for rows, columns, scrolling and accessibility, and the timeline is a read-only picture of the same rows.

```
┌───────────────────────── toolbar (host page) ──────────────────────────┐
├──────────── table pane 751px ────────────┬──── timeline (rest) ────────┤
│ header cell: counts "17 IS • 6 FP • …"   │ header 52px: dates + hours  │
│ ▸ mission row (full width, 52px)         │ bar / shaded band           │
│   column-header row (52px)               │ (empty)                     │
│   sortie row   (52px, zebra)             │ bar + strip, label, chip    │
│   sortie row   (52px, zebra)             │ strip, label, chip          │
│ ▸ next mission row …                     │ …                           │
└──────────────────────────────────────────┴─────────────────────────────┘
      one row list  →  AG Grid rowData  and  GanttTimeline.render({ rows })
      AG Grid owns vertical scroll; the timeline follows it
```

---

## 2. The row contract (read this first)

Everything else depends on it.

| Rule                               | Value                                                                       | Where                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Row height, table **and** timeline | **52px**                                                                    | `ROW_H` in `flightRules.js`; AG Grid `rowHeight`; the timeline draws 51px + AnyChart's 1px line |
| Row order                          | identical in both                                                           | both are built from `buildRows()`                                                               |
| Row types                          | `parent` (mission), `cols` (column names), `child` (sortie), `end` (spacer) | `buildRows()`                                                                                   |
| Vertical scroll                    | AG Grid is the master                                                       | `onBodyScroll` → `timeline.scrollTo(top)`                                                       |
| Header                             | table header spacer 53px, timeline header 52px + 1px divider                | `--fg-head-h`, `HEADER_H`                                                                       |

Why it matters: AnyChart's Gantt can only draw **uniform row heights**, so the table must be uniform too. Things that break the contract:

- Wrapped text or any row that grows taller than 52px.
- AG Grid **row grouping, tree data or master/detail**. They change row heights and row order. We flatten the mission → sorties hierarchy ourselves (`buildRows`) and open/close missions by rebuilding the list.
- `animateRows` (set it to `false`) and any per-row `getRowHeight`.

---

Derived, never stored: the mission's **callsign** (what its sorties' callsigns share, minus the number: SOUR01–SOUR04 → `SOUR`), the counts per status, anomalies.

`model` and `tail` stay in the data but are **not shown**: the table has no A/C Model or Tail No column.

Adapter sketch (your API → this shape):

```js
const toParents = (missions) =>
  missions.map((m) => ({
    id: m.id,
    name: m.name,
    model: m.model,
    info: { id: m.externalId, code: m.code, activityType: m.activityType },
    anchor: m.sorties.every((s) => !s.etd && !s.eta && !s.atd && !s.ata)
      ? Date.parse(m.plannedDate)
      : undefined,
    children: m.sorties.map((s) => ({
      id: s.callsign,
      code: s.status,
      model: s.aircraftModel,
      tail: s.tailNo,
      etd: s.etd && Date.parse(s.etd),
      eta: s.eta && Date.parse(s.eta),
      atd: s.atd && Date.parse(s.atd),
      ata: s.ata && Date.parse(s.ata),
    })),
  }));
```

`now` is passed in (epoch ms). The prototype fixes it; in production tick it (for example once a minute), because "Past ETD", "Past ETA" and the Now line depend on it.

---

## 3. What is drawn (the spec)

### 3.1 One sortie (expanded row)

| Status                    | Drawn                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **IS** Issued             | **No bar.** Only the estimate (ETD→ETA) as a 4px strip along the bottom of the bar area. The label sits above it. |
| **FP** Flight in progress | Bar from ATD to **now**. The estimate strip is drawn under it where it differs from the bar.                      |
| **LD** Landed             | Bar from ATD to ATA. Strip under it where the estimate differs.                                                   |
| **CL** Closed             | Same as LD, faded (60% opacity).                                                                                  |
| **IA** Aborted            | **No bar.** The estimate strip, faded (60%). Faded label.                                                         |

Label: `Callsign • Status` (a cyan dot follows when a value was updated). It starts 16px inside the bar or strip, and if the bar continues past the window's left edge the label stays pinned at the edge and slides away with the bar's end. **A label is never truncated**: if it is longer than its bar it just continues past the end.

### 3.2 Attention ("Past ETD", "Past ETA")

`alertOf(sortie, now)` in `flightRules.js`:

- **Past ETD**: no ATD yet and `now > ETD` (so an IS that should have left).
- **Past ETA**: has an ATD, no ATA, and `now > ETA` (so a flight that should have landed).
- IA and CL never raise one.

Drawn as: a **red chip** with that text, at the **left, directly above the label** (its left edge equals the label's left edge). An IS also gets a **red strip**; an FP gets a **red border and an 8px red left edge** on its bar. The table row gets a red left border.

**Selected (clicked) sortie**, from a click on its bar or on its table row: a bar's **fill** becomes `#003D54` and its border stays as it was, so an anomaly bar keeps its red border and red edge. Its **estimate strip** becomes `#00799E`: the strip under a flown bar, or the strip that is the whole estimate of an issued or aborted sortie (grey or red). Its **table row** becomes `#003D54`. The tooltip opens with it, and clicking empty space clears it.

**Tooltip card.** A click on a bar or a table row pins it. It sits just below its bar (above it when there is no room), centred on the visible part of the bar, and **follows the bar** while you scroll, pan or zoom. When the bar scrolls out of view the card goes with it: it slides out under the timeline header, or off the bottom of the chart, and it is **still there when you scroll back**, as long as you have not selected another sortie. It closes on a click on empty space, on Escape, on a second click on the same sortie, and when its mission is collapsed. The pinned card is clickable (so its text can be selected) and therefore also catches clicks: a bar under it can be reached from its table row or after scrolling. See `FlightTip` in `FlightGantt.jsx` and `getBarRect` in `GanttTimeline.js`.

### 3.3 Collapsed mission (the same for every model)

`aggregate()` in `flightRules.js`:

- **Actual bar:** earliest ATD → latest ATA across all its sorties (a sortie still flying counts up to _now_; gaps between sorties are covered). No bar if nothing has departed.
- **Estimate strip:** earliest ETD → latest ETA across all its sorties.
- **Text on the bar:** how many sorties per status, in the order IS, FP, LD, CL, IA, for example `2 IS • 1 FP • 3 LD`. It starts at the left of the bar like any label and is never truncated.
- **Flagged sorties:** the totals stay and a small red chip follows the status with how many are flagged, for example `5 IS [3 Past ETD] • 4 FP [2 Past ETA]`.
- With no actual bar the text sits above the estimate strip.
- Clicking the bar opens the mission.

### 3.4 Not scheduled

A mission **none of whose sorties has any of the four times**. It still appears in the date range through `anchor`.

- No bars. The mission row is **shaded**: only its own row when collapsed, **down to the last sortie** when open.
- Text "Not scheduled" stays on the mission's own row. No hover, no click.
- Table cells with no time show `ddHHmm` in `#6E6E6E`.

## 4. Design Tokens

Literal values are required in `GanttTimeline.js` (`TOKENS`) because AnyChart draws SVG and cannot read CSS variables. The CSS ones are the `--fg-*` variables at the top of `flightGantt.css`: **point them at your theme tokens**.

| What                                                                        | Value                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------- |
| Row / page background                                                       | `#121212`                                             |
| Bar fill / border                                                           | `#2C2C2C` / `#525252` (1px)                           |
| Estimate strip                                                              | `#525252`, 4px high                                   |
| Faded (closed, aborted, not scheduled)                                      | 60% opacity                                           |
| Attention red                                                               | `#F35962` (chip fill `#7B020A` at 70%)                |
| Now, updated dot                                                            | `#00DCFF`                                             |
| Selected bar (fill only; the border stays) and its table row                | `#003D54`                                             |
| Selected estimate strip (under a flown bar, or an issued or aborted sortie) | `#00799E`                                             |
| Table header, mission row, column-header row                                | `#2C2C2C`                                             |
| Zebra rows (odd / even)                                                     | `#525252` / `#3D3D3D`                                 |
| Not scheduled fill                                                          | `#2C2C2C` at 60%; text white at 60%                   |
| Bar label                                                                   | 14px / 600, `#FDFDFD`, 19.6px line                    |
| Chip                                                                        | 11px / 600, 16px line, padding 1px 8px, fully rounded |
| Timeline header labels                                                      | 13px                                                  |
| Table text                                                                  | 16px, Open Sans                                       |
| Bar height                                                                  | 35px (8px above and below inside the 52px row)        |
| Minimum bar width                                                           | 8px (a short flight stays visible and clickable)      |

---

## 5. How to add this to your existing AG Grid table

### Prerequisites

- React 18, `ag-grid-community` and `ag-grid-react` **33.x** (the prototype uses 33.3.2).
- **AnyChart 8.14.1** with the **Gantt module** (already in this repo's `package.json`; the npm package is the full bundle). It needs a **licence**; the prototype runs the trial, which draws a watermark. Confirm licensing before building on it. If you cannot use AnyChart, see "Replacing AnyChart" below.
- Open Sans and Material Symbols Outlined (or swap `Icon.jsx` for your icons).

### Steps

**1. Map your data** to the shape in section 3 (adapter above).

**2. Make your grid obey the row contract** (section 2). The options the prototype uses on `AgGridReact`:

```jsx
<AgGridReact
  theme={THEME}                      // themeQuartz.withParams({ rowHeight: ROW_H, ... }), see FlightGrid.jsx
  rowData={rowData}                  // from buildRows(), mapped as FlightGrid.jsx does
  columnDefs={COLUMN_DEFS}           // Callsign + Status pinned left; ETD, ETA, ATD, ATA scroll
  getRowId={(p) => p.data.rid}
  rowHeight={ROW_H}                  // 52
  headerHeight={0}                   // column names are shown per mission (the "cols" row)
  isFullWidthRow={(p) => p.rowNode.data.type === 'parent' || p.rowNode.data.type === 'end'}
  fullWidthCellRenderer={FullWidthRow}   // the mission row
  rowClassRules={...}                // zebra, mission/column-header colours, red flag border
  animateRows={false}
  suppressCellFocus
  onBodyScroll={(e) => e.direction === 'vertical' && timeline.scrollTo(e.top)}
/>
```

If your table already has columns, keep them: only the **row height, row order, full-width rows and the vertical scroll hook** are required.

**3. Build the row list once, feed both.**

```js
const visible = filterByRange(parents, [rangeStart, rangeEnd], now); // drops sorties outside the range
const rows = buildRows(visible, {
  query,
  collapsed /* Set of mission ids */,
  now,
});
// rows -> AG Grid rowData (map each row to a plain object with a stable `rid`)
// rows -> timeline.render({ rows, range, now })
```

Collapsing a mission = add its id to `collapsed` and rebuild. There is no AG Grid grouping involved.

**4. Mount the timeline** next to the grid (a `grid-template-columns: 751px 1fr` split in the prototype):

```jsx
useLayoutEffect(() => {
  const tl = new GanttTimeline(chartEl.current, {
    onBarClick: (flight, ev) =>
      flight.group
        ? toggleMission(flight.id.slice(2))
        : openTooltip(flight, ev),
    onEmptyClick: () => closeTooltip(),
    onRowHover: (id) => setHoverId(id),
    onViewSpan: (ms, [lo, hi]) => setSpan({ ms, lo, hi }), // enable/disable the zoom buttons
    onVerticalWheel: (dy) => {
      /* scroll the grid body by dy, return where it ended up */
    },
    onChartScroll: (y) => {
      /* the timeline's own scrollbar was dragged: scroll the grid */
    },
  });
  tlRef.current = tl;
  return () => tl.destroy();
}, []);

useLayoutEffect(() => {
  tlRef.current.render({ rows, range: [rangeStart, rangeEnd], now });
  tlRef.current.scrollTo(gridScrollTop(), true); // AG Grid owns vertical scroll
}, [rows, rangeStart, rangeEnd, now]);
```

Public API of `GanttTimeline`: `render`, `select(id)`, `zoomIn()`, `zoomOut()`, `scrollTo(px)`, `revealTime(ms)`, `getBarRect(id)` (to anchor a tooltip), `destroy()`.

**5. Wire the scroll both ways.** Grid → timeline: `onBodyScroll`. Timeline → grid: `onVerticalWheel` and `onChartScroll` set `scrollTop` on AG Grid's `.ag-body-viewport` (with `api.ensureIndexVisible` as a fallback). See `scrollGridTo` in `FlightGantt.jsx`.

**6. Hover and click.** Table `onCellMouseOver` → row hover band on the timeline. Table `onRowClicked` and a bar click both open the same tooltip. Sorties with no times have no bar, so they open nothing.

**7. Styles.** `flightGantt.css` is scoped under `.fg`. Replace the `--fg-*` tokens with yours. The AG Grid theme parameters (`THEME` in `FlightGrid.jsx`) are the PRIZM3 values.

**8. Replace the sample data** (`sampleData.js`), the tooltip fields (`fieldA/B/C`, `DEFAULT_DETAIL_FIELDS` in `FlightGantt.jsx`), and wire `onAcknowledge` if you use the `changed` shading.

### Replacing AnyChart

The contract is renderer-agnostic. Anything that can draw rows of a fixed pitch against a time axis can replace `GanttTimeline.js`, as long as it implements the same small API (`render`, `select`, `zoomIn`/`zoomOut`, `scrollTo`, `revealTime`, `getBarRect`, `destroy`) and the same drawing rules (section 4). `flightRules.js` has no React or AnyChart in it and carries over unchanged.

---

## 6. File map

```
package.json, vite.config.js, index.html   the Vite app (versions are pinned in package-lock.json)
.env.example                               where the AnyChart licence key goes
src/
  main.jsx                                 mounts the page; sets the AnyChart licence key
  demo/
    App.jsx                                stand-in host page: top navigation, page header, filters, prototype controls
    demo.css                               styles of that host page
  flight-gantt/                            <- the component: this is what you adapt into your app
    flightRules.js  FlightGantt.jsx  FlightGrid.jsx  GanttTimeline.js
    flightGantt.css  Icon.jsx  sampleData.js
```

| File in `src/flight-gantt/` | What it is                                                                                                                     | Keep or adapt                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `flightRules.js`            | Pure rules: statuses, `alertOf`, `aggregate`, `buildRows`, `filterByRange`, counts, anomalies, `ROW_H`. No React, no AnyChart. | **Keep** (port to TypeScript if you like) |
| `GanttTimeline.js`          | The timeline: AnyChart wrapper, bar and strip drawing, label and chip overlay, header labels, zoom and pan, Now line.          | **Adapt**                                 |
| `FlightGantt.jsx`           | The page component: puts grid and timeline together, scroll sync, tooltip, anomalies banner, toolbar, `collapsible` prop.      | **Adapt** to your page                    |
| `FlightGrid.jsx`            | AG Grid setup: theme, columns, full-width mission row, row classes.                                                            | **Merge** into your existing grid         |
| `flightGantt.css`           | Tokens and styles, scoped under `.fg`.                                                                                         | **Adapt**                                 |
| `Icon.jsx`                  | Material Symbols wrapper.                                                                                                      | Swap for yours                            |
| `sampleData.js`             | The 13 sample callsigns that produce every case, and the fixed "now".                                                          | Tests / Storybook                         |

`src/demo/` (the top navigation placeholder, the page header, the filters, the version switch and the date-range examples) is the **host page**, not part of the component: replace it with your own page. The `collapsible` prop (a version with no collapse view) is a prototype switch: ask product whether it ships.

---|---|---|
| `flightRules.js` | Pure rules: statuses, `alertOf`, `aggregate`, `buildRows`, `filterByRange`, counts, anomalies, `ROW_H`. No React, no AnyChart. | **Keep** (port to TypeScript if you like) |
| `GanttTimeline.js` | The timeline: AnyChart wrapper, bar and strip drawing, label and chip overlay, header labels, zoom and pan, Now line. | **Adapt** |
| `FlightGantt.jsx` | The page component: puts grid and timeline together, scroll sync, tooltip, anomalies banner, toolbar, `collapsible` prop. | **Adapt** to your page |
| `FlightGrid.jsx` | AG Grid setup: theme, columns, full-width mission row, row classes. | **Merge** into your existing grid |
| `flightGantt.css` | Tokens and styles, scoped under `.fg`. | **Adapt** |
| `Icon.jsx` | Material Symbols wrapper. | Swap for yours |
| `sampleData.js` | The 13 sample callsigns that produce every case. | Tests / Storybook |

The prototype's top navigation (version switch, date-range examples, Bar scenarios button) is the **host page**, not part of the component. The `collapsible` prop (a version with no collapse view) is a prototype switch: ask product whether it ships.

---

## 7. Gotchas we hit

- **AnyChart rows are uniform.** A per-item height only makes a bar taller, never the row. Don't try variable row heights in the table.
- **Colours must be literals** in the timeline code (SVG cannot read CSS variables).
- **Fonts:** label widths are measured in the browser. Make sure Open Sans is loaded before the first draw, or labels shift once the font arrives.
- **AG Grid owns vertical scroll.** If you let the timeline scroll on its own, rows drift apart.
- **`animateRows`** must be off, otherwise rows move while the timeline jumps.
- **Register the custom shapes without `fillName` / `strokeName`, and set every fill yourself in the drawer.** Otherwise AnyChart restyles them with its own hover and selected colours (orange by default) when a row is clicked. `GanttTimeline.js` does this and sets each strip's fill explicitly.
- **A full-width row's width** is the table pane's width, so the mission row's four pairs need about 800px to show without truncating; the prototype's pane is 751px (`grid-template-columns` in `.fg-split`).
