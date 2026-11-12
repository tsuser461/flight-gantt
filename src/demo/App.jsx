import { useEffect, useState } from 'react';
import FlightGantt from '../flight-gantt/FlightGantt.jsx';
import { NOW, PARENTS, DEFAULT_RANGE, RANGE_2D } from '../flight-gantt/sampleData.js';
import './demo.css';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const MAX_RANGE = 48 * 3600000;   // the longest time range the chart accepts
const fmtLong = (ms) => { const d = new Date(ms); return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCFullYear() % 100)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const parseDT = (s) => {
  const m = /^\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2})\s+(\d{1,2}):(\d{2})\s*$/.exec(s || '');
  if (!m) return null;
  const mo = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  return mo < 0 ? null : Date.UTC(2000 + +m[3], mo, +m[1], +m[4], +m[5]);
};
const Ms = ({ name, className = '' }) => <span className={`ms ${className}`} aria-hidden="true">{name}</span>;

// The host page around the component: a placeholder for the app's top navigation, the page header, the filters and the buttons.
// Only <FlightGantt .../> below is the component; everything else here stands in for what your page already has.
function App() {
  const [parents, setParents] = useState(PARENTS);   // no flight starts out as updated
  const [startText, setStartText] = useState(fmtLong(DEFAULT_RANGE[0]));
  const [endText, setEndText] = useState(fmtLong(DEFAULT_RANGE[1]));
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [startBad, setStartBad] = useState(false);
  const [endBad, setEndBad] = useState(false);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState('');
  const [collapsible, setCollapsible] = useState(true);   // version: with or without the collapse view
  const [statusEl, setStatusEl] = useState(null);   // where the flying count and anomalies banner are rendered (next to the title)
  const [toolsEl, setToolsEl] = useState(null);     // where zoom, expand/collapse all and full page are rendered (in the toolbar)

  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(''), 2400); return () => clearTimeout(t); }, [toast]);

  const applyRange = () => {
    const a = parseDT(startText), b = parseDT(endText);
    const okA = a != null, okB = b != null && (a == null || b > a);
    const tooLong = okA && okB && b - a > MAX_RANGE;   // the range is 48 hours at most
    setStartBad(!okA); setEndBad(!okB || tooLong);
    if (tooLong) setToast('The time range can be 48 hours at most.');
    else if (okA && okB) { setRange([a, b]); setStartText(fmtLong(a)); setEndText(fmtLong(b)); }
  };
  const onKey = (e) => { if (e.key === 'Enter') applyRange(); };

  // Two date-range examples. The view opens on the first 12 hours of the range; zoom out can go as far as the range (1 day: 24 h, 2 days: 48 h).
  const RANGES = [['1 day', DEFAULT_RANGE], ['2 days', RANGE_2D]];
  const chooseRange = ([a, b]) => { setStartBad(false); setEndBad(false); setRange([a, b]); setStartText(fmtLong(a)); setEndText(fmtLong(b)); };
  const notWired = (label) => setToast(`${label} isn’t wired up in this prototype.`);

  return (
    <>
      <header className="topnav">
        <span className="placeholder">Top navigation (66px)</span>
        <div className="proto" aria-label="Prototype controls">
          <span className="tag">Prototype</span>
          <span>Version:</span>
          {[['With collapse', true], ['Without collapse', false]].map(([label, on]) => <button key={label} type="button" className="btn ghost" aria-pressed={collapsible === on} onClick={() => setCollapsible(on)}>{label}</button>)}
          <span>Date range example:</span>
          {RANGES.map(([label, r]) => <button key={label} type="button" className="btn ghost" aria-pressed={range[0] === r[0] && range[1] === r[1]} onClick={() => chooseRange(r)}>{label}</button>)}
        </div>
      </header>

      <main>
        <div className="page-head">
          <div className="head-left">
            <h1>Flights</h1>
            <div className="head-status" ref={setStatusEl} />
          </div>
          <div className="head-tools">
            <div className="toggle icons" role="group" aria-label="View">
              {[['splitscreen', 'Split screen'], ['visibility', 'Visibility'], ['table_rows', 'Table rows'], ['view_timeline', 'Gantt chart']].map(([icon, label]) => (
                <button key={icon} type="button" aria-label={label} aria-pressed={icon === 'view_timeline'}><Ms name={icon} /></button>
              ))}
            </div>
            <button type="button" className="icon-btn accent rot90" aria-label="Manage table" onClick={() => notWired('Manage table')}><Ms name="tune" /></button>
          </div>
        </div>

        <div className="toolbar">
          <div className="filters">
            <div className={`field${startBad ? ' invalid' : ''}`}><label htmlFor="start">Start time</label><input id="start" value={startText} autoComplete="off" onChange={(e) => setStartText(e.target.value)} onBlur={applyRange} onKeyDown={onKey} /><Ms name="calendar_today" /></div>
            <div className={`field${endBad ? ' invalid' : ''}`}><label htmlFor="end">End time</label><input id="end" value={endText} autoComplete="off" onChange={(e) => setEndText(e.target.value)} onBlur={applyRange} onKeyDown={onKey} /><Ms name="calendar_today" /></div>
            <div className="field search"><Ms name="search" className="lead" /><input type="text" placeholder="Search..." aria-label="Search" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          </div>
          <div className="actions">
            <button type="button" className="btn" disabled>Update</button>
            <button type="button" className="btn" disabled>Abort</button>
            <div className="divider" aria-hidden="true" />
            <button type="button" className="btn ghost" onClick={() => notWired('Manage')}>Manage</button>
            <button type="button" className="btn secondary" onClick={() => notWired('Close')}>Close</button>
            <button type="button" className="btn primary" onClick={() => notWired('Create')}>Create</button>
            <div className="divider" aria-hidden="true" />
            <div className="tools-slot" ref={setToolsEl} />
          </div>
        </div>

        <FlightGantt parents={parents} now={NOW} range={range} query={query} statusSlot={statusEl} toolsSlot={toolsEl} collapsible={collapsible} />
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}

export default App;
