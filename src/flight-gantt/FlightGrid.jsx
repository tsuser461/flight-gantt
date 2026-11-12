import { useEffect, useMemo, useRef, useLayoutEffect } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import { ddhhmm, ROW_H } from './flightRules';
import { Icon } from './Icon';

// Skip this line if your app already registers AG Grid modules.
ModuleRegistry.registerModules([AllCommunityModule]);

/** PRIZM3 grid theme: the same values your other tables use (header and banding colours live in flightGantt.css). */
const THEME = themeQuartz.withParams({
  backgroundColor: '#121212', foregroundColor: '#FFFFFF', textColor: '#FFFFFF', accentColor: '#00DCFF',
  headerBackgroundColor: '#2C2C2C', headerTextColor: '#FDFDFD', headerFontSize: 16, headerFontWeight: 600,
  rowHeight: ROW_H, fontFamily: "'Open Sans', Helvetica, Arial, sans-serif", fontSize: 16,
  borderColor: 'rgba(255,255,255,0.12)', wrapperBorder: false, wrapperBorderRadius: 0,
  rowBorder: false, columnBorder: false, headerColumnBorder: false, headerColumnResizeHandleColor: 'transparent',
  rowHoverColor: 'transparent', oddRowBackgroundColor: 'transparent',
  pinnedColumnBorder: { style: 'solid', width: 1, color: '#6E6E6E' },   // line after the sticky Status column
  cellHorizontalPadding: 16, browserColorScheme: 'dark',
});

/** Callsign (230) and Status (145) are pinned left; the four time columns are 145 each and scroll sideways. */
export const COL_WIDTHS = [230, 145, 145, 145, 145, 145];
const HEAD = ['Callsign', 'Status', 'ETD', 'ETA', 'ATD', 'ATA'];

const isChild = (p) => p.data.type === 'child';
// A cell is shaded when its value changed since the last refresh: put the field name in flight.changed.
const dirty = (key) => ({ 'fg-dirty': (p) => isChild(p) && !!(p.data.c.changed && p.data.c.changed.includes(key)) });
const col = (i, colId, get, pinned) => ({
  colId, headerName: HEAD[i], width: COL_WIDTHS[i], pinned, lockPinned: !!pinned,
  valueGetter: (p) => (isChild(p) ? get(p.data.c) : HEAD[i]),   // the column-header row under each mission is an ordinary row
  cellClassRules: dirty(colId),
});
// A time column. When the time is not there (an aircraft that has not left has no ATD), the cell shows the format, ddHHmm, in muted grey instead of a dash.
const timeCol = (i, colId) => {
  const d = col(i, colId, (c) => (c[colId] == null ? 'ddHHmm' : ddhhmm(c[colId])));
  d.cellClassRules = { ...d.cellClassRules, 'fg-nodate': (p) => isChild(p) && p.data.c[colId] == null };
  return d;
};
const COLUMN_DEFS = [
  col(0, 'id', (c) => c.id, 'left'),
  col(1, 'code', (c) => c.code, 'left'),
  timeCol(2, 'etd'),
  timeCol(3, 'eta'),
  timeCol(4, 'atd'),
  timeCol(5, 'ata'),
];
const DEFAULT_COL = { sortable: false, resizable: false, suppressMovable: true, suppressHeaderMenuButton: true };

const ROW_CLASS_RULES = {
  'fg-parent': (p) => p.data.type === 'parent',
  'fg-flag': (p) => isChild(p) && p.data.flag,   // red left border on the sortie row that needs attention (not on its mission)
  'fg-cols': (p) => p.data.type === 'cols',
  'fg-end': (p) => p.data.type === 'end',
  'fg-child': isChild,
  'fg-odd': (p) => isChild(p) && p.data.zebra === 'odd',      // zebra restarts under every mission
  'fg-even': (p) => isChild(p) && p.data.zebra === 'even',
  'fg-hover': (p) => isChild(p) && p.data.hover,   // hovered on the timeline side
  'fg-selected': (p) => isChild(p) && p.data.selected,   // the clicked sortie (from the bar or the table): its row turns --fg-selected
};

// Full-width rows: the parent line and the closing spacer. The parent line reads: four label/value pairs (the labels are muted, the
// values bright; 24px between pairs; the values are what gets cut with an ellipsis when it is too long), and at the right "shown/total sorties".
function FullWidthRow({ data, context }) {
  if (data.type !== 'parent') return <div className="fg-fw" />;
  const info = data.p.info || {};
  const fields = [['CALLSIGN', data.callsign], ['ID', info.id], ['CODE', info.code], ['ACTIVITY TYPE', info.activityType]];
  // The pairs line up from one mission row to the next: the widest value seen in each of the first three columns (callsign, id, code) sets the
  // width of that column for every mission row, kept on the grid as --fg-w-1 .. --fg-w-3 (the activity, last, takes what is left).
  const rowRef = useRef(null);
  useLayoutEffect(() => {
    const root = rowRef.current && rowRef.current.closest('.fg-ag');
    if (!root) return;
    const range = document.createRange();
    [...rowRef.current.querySelectorAll('.fg-fw-value')].slice(0, 3).forEach((v, i) => {
      range.selectNodeContents(v);   // the text's own width (scrollWidth is rounded down, and a fraction of a pixel too narrow shows an ellipsis)
      const w = Math.ceil(range.getBoundingClientRect().width) + 1, key = `--fg-w-${i + 1}`;
      if (w > (parseFloat(root.style.getPropertyValue(key)) || 0)) root.style.setProperty(key, `${w}px`);
    });
  });
  // A pair whose label does not fit is hidden completely (never half a label); the values cut themselves with an ellipsis.
  const fieldsRef = useRef(null);
  useLayoutEffect(() => {
    const box = fieldsRef.current;
    if (!box) return undefined;
    const fit = () => {
      const edge = box.getBoundingClientRect().right;
      [...box.children].forEach((f) => { f.style.visibility = ''; });
      [...box.children].forEach((f) => { if (f.firstChild.getBoundingClientRect().right > edge + 0.5) f.style.visibility = 'hidden'; });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    [...box.children].forEach((f) => ro.observe(f));   // a column width changing (another row had a longer value) moves the pairs too
    return () => ro.disconnect();
  }, [data.callsign, data.shown, data.total]);
  return (
    <div className={`fg-fw fg-fw-parent${data.flag ? ' fg-flag' : ''}${data.fixed ? ' fg-nocollapse' : ''}`} data-parent={data.p.id} ref={rowRef}>
      <button type="button" {...(data.fixed ? { tabIndex: -1 } : { 'aria-expanded': data.open })} onClick={(e) => { e.stopPropagation(); if (!data.fixed) context.toggleGroup(data.p.id); }}>
        {!data.fixed && <Icon name={data.open ? 'expand_more' : 'chevron_right'} />}   {/* without the collapse view the mission is a plain header: no chevron, nothing to click */}
        <span className="fg-fw-fields" ref={fieldsRef}>
          {fields.map(([label, value]) => (
            <span className="fg-fw-field" key={label}><span className="fg-fw-label">{label}</span><span className="fg-fw-value">{value}</span></span>
          ))}
        </span>
        <span className="fg-fw-count">{data.shown}/{data.total} sorties</span>
      </button>
    </div>
  );
}

/**
 * The left-hand table, as real AG Grid. `rows` is the same list the timeline draws (see buildRows), so row i here
 * is row i there. Sorting and column filters are off for that reason; if you enable them, read the display order
 * with api.forEachNodeAfterFilterAndSort and pass that order to the timeline instead.
 */
export default function FlightGrid({ rows, selectedId, hoverId, collapsible = true, onToggleGroup, onSelect, onAcknowledge, onScroll, onReady, onHover }) {
  const rowData = useMemo(() => rows.map((r) => {
    if (r.type === 'parent') return { rid: `p-${r.p.id}`, type: 'parent', p: r.p, callsign: r.callsign, shown: r.shown, total: r.total, flag: r.flag, open: !r.collapsed, fixed: !collapsible };
    if (r.type === 'cols') return { rid: `h-${r.p.id}`, type: 'cols' };
    if (r.type === 'child') return { rid: `c-${r.c.id}`, type: 'child', c: r.c, zebra: r.zebra, flag: r.flag, hover: r.c.id === hoverId, selected: r.c.id === selectedId };
    return { rid: 'end', type: 'end' };
  }), [rows, selectedId, hoverId, collapsible]);

  // Callbacks go through a ref so AG Grid's props stay stable between renders
  const cb = useRef({});
  cb.current = { onToggleGroup, onSelect, onAcknowledge, onScroll, onReady, onHover };
  const context = useMemo(() => ({ toggleGroup: (id) => cb.current.onToggleGroup(id) }), []);
  useEffect(() => () => { if (cb.current.onReady) cb.current.onReady(null); }, []);   // let the parent drop its api reference

  return (
    <div className="fg-ag">
      <AgGridReact
        theme={THEME}
        rowData={rowData}
        columnDefs={COLUMN_DEFS}
        defaultColDef={DEFAULT_COL}
        getRowId={(p) => p.data.rid}
        rowHeight={ROW_H}
        headerHeight={0}                 /* column names are shown per parent instead */
        isFullWidthRow={(p) => p.rowNode.data.type === 'parent' || p.rowNode.data.type === 'end'}
        fullWidthCellRenderer={FullWidthRow}
        rowClassRules={ROW_CLASS_RULES}
        context={context}
        animateRows={false}
        suppressCellFocus
        onGridReady={(e) => cb.current.onReady && cb.current.onReady(e.api)}
        onBodyScroll={(e) => { if (e.direction === 'vertical') cb.current.onScroll(e.top); }}
        onCellMouseOver={(e) => cb.current.onHover && cb.current.onHover(e.data && e.data.type === 'child' ? e.rowIndex : -1)}
        onCellMouseOut={() => cb.current.onHover && cb.current.onHover(-1)}
        onRowClicked={(e) => { if (e.data.type === 'child') cb.current.onSelect(e.data.c.id, e.event && e.event.clientX, e.event && e.event.clientY); }}
        onCellClicked={(e) => {   // clicking a shaded cell acknowledges the update and removes the shading
          const key = e.column.getColId();
          if (e.data.type === 'child' && e.data.c.changed && e.data.c.changed.includes(key)) cb.current.onAcknowledge(e.data.c, key);
        }}
      />
    </div>
  );
}
