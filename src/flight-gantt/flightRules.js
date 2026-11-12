/**
 * Flight rules and row building. Pure functions: no React, no AnyChart.
 *
 * Data shape (all times are epoch milliseconds, UTC):
 *   parents = [{                          // a mission
 *     id, name, model,                     // model: HELI, TG, UAV or FTR
 *     info: { id, code, activityType },    // shown in the mission row; the callsign there is the common start of the sorties' callsigns
 *     anchor?: ms,                         // only for a callsign none of whose sorties has a time (not scheduled): the one time it has, used by the date range only
 *     children: [{
 *       id: 'SOUR01', code: 'IS' | 'FP' | 'LD' | 'IA' | 'CL',
 *       model, tail,                     // A/C model and tail number; model + tail is the aircraft the sortie flies
 *       etd, eta, atd?, ata?,            // planned and actual times
 *       changed?: ['eta'],               // fields updated since last refresh: shades the cell and tints the tooltip value
 *                                        // (none by default; the component clears a field when the user clicks its cell)
 *       fieldA, fieldB, fieldC           // extra values shown in the tooltip
 *     }]
 *   }]
 */

export const MODELS = ['HELI', 'TG', 'UAV', 'FTR'];

export const STATUS = {
  IS: 'Issued',
  FP: 'Flight in progress',
  LD: 'Landed',
  IA: 'Aborted',
  CL: 'Closed',
};

const pad = (n) => String(n).padStart(2, '0');

/** 21 Nov 23:30 UTC -> "212330" */
export const ddhhmm = (ms) => {
  if (ms == null) return '—';
  const d = new Date(ms);
  return pad(d.getUTCDate()) + pad(d.getUTCHours()) + pad(d.getUTCMinutes());
};

/** Aborted and Closed are end states. They are drawn faded and never raise a warning. */
export const isEnded = (c) => c.code === 'IA' || c.code === 'CL';

/** Chip text for a flight that needs attention, or null. A group (see aggregate) has one when any of its sorties does. */
export const alertOf = (c, now) => {
  if (c.group) { for (const s of c.sorties) { const a = alertOf(s, now); if (a) return a; } return null; }
  if (isEnded(c)) return null;
  if (c.atd == null && now > c.etd) return 'Past ETD';
  if (c.atd != null && c.ata == null && now > c.eta) return 'Past ETA';
  return null;
};

/** A sortie with none of its four times. */
export const hasNoTimes = (c) => !c.group && c.etd == null && c.eta == null && c.atd == null && c.ata == null;   // a collapsed mission (c.group) has its own times
/** A callsign none of whose sorties has a time: the timeline shades its rows and says Not scheduled instead of drawing bars. */
export const isUnscheduled = (p) => p.children.length > 0 && p.children.every(hasNoTimes);

/** The extent a sortie occupies: planned window (ETD to ETA) before departure, actual window (ATD to ATA, or now) after. A collapsed mission has its own. */
export const barRange = (c, now) => {
  if (c.group) return c.bar;   // a collapsed mission: the whole extent of its blocks and strips (see aggregate)
  return c.atd == null ? [c.etd, c.eta] : [c.atd, c.ata != null ? c.ata : now];
};

// ------------------------------------------------------------------ a collapsed mission: one row for several sorties
/**
 * A collapsed mission: ONE row, the same for every model (UAV, TG, HELI and FTR).
 *   actual    one bar from the earliest ATD to the latest ATA of all its sorties (a sortie still flying counts up to now);
 *             none when nothing has departed
 *   estimate  one strip, along the bottom of the bar, from the earliest ETD to the latest ETA of all its sorties
 *   counts    how many sorties are in each status: the text on the bar (2 IS • 1 FP • 3 LD)
 *   hit       the spans that open the mission when clicked
 */
export function aggregate(id, sorties, now) {
  const span = (list, lo, hi) => (list.length ? [Math.min(...list.map(lo)), Math.max(...list.map(hi))] : null);
  const actual = span(sorties.filter((c) => c.atd != null), (c) => c.atd, (c) => (c.ata != null ? c.ata : now));
  const estimate = span(sorties.filter((c) => c.etd != null && c.eta != null), (c) => c.etd, (c) => c.eta);
  const counts = {};
  sorties.forEach((c) => { counts[c.code] = (counts[c.code] || 0) + 1; });
  const spans = [actual, estimate].filter(Boolean), cur = sorties[0];
  return {
    id, group: true, sorties, actual, estimate, counts, hit: spans, label: cur.id, code: cur.code, model: cur.model, tail: cur.tail,
    bar: spans.length ? [Math.min(...spans.map((x) => x[0])), Math.max(...spans.map((x) => x[1]))] : [now, now],   // the whole extent: the click area
    fieldA: cur.fieldA, fieldB: cur.fieldB, fieldC: cur.fieldC,
  };
}

/** The order of the statuses in the text of a collapsed mission. */
export const STATUS_ORDER = ['IS', 'FP', 'LD', 'CL', 'IA'];

/** First and last moment a flight occupies on the timeline (bar plus deviation marks). */
const extent = (c, now) => [
  Math.min(c.etd, c.atd != null ? c.atd : c.etd),
  Math.max(c.eta, c.ata != null ? c.ata : c.atd != null ? now : c.eta),
];

/** Keeps flights that touch [start, end]. In production the API usually does this; the prototype emulates it. */
export function filterByRange(parents, [start, end], now) {
  return parents
    .map((p) => ({
      ...p, callsign: missionCallsign(p.children),
      // an unscheduled callsign has no times to compare, so its anchor time decides (without one it is always shown)
      children: isUnscheduled(p)
        ? (p.anchor == null || (p.anchor >= start && p.anchor <= end) ? p.children : [])
        : p.children.filter((c) => { const [a, b] = extent(c, now); return b >= start && a <= end; }),
    }))
    .filter((p) => p.children.length);
}

/** The callsign of a mission: what its sorties' callsigns have in common, without the number (SOUR01 to SOUR04 give SOUR). */
export function missionCallsign(children) {
  const ids = children.map((c) => c.id);
  if (!ids.length) return '';
  let n = 0;
  while (n < ids[0].length && ids.every((id) => id[n] === ids[0][n])) n += 1;
  return ids[0].slice(0, n).replace(/\d+$/, '');
}

const matches = (p, c, q) =>
  !q || (p.callsign || '').toLowerCase().includes(q) || c.id.toLowerCase().includes(q);

/**
 * Flat row list shared by the table and the timeline, so both always line up:
 *   mission row -> column header row -> sorties (zebra restarts per mission) -> final spacer
 * A collapsed mission carries `agg`, the single bar the timeline draws on its row (see aggregate).
 */
export function buildRows(parents, { query = '', collapsed = new Set(), now, spacer = true }) {
  const q = query.trim().toLowerCase();
  const rows = [];
  parents.forEach((p) => {
    const kids = p.children.filter((c) => matches(p, c, q));
    if (!kids.length) return;
    const unscheduled = isUnscheduled(p), at = rows.length;
    const head = {
      type: 'parent', p, flag: kids.some((c) => alertOf(c, now)), collapsed: collapsed.has(p.id), kids, agg: unscheduled ? null : aggregate(`m:${p.id}`, kids, now),
      callsign: p.callsign || missionCallsign(p.children), shown: kids.length, total: p.children.length,   // the mission row: callsign, and the sorties left by the search out of those in the date range
      unscheduled, rowSpan: 1,   // unscheduled: no bars; the timeline shades rowSpan rows (this one, and when open the columns row and every sortie) and says Not scheduled
    };
    rows.push(head);
    if (collapsed.has(p.id)) return;
    rows.push({ type: 'cols', p });
    kids.forEach((c, i) => rows.push({ type: 'child', p, c, zebra: i % 2 ? 'even' : 'odd', flag: !!alertOf(c, now) }));   // flag: the red left border belongs to the sortie
    head.rowSpan = rows.length - at;
  });
  // Spacer keeps the last flight clear of the timeline's horizontal scroll bar. Only wanted when the list overflows.
  if (spacer) rows.push({ type: 'end' });
  return rows;
}

/** How many sorties there are per status (IS, FP, LD, CL): the summary in the table's header row. Aborted (IA) is not counted. */
export const COUNT_STATUSES = ['IS', 'FP', 'LD', 'CL'];
export const countByStatus = (parents, { query = '' } = {}) => {
  const q = query.trim().toLowerCase(), out = Object.fromEntries(COUNT_STATUSES.map((k) => [k, 0]));
  parents.forEach((p) => p.children.forEach((c) => { if (c.code in out && matches(p, c, q)) out[c.code] += 1; }));
  return out;
};

/** Sorties in flight right now. */
export const countFlying = (parents, { query = '' } = {}) => {
  const q = query.trim().toLowerCase();
  return parents.reduce((n, p) => n + p.children.filter((c) => c.code === 'FP' && matches(p, c, q)).length, 0);
};

/** Flights that need attention, in display order, for the banner stepper. */
export function findAnomalies(parents, { query = '', now }) {
  const q = query.trim().toLowerCase();
  const out = [];
  parents.forEach((p) =>
    p.children.forEach((c) => {
      if (matches(p, c, q) && alertOf(c, now)) out.push({ parent: p.id, code: c.code, id: c.id, start: barRange(c, now)[0] });
    })
  );
  return out;
}

/** Row height in px, for the table rows and the timeline rows alike (the 1px row line AnyChart adds is inside it). */
export const ROW_H = 52;
