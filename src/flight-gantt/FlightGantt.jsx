import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GanttTimeline, HEADER_H } from './GanttTimeline';
import FlightGrid from './FlightGrid';
import { Icon } from './Icon';
import { alertOf, buildRows, COUNT_STATUSES, countByStatus, ddhhmm, filterByRange, findAnomalies, hasNoTimes, ROW_H } from './flightRules';
import './flightGantt.css';

/** Extra values shown in the tooltip's 3-column grid. Point `key` at your real field names. */
const DEFAULT_DETAIL_FIELDS = [
  { key: 'fieldA', label: 'Field A' },
  { key: 'fieldB', label: 'Field B' },
  { key: 'fieldC', label: 'Field C' },
];

/**
 * Read-only flight Gantt: an AG Grid table on the left and an AnyChart timeline on the right (Project chart: actual time is
 * the bar, estimated time a small strip under it). Missions open into their sorties; a collapsed mission is a row of bars (see aggregate in flightRules.js).
 *
 * Props
 *   parents        data (see flightRules.js)
 *   now            "current time", epoch ms
 *   range          [startMs, endMs] to show, at most 48 hours (a longer one is cut to 48 hours from its start); the view opens on the first 12 hours of it; zoom goes from the
 *                  whole range down to 12 hours, in steps of 12, 24, 36 and 48 hours
 *   query          search text (filters missions and callsigns)
 *   detailFields   tooltip fields, see DEFAULT_DETAIL_FIELDS
 *   onAcknowledge  optional (flightId, field) => void, called when the user clears an updated value
 *   statusSlot     optional DOM element: the anomalies banner is rendered there (e.g. next to the page title)
 *   toolsSlot      optional DOM element: zoom, expand/collapse all and full page are rendered there (e.g. in the toolbar)
 *                  Without a slot they appear in a row above the chart; in full page mode they always do.
 */
const NOTHING_COLLAPSED = new Set();

export default function FlightGantt({ parents, now, range, query = '', detailFields = DEFAULT_DETAIL_FIELDS, onAcknowledge, statusSlot = null, toolsSlot = null, collapsible = true }) {
  const [collapsedSet, setCollapsed] = useState(() => new Set());   // missions that are closed
  const collapsed = collapsible ? collapsedSet : NOTHING_COLLAPSED;   // without the collapse view every mission is always open
  const [selectedId, setSelectedId] = useState(null);
  const [tip, setTip] = useState(null);          // { flight, x, y, pinned }
  const [full, setFull] = useState(false);
  const [hoverId, setHoverId] = useState(null);   // sortie hovered on the timeline side (the table highlights it)
  const [focus, setFocus] = useState(null);      // set by the stepper: scroll to a sortie
  const [ack, setAck] = useState({});            // `${callsign}:${field}` -> the value the user acknowledged
  const [span, setSpan] = useState({ ms: 0, lo: 0, hi: 0 });   // visible window and the limits for it, for the zoom buttons

  const gridWrapRef = useRef(null);
  const gridApi = useRef(null);
  const chartRef = useRef(null);
  const tlRef = useRef(null);
  const tipRef = useRef(null);
  const pinned = useRef(false);
  const pinnedId = useRef(null);

  const rangeStart = range[0], rangeEnd = Math.min(range[1], range[0] + 48 * 3600000);   // 48 hours at most
  const visible = useMemo(() => filterByRange(parents, [rangeStart, rangeEnd], now), [parents, rangeStart, rangeEnd, now]);
  // An updated value stays flagged until the user clicks it, and is flagged again if the value changes again
  const effective = useMemo(() => visible.map((p) => ({
    ...p,
    children: p.children.map((c) => {
      if (!c.changed || !c.changed.length) return c;
      const left = c.changed.filter((f) => ack[`${c.id}:${f}`] !== c[f]);
      return left.length === c.changed.length ? c : { ...c, changed: left };
    }),
  })), [visible, ack]);
  const flightById = useMemo(() => new Map(effective.flatMap((p) => p.children.map((c) => [c.id, c]))), [effective]);

  const base = useMemo(() => buildRows(effective, { query, collapsed, now, spacer: false }), [effective, query, collapsed, now]);
  const [viewH, setViewH] = useState(0);   // height of the chart area
  const overflow = viewH === 0 || 52 + base.length * ROW_H > viewH;   // the bottom spacer row is only needed when the rows overflow
  const rows = useMemo(() => (overflow ? [...base, { type: 'end' }] : base), [base, overflow]);
  const counts = useMemo(() => countByStatus(effective, { query }), [effective, query]);
  const anomalies = useMemo(() => findAnomalies(effective, { query, now }), [effective, query, now]);
  const empty = base.length === 0;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const idx = anomalies.findIndex((a) => a.id === selectedId);   // -1 when nothing is selected, shown as "0 of N"

  const showTip = useCallback((t) => { pinned.current = !!(t && t.pinned); pinnedId.current = t && t.pinned ? t.flight.id : null; setTip(t); }, []);
  const closeTip = useCallback(() => showTip(null), [showTip]);

  // Collapsing a mission hides the tooltip of its sorties (their bars are gone) and clears the highlight. Updated values stay unacknowledged.
  useEffect(() => {
    const id = selectedId || (tip && tip.flight && tip.flight.id);
    if (!id) return;
    const m = effective.find((p) => p.children.some((c) => c.id === id));
    if (m && collapsed.has(m.id)) { closeTip(); setSelectedId(null); }
  }, [collapsed, selectedId, tip, effective, closeTip]);
  const liveApi = () => (gridApi.current && !gridApi.current.isDestroyed() ? gridApi.current : null);   // the grid unmounts when nothing matches
  const gridTop = () => { const api = liveApi(); return api ? api.getVerticalPixelRange().top : 0; };

  const acknowledge = useCallback((flight, field) => {
    setAck((prev) => ({ ...prev, [`${flight.id}:${field}`]: flight[field] }));
    if (onAcknowledge) onAcknowledge(flight.id, field);
  }, [onAcknowledge]);
  const ackRef = useRef(acknowledge);
  ackRef.current = acknowledge;

  // Clicking a bar or a table row does the same thing: highlight the row and the bar and open the tooltip. Clicking the same
  // sortie again closes the tooltip, clears the highlight and acknowledges its updated values.
  const toggleFlight = useCallback((flight, x, y) => {
    if (!flight || hasNoTimes(flight)) return;   // a sortie with no times has no bar: nothing to highlight, no tooltip
    if (pinned.current && pinnedId.current === flight.id) {
      showTip(null); setSelectedId(null);
      (flight.changed || []).forEach((f) => ackRef.current(flight, f));
      return;
    }
    setSelectedId(flight.id);
    showTip({ flight, x, y, pinned: true });
  }, [showTip]);
  // The area the tooltip may show in: the chart's rows (below its header, above its bottom edge). A card attached to a bar that is scrolled out of view is cut off here.
  const chartClip = useCallback(() => { const r = chartRef.current.getBoundingClientRect(); return { top: r.top + HEADER_H, bottom: r.bottom }; }, []);
  const barRectOf = useCallback((id) => (tlRef.current ? tlRef.current.getBarRect(id) : null), []);   // where the tooltip anchors
  const toggleRef = useRef(toggleFlight);
  toggleRef.current = toggleFlight;

  // Open or close a mission
  const toggleGroup = useCallback((id) => setCollapsed((prev) => { const s = new Set(prev); if (s.has(id)) s.delete(id); else s.add(id); return s; }), []);
  const toggleGroupRef = useRef(toggleGroup);
  toggleGroupRef.current = toggleGroup;

  // Moves the AG Grid body to a vertical pixel offset. AG Grid has no public call for this, so the body viewport is used,
  // with ensureIndexVisible (public, row by row) as the fallback if a future version restructures the viewport.
  const scrollGridTo = (y) => {
    const vp = gridWrapRef.current && gridWrapRef.current.querySelector('.ag-body-viewport');
    if (vp) { vp.scrollTop = y; return; }
    const api = liveApi();
    if (api) api.ensureIndexVisible(Math.max(0, Math.min(rowsRef.current.length - 1, Math.round(y / ROW_H))), 'top');
  };
  const scrollGridRef = useRef(scrollGridTo);
  scrollGridRef.current = scrollGridTo;

  // Create the timeline once (layout effect so it exists before the first draw below)
  useLayoutEffect(() => {
    const tl = new GanttTimeline(chartRef.current, {
      // A sortie's bar opens the tooltip; the one bar of a collapsed mission just opens the mission (the sorties then show their own bars)
      onBarClick: (flight, ev) => (flight.group ? toggleGroupRef.current(flight.id.slice(2)) : toggleRef.current(flight, ev.clientX, ev.clientY)),
      onEmptyClick: () => { closeTip(); setSelectedId(null); },
      onRowHover: (id) => setHoverId(id),
      onViewSpan: (ms, [lo, hi]) => setSpan({ ms, lo, hi }),
      // Wheel over the timeline scrolls the AG Grid body; the grid's scroll event then moves the timeline
      onVerticalWheel: (dy) => {
        const vp = gridWrapRef.current && gridWrapRef.current.querySelector('.ag-body-viewport');
        scrollGridRef.current((vp ? vp.scrollTop : gridTop()) + dy);
        return vp ? vp.scrollTop : gridTop();   // where the table ended up, so the timeline can move in the same frame
      },
      onChartScroll: (y) => scrollGridRef.current(y),   // the timeline's own vertical scrollbar was dragged
    });
    tlRef.current = tl;
    return () => { tl.destroy(); tlRef.current = null; };
  }, [closeTip]);

  useLayoutEffect(() => { setViewH(chartRef.current.clientHeight); }, []);

  // Redraw when rows, data, window or layout change. Zoom and pan are kept unless `range` changes.
  useLayoutEffect(() => {
    if (empty) return;
    const tl = tlRef.current;
    tl.render({ rows, range: [rangeStart, rangeEnd], now });
    tl.scrollTo(gridTop(), true);   // AG Grid owns vertical scroll
  }, [rows, rangeStart, rangeEnd, now, full, empty]);

  useEffect(() => { tlRef.current.select(selectedId); }, [selectedId]);

  // Redraw when the container is resized (window resize, full page)
  useEffect(() => {
    let t;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        setViewH(chartRef.current.clientHeight);
        if (tlRef.current && chartRef.current.clientWidth) tlRef.current.render({});
      }, 150);
    });
    ro.observe(chartRef.current);
    return () => { clearTimeout(t); ro.disconnect(); };
  }, []);

  // Stepper target: scroll to the mission, then bring the bar's start into view
  useEffect(() => {
    if (!focus) return undefined;
    // wait one frame so AG Grid has applied the expanded rows, then put the mission row at the top
    const raf = requestAnimationFrame(() => {
      const i = rowsRef.current.findIndex((r) => r.type === 'parent' && r.p.id === focus.parentId);
      const api = liveApi();
      if (api && i >= 0) api.ensureIndexVisible(i, 'top');
    });
    tlRef.current.revealTime(focus.start);
    return () => cancelAnimationFrame(raf);
  }, [focus]);

  // Esc closes the pinned tooltip, then full page. A click elsewhere closes the tooltip.
  useEffect(() => {
    const onKey = (e) => { if (e.key !== 'Escape') return; if (pinned.current) closeTip(); else if (full) setFull(false); };
    const onDown = (e) => {
      if (!pinned.current) return;
      if (tipRef.current && tipRef.current.contains(e.target)) return;
      if (chartRef.current.contains(e.target)) return;
      if (gridWrapRef.current && gridWrapRef.current.contains(e.target)) return;   // table rows toggle it themselves
      closeTip();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [full, closeTip]);

  const expandAll = () => setCollapsed(new Set());
  const collapseAll = () => setCollapsed(new Set(base.filter((r) => r.type === 'parent').map((r) => r.p.id)));

  const step = (dir) => {
    const n = anomalies.length;
    if (!n) return;
    if (dir < 0 && idx === 0) { closeTip(); setSelectedId(null); return; }   // up from 1 of N goes back to 0: nothing selected
    const a = anomalies[idx < 0 ? 0 : Math.min(n - 1, Math.max(0, idx + dir))];
    setCollapsed((prev) => { if (!prev.has(a.parent)) return prev; const s = new Set(prev); s.delete(a.parent); return s; });
    setSelectedId(a.id);
    // the tooltip opens too, as if the bar had been clicked; it anchors to the bar and follows it while the view scrolls there
    const flight = flightById.get(a.id);
    if (flight) showTip({ flight, x: window.innerWidth / 2, y: window.innerHeight / 2, pinned: true });
    setFocus({ parentId: a.parent, flightId: a.id, start: a.start, nonce: Date.now() });
  };

  const n = anomalies.length;
  const statusNode = (
    <>
      <div className={`fg-banner${n === 0 ? ' fg-banner--ok' : ''}`} role="status">
        <Icon name={n === 0 ? 'check_circle' : 'error'} />
        <span className="fg-banner-msg">{n === 0 ? 'No anomalies found' : `${n} ${n === 1 ? 'anomaly' : 'anomalies'} found`}</span>
        <div className="fg-step">
          <button type="button" className="fg-icon-btn" aria-label="Previous anomaly" disabled={n === 0 || idx < 0} onClick={() => step(-1)}><Icon name="keyboard_arrow_up" /></button>
          <span className="fg-count">{idx + 1} of {n}</span>
          <button type="button" className="fg-icon-btn" aria-label="Next anomaly" disabled={n === 0 || idx >= n - 1} onClick={() => step(1)}><Icon name="keyboard_arrow_down" /></button>
        </div>
      </div>
    </>
  );
  const allOpen = base.every((r) => r.type !== 'parent' || !r.collapsed);   // one button: collapses when every mission is open, otherwise expands
  const toolsNode = (
    <div className="fg-zoom">
      <button type="button" className="fg-icon-btn" aria-label="Zoom in" disabled={!!span.ms && span.ms <= span.lo + 1} onClick={() => tlRef.current.zoomIn()}><Icon name="zoom_in" /></button>
      <button type="button" className="fg-icon-btn" aria-label="Zoom out" disabled={!!span.ms && span.ms >= span.hi - 1} onClick={() => tlRef.current.zoomOut()}><Icon name="zoom_out" /></button>
      {collapsible && <span className="fg-hint" data-hint={allOpen ? 'Click to collapse all rows' : 'Click to expand all rows'}>
        <button type="button" className="fg-icon-btn" aria-label={allOpen ? 'Collapse all' : 'Expand all'} onClick={allOpen ? collapseAll : expandAll}><Icon name={allOpen ? 'collapse_all' : 'expand_all'} /></button>
      </span>}
      <button type="button" className="fg-icon-btn" aria-label={full ? 'Exit full page' : 'Full page'} onClick={() => setFull((x) => !x)}><Icon name={full ? 'fullscreen_exit' : 'fullscreen'} /></button>
    </div>
  );
  const inlineStatus = !statusSlot || full, inlineTools = !toolsSlot || full;   // full page always carries its own controls
  return (
    <section className={`fg${full ? ' fg--full' : ''}`} aria-label="Gantt chart">
      {empty && <EmptyState />}
      {!empty && !full && statusSlot && createPortal(<div className="fg-slot">{statusNode}</div>, statusSlot)}
      {!empty && !full && toolsSlot && createPortal(<div className="fg-slot">{toolsNode}</div>, toolsSlot)}
      <div className="fg-body" hidden={empty}>
        {(inlineStatus || inlineTools) && (
          <div className="fg-top">
            {inlineStatus ? <div className="fg-status">{statusNode}</div> : <span />}
            {inlineTools && toolsNode}
          </div>
        )}

        <div className="fg-split">
          <div className="fg-grid">
            <div className="fg-grid-spacer"><span className="fg-flying" role="status"><span className="fg-flying-label">Sorties</span>{COUNT_STATUSES.map((k, i) => <span key={k}>{i > 0 && <span className="fg-flying-dot" aria-hidden="true">&bull;</span>}{counts[k]} {k}</span>)}</span></div>   {/* the table's header row, level with the timeline's time scale: sorties per status: IS, FP, LD, CL */}
            <div className="fg-grid-body" ref={gridWrapRef}>
              {!empty && (
                <FlightGrid
                  rows={rows}
                  selectedId={selectedId}
                  hoverId={hoverId}
                  onHover={(i) => tlRef.current && tlRef.current.setHoverRow(i)}   // pointer is over a table row: highlight its timeline row
                  onToggleGroup={toggleGroup}
                  collapsible={collapsible}
                  onSelect={(id, x, y) => toggleRef.current(flightById.get(id), x, y)}
                  onAcknowledge={acknowledge}
                  onScroll={(top) => tlRef.current && tlRef.current.scrollTo(top)}
                  onReady={(api) => { gridApi.current = api; }}
                />
              )}
            </div>
          </div>
          <div className="fg-timeline"><div className="fg-chart" ref={chartRef} /></div>
        </div>
      </div>

      {tip && <FlightTip tip={tip} flight={flightById.get(tip.flight.id) || tip.flight} now={now} fields={detailFields} tipRef={tipRef} getAnchor={barRectOf} getClip={chartClip} />}
    </section>
  );
}

/** Shown instead of the banner, table and timeline when nothing matches the time range or filter. */
function EmptyState() {
  return (
    <div className="fg-empty-state" role="status">
      <span className="fg-icon fg-empty-icon" aria-hidden="true">list</span>
      <div className="fg-empty-title">No results found.</div>
      <div className="fg-empty-text">Try adjusting your start and end time or filter to find what you're looking for</div>
    </div>
  );
}

const HIDDEN_AT_FIRST = { left: -9999, top: -9999 };   // FlightTip positions itself right after mounting
const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

function FlightTip({ tip, flight: c, now, fields, tipRef, getAnchor, getClip }) {
  const last = useRef(null);
  // Sits just below the sortie's bar (above it when there is no room), centred on the visible part of the bar, and follows the
  // bar while the chart scrolls, pans or zooms. When the bar is scrolled out of view the card goes with it: it slides out under the header
  // (or off the bottom) and is still there when the bar comes back. Falls back to where the pointer was if the bar is out of the time window.
  useLayoutEffect(() => {
    const el = tipRef.current;
    let raf;
    last.current = null;   // a different sortie: do not start from the previous bar's position
    let above = null;      // below or above its bar: decided once, so it does not jump while it follows the bar
    const place = () => {
      const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
      const r = getAnchor(c.id) || last.current || { left: tip.x, right: tip.x, top: tip.y, bottom: tip.y };
      last.current = r;
      const left = Math.min(Math.max(8, (r.left + r.right) / 2 - w / 2), vw - w - 8);
      if (above === null) above = r.bottom + 8 + h > vh - 8;
      const top = above ? r.top - h - 8 : r.bottom + 8;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      // Cut the card to the chart's rows, so it slides out under the header with its bar. At the bottom it is only cut once the bar itself is out of
      // view (a card for a bar near the bottom may hang over the chart's lower edge); hidden once nothing of it is left
      const clip = getClip(), barOut = r.bottom < clip.top || r.top > clip.bottom;
      const cutTop = Math.min(h, Math.max(0, clip.top - top)), cutBottom = barOut ? Math.min(h, Math.max(0, top + h - clip.bottom)) : 0;
      if (cutTop + cutBottom >= h) { el.style.visibility = 'hidden'; }
      else { el.style.visibility = 'visible'; el.style.clipPath = cutTop || cutBottom ? `inset(${cutTop}px -16px ${cutBottom}px -16px)` : 'none'; }
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [tip.x, tip.y, c.id, getAnchor, getClip, tipRef]);

  const alert = !!alertOf(c, now);                 // red outline on the bar: the status text turns red too
  const changed = new Set(c.changed || []);        // updated values are tinted until acknowledged
  const pair = (label, key, value) => (
    <div className={`fg-tip-pair${changed.has(key) ? ' fg-tip-changed' : ''}`} style={{ gridColumn: key === 'etd' || key === 'eta' ? 1 : 3 }} title={String(value)}>
      <span className="fg-tip-label">{label}</span>{value}
    </div>
  );
  const statusClass = alert ? ' fg-tip-status--alert' : '';
  const valueClass = !alert && changed.has('code') ? ' fg-tip-changed' : '';
  return (
    <div ref={tipRef} className={`fg-tip${tip.pinned ? ' fg-tip--pinned' : ''}`} style={HIDDEN_AT_FIRST} role="tooltip">
      <div className="fg-tip-grid">
        <h6 className="fg-h6 fg-tip-call">{c.id}</h6>
        <h6 className={`fg-h6 fg-tip-status${statusClass}`}>
          <span className="fg-tip-status-label">Status</span><span className={`fg-tip-status-value${valueClass}`}>: {c.code}</span>
        </h6>
        <div className="fg-tip-rule" />
        {pair('ETD', 'etd', ddhhmm(c.etd))}{pair('ATD', 'atd', ddhhmm(c.atd))}
        {pair('ETA', 'eta', ddhhmm(c.eta))}{pair('ATA', 'ata', ddhhmm(c.ata))}
        {chunk(fields, 3).map((row) => [
          ...row.map((f) => <div key={`l-${f.key}`} className="fg-tip-label fg-tip-field-label">{f.label}</div>),
          ...row.map((f) => <div key={`v-${f.key}`} className="fg-tip-value" title={String(c[f.key] ?? '')}>{c[f.key] ?? '—'}</div>),
        ])}
      </div>
    </div>
  );
}
