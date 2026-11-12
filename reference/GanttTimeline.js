import anychart from 'anychart'; // npm i anychart  (needs the Gantt module: use the full bundle)
import { alertOf, barRange, ddhhmm, hasNoTimes, isEnded, ROW_H, STATUS_ORDER } from './flightRules';

/**
 * Thin wrapper around AnyChart's Gantt (the Project chart: actual time is the bar, estimated time a small strip under it).
 * The table on the left is AG Grid, so its rows must match ROW_H and order (see buildRows).
 *
 *   const tl = new GanttTimeline(el, { onBarClick, onEmptyClick, onRowHover, onVerticalWheel, onChartScroll, onViewSpan });
 *   tl.render({ rows, range: [startMs, endMs], now });   // `rows` comes from buildRows
 *   tl.select(id) · tl.zoomIn() · tl.zoomOut() · tl.scrollTo(px) · tl.revealTime(ms) · tl.getBarRect(id)
 *   tl.destroy()
 *
 * `range` is at most 48 hours. The visible window opens on the first 12 hours of the range (all of it if shorter), which is the level with a gridline and a label every hour, zooms out to the whole range and in down to 12 hours; the zoom buttons step through 12, 24, 36 and 48 hours (never past the range).
 *
 * Colours are literal values because AnyChart draws SVG and cannot read CSS variables.
 */
export const TOKENS = {
  font: "'Open Sans', Helvetica, Arial, sans-serif",
  headerBg: '#2C2C2C', headerText: '#FDFDFD',
  row: '#121212', text: '#FDFDFD', border: '#FDFDFD',   // border: white divider between table and timeline
  barFill: '#2C2C2C', barStroke: '#525252',               // default bar: rgb(82,82,82) border, #2C2C2C fill
  alert: '#F35962', now: '#00DCFF', updatedDot: '#00DCFF',
  selected: '#003D54', stripSelected: '#00799E',   // a clicked bar's fill (its border stays) and a clicked estimate strip
  strip: '#525252',   // estimated-time strip and the collapsed-parent overview bar
  dash: '#BDBDBD', chip: '#7B020A', chipText: '#FDFDFD', summary: '#A3A3A3',
  scrollTrack: '#2C2C2D', scrollThumb: '#8A8A8B',   // one unit off #2C2C2C / #8A8A8A so the stylesheet can target AnyChart's scrollbars (it draws them at 25% opacity)
  gridOdd: '#525252', gridEven: '#3D3D3D', gridHover: '#5C5C5C', gridMuted: '#A3A3A3',
};
export { ROW_H };            // row pitch (52px, in flightRules): the table rows are the same height
const ROW_PX = ROW_H - 1;      // drawn row height; the 1px row line AnyChart adds makes the pitch exactly ROW_H
export const HEADER_H = 52;   // timeline header; the table's header spacer is 53px (52 + 1px divider)
const BANDS_DY = 2;   // AnyChart's first row starts 2px below the header height
const SCROLLBAR_H = 18;   // sideways scrollbars (same as the AG Grid one)
const SCROLLBAR_V = 10;   // the timeline's vertical scrollbar is slimmer
const MIN_BAR_W = 8;   // a bar never draws narrower than this, so a short flight stays visible and clickable on a wide range
const BAR_GAP = 8, ACCENT_W = 8,   // space above and below each bar inside its row: 51 - 2 x 8 = a 35px bar
      BASELINE_H = 4, ENDED_OPACITY = 0.6, CLICK_SLOP = 6, LANE_H = 16, LANE_GAP = 3;   // two lanes: 16 + 3 + 16 = the 35px bar
// Label spacings (minutes) that fit a clock: each divides a day, so a label always sits on the same clock times, whatever the scroll position
const LABEL_STEPS = [15, 30, 60, 120, 180, 360, 720, 1440];
const HOUR = 3600000, MIN_SPAN = 12 * HOUR, MAX_SPAN = 48 * HOUR, DEFAULT_SPAN = 12 * HOUR, ZOOM_LEVELS_MS = [12, 24, 36, 48].map((h) => h * HOUR);   // the visible window: 12 to 48 hours; the buttons step through 12, 24, 36 and 48   // bars are square

const ZOOM_LEVELS = [15, 30].map((m) => [{ unit: 'minute', count: m }, { unit: 'day', count: 1 }])
  .concat([1, 3, 6].map((h) => [{ unit: 'hour', count: h }, { unit: 'day', count: 1 }]))
  .concat([
    [{ unit: 'day', count: 1 }, { unit: 'month', count: 1 }],     // weeks to a few months
    [{ unit: 'day', count: 7 }, { unit: 'month', count: 1 }],     // a quarter or more
    [{ unit: 'month', count: 1 }, { unit: 'year', count: 1 }],
  ]);

export class GanttTimeline {
  constructor(el, handlers = {}, options = {}) {
    this.el = el;
    this.h = handlers;
    this.options = options;   // { verticalScrollbar: false } hides the timeline's vertical scrollbar
    this.chart = null;
    this.tree = null;
    this.selectedId = null;
    this.view = null;
    this.rangeKey = '';
    this._rows = [];   // the rows being drawn
    this.scrollY = 0;
    this._appliedY = 0;
    this.hoverFlight = null;
    this._hoverRow = -1;   // row index under the pointer (either side); only flight rows count
    this.state = { rows: [], range: [0, 1], now: 0 };
    anychart.format.outputTimezone(0); // show UTC everywhere

    this._wheel = this._wheel.bind(this);
    this._down = this._down.bind(this);
    this._up = this._up.bind(this);
    el.addEventListener('wheel', this._wheel, { capture: true, passive: false });
    el.addEventListener('pointerdown', this._down, true);
    el.addEventListener('pointerup', this._up, true);
    this._leave = () => { this._setHover(-1); this.hoverFlight = null; this.el.style.cursor = ''; };
    el.addEventListener('pointerleave', this._leave);
    this._initHover();
    this._initLabels();
    this._initHeader();
    this._initNow();
  }

  /** (Re)draws the chart. The user's zoom and pan survive redraws until `range` changes. */
  render(patch) {
    this.state = { ...this.state, ...patch };
    const key = this.state.range.join();
    if (key !== this.rangeKey) { this.view = null; this.rangeKey = key; }
    else if (this.chart) this.view = this._readView();
    this._rows = this.state.rows;
    this._build();
    const v = this.view || this._defaultView();
    this._setView(v[0], v[1]);
    this._nowKey = '';
  }

  select(id) {
    this.selectedId = id;
    if (!this.tree) return;
    const visit = (it) => {
      if (it.get('raw')) {
        const on = it.get('id') === id;
        if (!!it.get('selected') !== on) it.set('selected', on);
      }
      for (let i = 0; i < it.numChildren(); i += 1) visit(it.getChildAt(i));
    };
    this.tree.getChildren().forEach(visit);   // the flag recolours the bar (its fill) or the strip
  }

  /**
   * Vertical scroll in pixels. Calls are coalesced to one redraw per frame, because AnyChart redraws SVG on every
   * step (AG Grid scrolls real DOM and can fire several scroll events per frame). Pass `immediate` after a rebuild.
   */
  scrollTo(px, immediate = false) {
    if (!this.chart) return;
    if (immediate) { this._pendingY = null; this._applyScroll(px); return; }
    this._pendingY = px;
    if (this._scrollRaf) return;
    this._scrollRaf = requestAnimationFrame(() => {
      this._scrollRaf = 0;
      const y = this._pendingY;
      this._pendingY = null;
      if (this.chart && y != null && Math.abs(y - this._appliedY) > 0.5) this._applyScroll(y);   // already there: skip the redraw
    });
  }

  _applyScroll(px) {
    this.chart.scrollTo(px);
    this._appliedY = this.chart.scrollTo();   // AnyChart clamps; remember where it really is
  }

  /** The timeline has its own vertical scrollbar. When that (not our code) moves it, tell the owner so the table follows. */
  _syncScroll() {
    if (!this.chart || this._scrollRaf || this._pendingY != null) return;
    const y = this.chart.scrollTo();
    if (Math.abs(y - this._appliedY) > 0.5) {
      this._appliedY = y;
      if (this.h.onChartScroll) this.h.onChartScroll(y);
    }
  }

  // Zoom buttons anchor on "now" when it is in view (on a long range the middle is usually empty), else on the centre
  /** The levels the buttons step through for this range: 12, 24, 36 and 48 hours, cut at the range, plus the whole range when it is not one of them (a 30 h range: 12, 24, 30). */
  _levels() {
    const len = Math.min(MAX_SPAN, this.state.range[1] - this.state.range[0]);
    return [...new Set([...ZOOM_LEVELS_MS.filter((l) => l < len), len])].sort((x, y) => x - y);
  }
  zoomIn() {
    const [a, b] = this._readView(), span = b - a, next = this._levels().filter((l) => l < span - 1000).pop();   // one level in; a wheel zoom in between snaps to a level
    if (next) this._zoomAround(next / span, this._nowRatio());
  }
  zoomOut() {
    const [a, b] = this._readView(), span = b - a, next = this._levels().find((l) => l > span + 1000);
    if (next) this._zoomAround(next / span, this._nowRatio());
  }

  /** The first window: 12 hours from the start of the range (a range is at most 48 hours). */
  _defaultView() { const [a, z] = this.state.range; return [a, Math.min(z, a + DEFAULT_SPAN)]; }   // the first 12 hours of the range, or all of it if shorter

  /** Smallest and largest window the current range allows. */
  _spanLimits() {
    const len = this.state.range[1] - this.state.range[0];
    return [Math.min(MIN_SPAN, len), Math.min(MAX_SPAN, len)];
  }

  _nowRatio() {
    const [a, b] = this._readView(), { now } = this.state;
    return now >= a && now <= b ? (now - a) / (b - a) : 0.5;
  }

  /**
   * Screen rectangle (client coordinates) of a row's bar, clipped to the visible timeline, or null when it is out of view.
   * `id` is a sortie. The tooltip anchors to this so it appears at the bar whether the bar or its table row was clicked.
   */
  /** Where a sortie's bar is on screen (its visible part sideways; above or below the chart when its row is scrolled out of view), or null. */
  getBarRect(id) {
    if (!this.chart || !this._idxById) return null;
    const i = this._idxById.get(id), r = i == null ? null : this._rows[i], c = r && (r.type === 'parent' ? r.agg : r.c);
    if (!c || hasNoTimes(c)) return null;   // no bar, nothing to anchor to
    const host = this.el.getBoundingClientRect(), left = this._tableW(), width = (this.el.clientWidth || 1) - left;
    const [a, b] = this._readView(), [bs, be] = barRange(c, this.state.now);
    const x = (t) => host.left + left + ((t - a) / (b - a)) * width;
    const L = Math.max(x(bs), host.left + left), R = Math.min(Math.max(x(be), x(bs) + MIN_BAR_W), host.left + left + width);
    const top = host.top + HEADER_H + BANDS_DY + i * ROW_H - this.chart.scrollTo() + BAR_GAP;
    if (R < L) return null;   // out of the visible time window. Out of view vertically is fine: the tooltip follows its bar and is clipped to the chart (FlightTip)
    return { left: L, right: Math.max(R, L + MIN_BAR_W), top, bottom: top + ROW_PX - BAR_GAP * 2 };
  }

  /** Pans horizontally so `ms` is comfortably in view. */
  revealTime(ms) {
    const [a, b] = this._readView(), span = b - a;
    if (ms < a || ms > b - span * 0.1) this._setView(ms - span * 0.15, ms + span * 0.85);
  }

  destroy() {
    this.el.removeEventListener('wheel', this._wheel, { capture: true });
    this.el.removeEventListener('pointerdown', this._down, true);
    this.el.removeEventListener('pointerup', this._up, true);
    this.el.removeEventListener('pointerleave', this._leave);
    cancelAnimationFrame(this._nowRaf);
    cancelAnimationFrame(this._scrollRaf);
    cancelAnimationFrame(this._wheelRaf);
    if (this.nowLayer) this.nowLayer.remove();
    if (this.rowHover) this.rowHover.remove();
    if (this.labels) this.labels.remove();
    if (this.hdr) this.hdr.remove();
    if (this.chart) this.chart.dispose();
    this.chart = null;
  }

  // ---------------------------------------------------------------- "Now" marker
  // Drawn as an overlay rather than an AnyChart line marker: it sits above every bar, the "Now" chip can sit on top of
  // the timeline, and the line can cross the hours row (AnyChart's own marker stays inside the body, under the bars).
  _initNow() {
    const layer = document.createElement('div');
    layer.className = 'fg-now-layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.innerHTML = '<div class="fg-now-line"><span class="fg-now-chip">Now</span></div>';
    this.el.parentElement.appendChild(layer);
    this.nowLayer = layer;
    this.nowLine = layer.firstChild;
    const loop = () => { this._syncNow(); this._syncScroll(); this._syncHover(); this._syncLabels(); this._syncHeader(); this._nowRaf = requestAnimationFrame(loop); };
    loop();
  }

  _syncNow() {
    if (!this.chart) { this.nowLine.style.display = 'none'; return; }
    const left = this._tableW(), width = (this.el.clientWidth || 1) - left;
    const r = this.chart.getTimeline().scale().getRange();
    const limits = this._spanLimits(), spanKey = `${r.max - r.min}|${limits[0]}|${limits[1]}`;
    if (spanKey !== this._spanKey) {   // tell the owner when the window length or its limits change (zoom buttons enable/disable)
      this._spanKey = spanKey;
      this._span = r.max - r.min;
      if (this.h.onViewSpan) this.h.onViewSpan(this._span, limits);
    }
    const key = `${r.min}|${r.max}|${left}|${width}|${this.state.now}`;
    if (key === this._nowKey) return;
    this._nowKey = key;
    const x = ((this.state.now - r.min) / (r.max - r.min)) * width;
    this.nowLayer.style.left = `${left}px`;
    this.nowLine.style.display = x < 0 || x > width ? 'none' : 'block';
    this.nowLine.style.left = `${Math.min(Math.max(x, 1), width - 1)}px`;   // at an edge it is drawn just inside, so it keeps its 2px
    this.nowLine.classList.toggle('is-edge', x < 30);                // at an edge the chip opens inwards, so it is not cut off
    this.nowLine.classList.toggle('is-edge-r', x > width - 30);
    this.nowLine.classList.toggle('is-flush', x < 2 || x > width - 2);   // exactly at an edge (a range that starts at "now"): just the chip, no vertical line
  }

  /** Milliseconds one pixel of the timeline stands for at the current zoom. */
  _msPerPx() {
    const [a, b] = this._readView();
    return (b - a) / Math.max(1, (this.el.clientWidth || 1) - this._tableW());
  }

  /** The table is AG Grid, outside this element, so the timeline starts at x = 0. */
  _tableW() { return 0; }

  // ---------------------------------------------------------------- row hover shared with the table
  // Hovering a sortie row in the table highlights its timeline row and the other way round. AnyChart cannot be told to
  // hover a row, so the timeline side is a translucent overlay positioned from the scroll offset.
  _initHover() {
    this.rowHover = document.createElement('div');
    this.rowHover.className = 'fg-rowhover';
    this.rowHover.setAttribute('aria-hidden', 'true');
    this.el.parentElement.appendChild(this.rowHover);
  }

  /** The owner calls this when the pointer is over a table row (index into `rows`, or -1). */
  setHoverRow(i) { this._hoverRow = i; }

  _setHover(i) {   // the pointer is over a timeline row
    if (i === this._hoverRow) return;
    this._hoverRow = i;
    if (this.h.onRowHover) this.h.onRowHover(i >= 0 && this._rows[i] && this._rows[i].c ? this._rows[i].c.id : null);
  }

  _syncHover() {
    const i = this._hoverRow, el = this.rowHover;
    const row = this.chart ? this._rows[i] : null;
    if (!row || row.type !== 'child') { if (el.style.display !== 'none') { el.style.display = 'none'; this._hoverKey = ''; } return; }
    const top = HEADER_H + BANDS_DY + i * ROW_H - this.chart.scrollTo();
    const key = `${top}|${this.el.clientHeight}`;
    if (key === this._hoverKey && el.style.display === 'block') return;
    this._hoverKey = key;
    el.style.display = top + ROW_H > HEADER_H && top < this.el.clientHeight ? 'block' : 'none';
    el.style.top = `${top}px`;
  }

  // ---------------------------------------------------------------- view helpers
  _readView() { const r = this.chart.getTimeline().scale().getRange(); return [r.min, r.max]; }

  _setView(a, b) {
    const [min, max] = this.state.range, [lo, hi] = this._spanLimits();
    const span = Math.min(Math.max(b - a, lo), hi);
    const start = Math.min(Math.max(a, min), max - span);
    this.chart.zoomTo(start, start + span);
    this._styleSplitter();
  }

  _zoomAround(factor, ratio) {
    const [a, b] = this._readView(), span = b - a, anchor = a + span * ratio, next = span * factor;
    this._setView(anchor - next * ratio, anchor + next * (1 - ratio));
  }

  /** Wheel: ctrl or pinch zooms, shift or sideways pans, plain vertical scrolls the table. */
  _wheel(e) {
    if (!this.chart) return;
    const zoom = e.ctrlKey || e.metaKey, sideways = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
    e.preventDefault();
    e.stopPropagation();

    if (!zoom && !sideways) {
      // Vertical scrolling is the hot path (a trackpad fires many tiny events per frame): no layout reads here, the
      // deltas are added up and applied once per frame, and the timeline moves in the same frame as the table.
      this._wy = (this._wy || 0) + e.deltaY;
      if (!this._wheelRaf) {
        this._wheelRaf = requestAnimationFrame(() => {
          this._wheelRaf = 0;
          const dy = this._wy;
          this._wy = 0;
          if (!this.chart || !this.h.onVerticalWheel) return;
          const y = this.h.onVerticalWheel(dy);          // the owner scrolls the table and returns where it ended up
          if (typeof y === 'number') this.scrollTo(y, true);
        });
      }
      return;
    }

    const rect = this.el.getBoundingClientRect(), width = this.el.clientWidth || 1;
    if (zoom) {
      this._zoomAround(e.deltaY < 0 ? 1 / 1.25 : 1.25, Math.min(Math.max((e.clientX - rect.left) / width, 0), 1));
    } else {
      const [a, b] = this._readView(), shift = (((e.deltaX || e.deltaY)) / width) * (b - a);
      this._setView(a + shift, b + shift);
    }
  }

  // A click that drifts a few pixels is read by AnyChart as a drag-to-pan and produces no click event,
  // so bar clicks are detected here with a small tolerance instead.
  _down(e) { this._press = { x: e.clientX, y: e.clientY, flight: this.hoverFlight }; }

  _up(e) {
    const p = this._press;
    this._press = null;
    if (!p || !p.flight) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP) return;
    if (this.h.onBarClick) this.h.onBarClick(p.flight, e);
  }

  /** AnyChart draws a splitter with a fixed light fill and no API, even without its own table: make it invisible. */
  _styleSplitter() {
    const fill = 'transparent';
    this.el.querySelectorAll('[fill="#cecece"],[fill="#CECECE"]').forEach((n) => n.setAttribute('fill', fill));
  }

  // ---------------------------------------------------------------- time labels of the scale (a layer over the header)
  // AnyChart pins the left-most time label to the left edge until the next one pushes it out, so while scrolling it stops sitting at
  // its grid line, nearly overlaps the next label and then vanishes (0200 appears when zooming in, and is gone after a short scroll).
  // The time labels are therefore drawn here: each one at its own grid line, sliding out under the left edge with the line.
  // AnyChart still draws its own labels, invisible; they tell us which interval it chose for the zoom level, so ours always match the grid.
  _initHeader() {
    this.hdr = document.createElement('div');
    this.hdr.className = 'fg-hdr';
    this.hdr.setAttribute('aria-hidden', 'true');
    this.hdr.style.height = `${HEADER_H}px`;
    this.hdr.style.fontFamily = TOKENS.font;
    this.el.parentElement.appendChild(this.hdr);
  }

  /** The interval (minutes) between AnyChart's time labels, and where their row sits, read from its invisible labels. */
  _readLabelInterval() {
    const texts = [...this.el.querySelectorAll('text')].map((n) => {
      const m = /^(\d{2})(\d{2})H$/.exec(n.textContent.trim());
      return m ? { min: Number(m[1]) * 60 + Number(m[2]), rect: n.getBoundingClientRect() } : null;
    }).filter(Boolean).sort((a, b) => a.rect.left - b.rect.left);
    if (texts.length < 2) return null;
    let iv = Infinity;
    for (let i = 1; i < texts.length; i += 1) { let d = texts[i].min - texts[i - 1].min; if (d <= 0) d += 1440; if (d < iv) iv = d; }
    const host = this.hdr.getBoundingClientRect();
    this.hdr.style.setProperty('--hl-top', `${texts[0].rect.top - host.top}px`);
    this.hdr.style.setProperty('--hl-h', `${texts[0].rect.height}px`);
    return iv >= 5 && iv <= 1440 ? iv : null;
  }

  _syncHeader() {
    const el = this.hdr;
    if (!this.chart) { if (this._hdrKey) { el.innerHTML = ''; this._hdrKey = ''; } return; }
    const r = this.chart.getTimeline().scale().getRange(), width = this.el.clientWidth || 1, span = r.max - r.min;
    if (span !== this._hdrSpan) { this._hdrSpan = span; this._hdrTries = 8; }   // the zoom level changed: read AnyChart's interval again
    if (this._hdrTries > 0) { this._hdrTries -= 1; const iv = this._readLabelInterval(); if (iv) this._hdrIv = iv; }
    const iv = this._hdrIv;
    if (!iv) return;
    const key = `${r.min}|${r.max}|${width}|${iv}|${this._hlW}`;
    if (key === this._hdrKey) return;
    this._hdrKey = key;
    // When the grid lines are too close for their labels (the 20-hour level on a laptop: 20 hourly lines), only some lines carry one: every 2nd,
    // 3rd... line, on fixed clock times (00, 02, 04 or 00, 03, 06), so the same lines are labelled however far the view is scrolled.
    const px = (width * iv * 60000) / span, need = (this._hlW || 40) + 16;
    const step = LABEL_STEPS.find((m) => m >= iv && m % iv === 0 && (m / iv) * px >= need) || 1440;
    const ms = step * 60000;
    let html = '';
    for (let tk = Math.floor(r.min / ms) * ms; tk <= r.max; tk += ms) {
      const x = ((tk - r.min) / span) * width;
      if (x < -60) continue;                                   // gone: the label has slid out under the edge
      const d = new Date(tk);
      html += `<span class="fg-hl" style="left:${x + 5}px">${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}H</span>`;
    }
    el.innerHTML = html;
    const first = el.firstChild, w = first ? first.getBoundingClientRect().width : 0;
    if (w && Math.abs(w - (this._hlW || 0)) > 0.5) { this._hlW = w; this._hdrKey = ''; }   // measured, so the real font (and its width) decides the spacing
  }

  // ---------------------------------------------------------------- bar labels and chips (a layer above the chart)
  // AnyChart anchors a label to the start of its bar, so a bar that starts before the visible window loses its callsign. The
  // labels and red chips are therefore drawn here, as a thin layer positioned on every frame: the text sits at the bar's start
  // and, when that start is off-screen to the left, sticks to the left edge until the bar's end pushes it out.
  _initLabels() {
    this.labels = document.createElement('div');
    this.labels.className = 'fg-labels';
    this.labels.setAttribute('aria-hidden', 'true');
    this.labels.style.top = `${HEADER_H}px`;
    this.labels.style.fontFamily = TOKENS.font;
    this.el.parentElement.appendChild(this.labels);
  }

  _syncLabels() {
    const el = this.labels;
    if (!this.chart || !this._labels) { if (this._labKey) { el.innerHTML = ''; this._labKey = ''; } return; }
    const y = this.chart.scrollTo(), [a, z] = this._readView(), w = this.el.clientWidth, h = this.el.clientHeight;
    const key = `${y}|${a}|${z}|${w}|${h}|${this._ver}`;
    if (key === this._labKey) return;
    this._labKey = key;
    const x = (t) => ((t - a) / (z - a)) * w, barH = ROW_PX - BAR_GAP * 2, CHIP_H = 18;
    const first = Math.max(0, Math.floor(y / ROW_H) - 1), last = Math.min(this._labels.length - 1, Math.ceil((y + h) / ROW_H));
    let html = '', lid = 0;
    // A callsign with no schedule: its rows are shaded like a closed bar, down to its last sortie when it is open; the text stays on its own row
    (this._bands || []).forEach(({ i, n }) => {
      const top = BANDS_DY + i * ROW_H - y, bandH = n * ROW_H - 1;
      if (top + bandH > 0 && top < h) html += `<div class="fg-ns" style="top:${top}px;height:${bandH}px"><span>Not scheduled</span></div>`;
    });
    for (let i = first; i <= last; i += 1) {
      const list = this._labels[i];
      if (!list) continue;
      const barTop = BANDS_DY + i * ROW_H - y + BAR_GAP;
      if (barTop + barH <= 0 || barTop >= h) continue;                 // the row is scrolled out of view
      const chipKeys = new Set();                                      // one chip per block, on its first piece that is on screen
      const starts = list.filter((L) => L.html).map((L) => ({ x: x(L.bs), lane: L.lane || 0 })).sort((p, q) => p.x - q.x);   // a label stops where the next block of its lane starts
      list.forEach((L) => {
        const xs = x(L.bs), xe = Math.max(x(L.be), xs + MIN_BAR_W);
        if (xe < 0 || xs > w) return;                                  // the bar is not on screen
        const sticky = xs < 0, left = Math.max(xs, 0), attrs = `data-sticky="${sticky ? 1 : 0}" data-end="${xe}"`;
        const next = starts.find((v) => v.lane === (L.lane || 0) && v.x > xs + 1), nextStart = next && next.x, thin = (L.lanes || 1) > 1;
        const mid = barTop + (thin ? (L.lane || 0) * (LANE_H + LANE_GAP) + LANE_H / 2 : barH / 2), room = nextStart == null ? '' : `max-width:${Math.max(nextStart - (left + 16) - 6, 24)}px;`;
        const myId = L.html ? (lid += 1) : 0;
        if (L.html) html += `<div class="fg-lab${thin ? ' fg-lab--lane' : ''}" data-lid="${myId}" ${attrs} data-left="${left + 16}" style="left:${left + 16}px;top:${mid}px;${room}">${L.html}</div>`;
        if (L.chip && barTop >= 0 && !chipKeys.has(L.key) && chipKeys.add(L.key)) html += `<div class="fg-lab-chip" data-of="${myId}" ${attrs} data-row="${i}" data-left="${left + 16}" style="left:${left + 16}px;top:${Math.max(barTop, CHIP_H / 2)}px">${L.chip}</div>`;   // above the label (on the top edge of the bar area), same left edge
      });
    }
    el.innerHTML = html;
    el.querySelectorAll('[data-sticky="1"]').forEach((n) => {          // a pinned label slides away with the end of its bar
      const maxLeft = Number(n.dataset.end) - n.offsetWidth - 8;
      n.style.left = `${Math.min(Number(n.dataset.left), maxLeft)}px`;
    });
    el.querySelectorAll('.fg-lab-chip[data-of]').forEach((n) => {     // a chip stays on its label's left edge, also while the label slides away with the end of its bar
      const lab = el.querySelector(`.fg-lab[data-lid="${n.dataset.of}"]`);
      if (lab) n.style.left = lab.style.left;
    });
    const rowsOfChips = {};                                           // chips of one row never overlap: the later one moves to the right of the earlier one
    el.querySelectorAll('.fg-lab-chip').forEach((n) => { (rowsOfChips[n.dataset.row] = rowsOfChips[n.dataset.row] || []).push(n); });
    Object.values(rowsOfChips).forEach((chips) => {
      let right = -Infinity;
      chips.sort((p, q) => parseFloat(p.style.left) - parseFloat(q.style.left)).forEach((n) => {
        const l = Math.max(parseFloat(n.style.left), right + 6);
        n.style.left = `${l}px`;
        right = l + n.offsetWidth;
      });
    });
  }

  // ---------------------------------------------------------------- data transforms
  /** Key a row has in the timeline and in the selection: sortie id, a collapsed mission's merged id, else positional. */
  _keyOf(r, i) {
    if (r.type === 'child') return r.c.id;
    if (r.type === 'parent' && r.collapsed && r.agg) return r.agg.id;
    return `${r.type}-${i}`;
  }

  /**
   * One bar. A collapsed mission (`c.group`, see aggregate) is drawn the same way: one continuous bar and the planned window of
   * the whole mission as the strip. Its label names the sortie that is flying (`+N` for more). Its bar stays neutral: the red
   * outline always means "this bar's own sortie", so a hidden sortie's anomaly is flagged by a red chip naming it instead.
   */
  _projectItem(c) {
    const { now } = this.state, [bs, be] = barRange(c, now), dot = !!(c.changed && c.changed.length);
    const name = c.group ? c.label : c.id;
    // A chip names its sortie only when the bar is a group of several: a bar that is one sortie just says what is wrong.
    const chipOf = (bad, bl) => {
      if (!bad.length) return '';
      if (bad.length > 1) return `${bad.length} anomalies`;
      return bl && bl.members.length === 1 && bl.members[0] === bad[0] ? alertOf(bad[0], now) : `${bad[0].id} \u00B7 ${alertOf(bad[0], now)}`;
    };
    let warn = null, chip = null;   // warn: red outline and edge on this bar; chip: red label on its top border
    if (c.group) {
      chip = null;   // a collapsed mission shows its anomalies inside its text (see _stats)
    } else {
      warn = alertOf(c, now);
      chip = warn;
    }
    const op = !c.group && isEnded(c) ? ENDED_OPACITY : 1;
    // The texts drawn on the bars (see _syncLabels): a sortie has one, a collapsed mission has one on each separate block.
    let labs;
    if (c.group) {
      // One text for the whole mission: how many sorties are in each status. It sits on the actual bar, or above the estimate strip when nothing has departed.
      const at = c.actual || c.estimate, flags = {};   // flags: per status, how many sorties are past their ETD or ETA
      c.sorties.forEach((s) => { const a = alertOf(s, now); if (a) { flags[s.code] = flags[s.code] || {}; flags[s.code][a] = (flags[s.code][a] || 0) + 1; } });
      labs = at ? [{ bs: at[0], be: at[1], key: 0, lane: 0, lanes: 1, html: GanttTimeline._stats(c.counts, flags), chip: '' }] : [];   // the text starts at the left of the bar, like any bar label
    } else {
      // A sortie's chip sits above its label, at the label's left edge (_syncLabels)
      labs = [{ bs, be, key: 0, lane: 0, lanes: 1, html: GanttTimeline._label(name, c.code, op, dot, c.plus), chip: chip || '' }];
    }
    return {
      id: c.id, name, raw: c, bs, be, text: name, cs: name, st: c.code, plus: c.plus, dot, op,
      warn, chip, changed: dot, selected: c.id === this.selectedId,
      actualStart: bs, actualEnd: be, labs,
    };
  }

  /** Timeline item for one row. */
  _dataItem(r, i) {
    if (r.type === 'child') return hasNoTimes(r.c) ? { id: r.c.id, name: r.c.id } : this._projectItem(r.c);   // a sortie with no times: a blank row (see _syncLabels for the shading)
    const item = { id: this._keyOf(r, i), name: '' };   // mission, column and spacer rows are blank in the timeline...
    if (r.type === 'parent' && r.collapsed && r.agg) Object.assign(item, this._projectItem(r.agg), { id: r.agg.id, name: r.p.name });   // ...except a collapsed mission: its one bar
    return item;
  }

  // ---------------------------------------------------------------- drawing
  static _rect(path, x, y, w, h) {
    path.moveTo(x, y).lineTo(x + w, y).lineTo(x + w, y + h).lineTo(x, y + h).close();
  }

  /**
   * The text of a collapsed mission: the sorties in each status, e.g. `5 IS [3 Past ETD] • 4 FP [2 Past ETA]`. The totals stay (they match the
   * header counts) and a red chip says how many of them are past their ETD or ETA. The text starts at the left of the bar, like a bar label, and is never cut.
   */
  static _stats(counts, flags = {}) {
    const divider = ` <span style="color:${TOKENS.summary}">\u2022</span> `;
    return STATUS_ORDER.filter((s) => counts[s]).map((s) => {
      const pills = Object.entries(flags[s] || {}).map(([reason, n]) => `<span class="fg-stat-pill">${n} ${reason}</span>`).join('');
      return `<span style="color:rgba(253,253,253,1)">${counts[s]} ${s}</span>${pills}`;
    }).join(divider);
  }

  /** Bar text: `Callsign • Status`, a small dot divider, `+N` when more sorties are flying, and a cyan dot when a value was updated. */
  static _label(callsign, status, op, updated, plus) {
    const T = TOKENS;
    const divider = `<span style="color:rgba(163,163,163,${op})">\u2022</span>`;
    const more = plus ? ` <span style="color:rgba(253,253,253,${op})">+${plus}</span>` : '';
    const dot = updated ? ` <span style="color:${T.updatedDot}">\u25CF</span>` : '';
    return `<span style="color:rgba(253,253,253,${op})">${callsign}</span> ${divider} <span style="color:rgba(253,253,253,${op})">${status}</span>${more}${dot}`;
  }

  /** One look for every scrollbar: #2C2C2C track and a light rounded thumb inset from the edge (matches the AG Grid bar). */
  static _styleScrollbar(sb, size = SCROLLBAR_H, inset = 8) {   // the thumb ends up (size - inset) thick: 18 - 8 = 10px, like the AG Grid thumb
    const T = TOKENS;
    sb.enabled(true); sb.backgroundFill(T.scrollTrack); sb.backgroundStroke('none');
    sb.sliderFill(T.scrollThumb); sb.sliderStroke({ color: T.scrollTrack, thickness: inset });
    sb.barSize(size); sb.cornersRadius(size / 2); sb.buttonsVisible(false);
  }

  /**
   * Draws one bar: square, #525252 border and #2C2C2C fill. A bar that needs attention keeps the same fill with a red border
   * and an 8px red left edge. Where the visible window cuts the bar, that side has no border (and no red edge): it continues.
   */
  _drawBar(sh, b, o) {
    const T = TOKENS, lo = 0, hi = this.el.clientWidth, faded = o.op < 1;
    const P = faded ? sh.pathF : sh.path, E = faded ? sh.edgeF : sh.edge;   // faded bars (closed, aborted) have their own shapes: a shape has one opacity
    const right = b.left + Math.max(b.width, MIN_BAR_W);
    const cutL = !!o.noLeft || b.left < lo - 0.5, cutR = right > hi + 0.5;
    const x0 = Math.max(b.left, lo), x1 = Math.min(right, hi);
    if (x1 <= x0) return;
    GanttTimeline._rect(P, x0, b.top, x1 - x0, b.height);
    P.fill({ color: o.selected ? T.selected : T.barFill, opacity: o.selected ? 1 : o.op }).stroke('none');   // selected: the fill changes, the border (red when it needs attention) stays
    const top = b.top + 0.5, bot = b.top + b.height - 0.5, l = x0 + 0.5, r = x1 - 0.5;
    E.moveTo(x0, top).lineTo(x1, top).moveTo(x0, bot).lineTo(x1, bot);
    if (!cutL) E.moveTo(l, top).lineTo(l, bot);
    if (!cutR) E.moveTo(r, top).lineTo(r, bot);
    E.fill('none').stroke({ color: o.alert ? T.alert : T.barStroke, thickness: 1, opacity: o.alert ? 1 : o.op });
    if (o.alert && !cutL) {
      GanttTimeline._rect(sh.accent, x0, b.top, ACCENT_W, b.height);
      sh.accent.fill(T.alert).stroke('none');
    }
  }

  /** Estimated time (ETD to ETA) as a small filled strip along the bottom of the row, above the bar. */
  _drawStrip(sh, b, o, c) {
    if (o.start === c.etd && o.end === c.eta) return;   // the bar already is the estimate: a strip would just repeat it
    const T = TOKENS, span = (o.end - o.start) || 1;
    const x = (t) => b.left + ((t - o.start) * b.width) / span;   // the bar's own time-to-pixel mapping
    const lo = 0, hi = this.el.clientWidth, a0 = Math.max(x(c.etd), lo), a1 = Math.min(Math.max(x(c.eta), x(c.etd) + MIN_BAR_W), hi);
    if (a1 <= a0) return;
    const S = o.selected ? sh.stripS : o.op < 1 ? sh.stripF : sh.strip;   // a selected sortie: its estimate strip turns stripSelected too (the drawer sets that fill)
    GanttTimeline._rect(S, a0, b.top + b.height - BASELINE_H, a1 - a0, BASELINE_H);
    if (!o.selected) S.fill({ color: T.strip, opacity: o.op }).stroke('none');
  }

  /** A strip of [xs, xe] along the bottom of a row (`bottom` is the bottom of the bar area), in the shape `shape`: strip, stripA (red) or stripS (selected). */
  _planStrip(sh, xs, xe, bottom, shape) {
    const a0 = Math.max(xs, 0), a1 = Math.min(Math.max(xe, xs + MIN_BAR_W), this.el.clientWidth);
    if (a1 > a0) GanttTimeline._rect(sh[shape], a0, bottom - BASELINE_H, a1 - a0, BASELINE_H);
  }

  /** An issued (IS) or aborted (IA) sortie has no bar, only its estimate (ETD to ETA) as the strip: red when it needs attention, faded when aborted. When selected it turns stripSelected. */
  _drawPlan(sh, b, o, c) {
    const span = (o.end - o.start) || 1, x = (t) => b.left + ((t - o.start) * b.width) / span;   // the item's own time-to-pixel mapping
    this._planStrip(sh, x(c.etd), x(c.eta), b.top + b.height, o.selected ? 'stripS' : o.alert ? 'stripA' : c.code === 'IA' ? 'stripF' : 'strip');
  }

  /**
   * A collapsed mission (see aggregate): the actual bar (earliest ATD to latest ATA) with the estimate (earliest ETD to latest ETA)
   * as the strip along its bottom. Nothing departed yet: just the strip.
   */
  _drawCollapsed(sh, b, o, c) {
    const span = (o.end - o.start) || 1, x = (t) => b.left + ((t - o.start) * b.width) / span;   // the row's time-to-pixel mapping
    if (c.actual) this._drawBar(sh, { left: x(c.actual[0]), width: Math.max(x(c.actual[1]) - x(c.actual[0]), MIN_BAR_W), top: b.top, height: b.height }, { ...o, alert: false, op: 1 });
    const same = c.actual && c.estimate && c.actual[0] === c.estimate[0] && c.actual[1] === c.estimate[1];   // the bar already is the estimate
    if (c.estimate && !same) this._planStrip(sh, x(c.estimate[0]), x(c.estimate[1]), b.top + b.height, 'strip');
    sh.strip.fill({ color: TOKENS.strip, opacity: 1 }).stroke('none');
  }

  // ---------------------------------------------------------------- build
  _build() {
    const T = TOKENS, self = this, { range } = this.state, rows = this._rows;
    if (this.chart) { this.chart.dispose(); this.chart = null; this.el.innerHTML = ''; }
    this.hoverFlight = null;

    this._ver = (this._ver || 0) + 1;
    this._hdrSpan = 0; this._hdrKey = '';
    this._idxById = new Map(rows.map((r, i) => [this._keyOf(r, i), i]));   // timeline item id -> row index

    const items = rows.map((r, i) => this._dataItem(r, i));
    this._labels = items.map((it) => it.labs || null);   // the texts drawn on each row's bars
    this._bands = rows.map((r, i) => (r.unscheduled ? { i, n: r.rowSpan || 1 } : null)).filter(Boolean);   // callsigns with no schedule: the rows to shade
    const chart = anychart.ganttProject();
    this.tree = anychart.data.tree(items, 'as-table');
    chart.data(this.tree);
    chart.background().fill(T.row);
    chart.defaultRowHeight(ROW_PX);
    chart.headerHeight(HEADER_H);
    chart.dataGrid(false);   // the table is AG Grid

    const tl = chart.getTimeline();
    tl.backgroundFill(T.row); tl.rowEvenFill(T.row); tl.rowOddFill(T.row);
    tl.rowHoverFill(T.row); tl.rowSelectedFill(T.row);   // row hover is the overlay in _syncHover
    tl.rowStroke('rgba(255,255,255,0.12)'); tl.columnStroke('rgba(255,255,255,0.08)');   // row lines line each bar up with its table row
    tl.tooltip().enabled(false);                          // the page renders its own tooltip
    GanttTimeline._styleScrollbar(tl.horizontalScrollBar());
    if (this.options.verticalScrollbar === false) tl.verticalScrollBar().enabled(false);
    else GanttTimeline._styleScrollbar(tl.verticalScrollBar(), SCROLLBAR_V, 2);   // also moves the table
    tl.header().fill(T.headerBg).stroke('none');
    tl.scale().minimum(range[0]); tl.scale().maximum(range[1]);
    tl.scale().zoomLevels(ZOOM_LEVELS);
    tl.header().level(0).labels().fontFamily(T.font).fontColor('rgba(0, 0, 0, 0)').fontSize(13)   // invisible: the time labels are drawn by _syncHeader
      .format(function () {
        const f = (p) => anychart.format.dateTime(this.tickValue, p);
        if (this.unit === 'month') return f('MMM');
        if (this.unit === 'day') return this.count > 1 ? f('dd MMM') : f('dd');
        return `${f('HHmm')}H`;   // 0400H
      });
    tl.header().level(1).labels().fontFamily(T.font).fontColor(T.headerText).fontSize(13)
      .format(function () {
        const f = (p) => anychart.format.dateTime(this.tickValue, p);
        if (this.unit === 'year') return f('yyyy');
        if (this.unit === 'month') return f('MMM yy');
        return f('dd MMM yy');
      });

    const Z = { pathF: 1, edgeF: 2, stripF: 3, path: 4, edge: 5, accent: 6, strip: 10, stripA: 11, stripS: 12 };   // drawing order inside a row: faded bars, solid bars, strips
    // No fillName/strokeName: those would let AnyChart restyle the shapes with its own hover and selected colours (orange by default). We set every fill ourselves.
    const SHAPES = Object.keys(Z).map((n) => ({ name: n, shapeType: 'path', zIndex: Z[n] }));
    const barH = ROW_PX - BAR_GAP * 2;   // 35px: the bar has breathing room above and below

    const tasks = tl.tasks();
    tasks.height(barH).position('left-top').anchor('left-top').offset(BAR_GAP).fill(T.barFill).stroke(T.barStroke);
    tasks.progress().enabled(false);
    tasks.labels().enabled(false);   // labels and chips are the overlay layer (_syncLabels)
    tasks.rendering().shapes(SHAPES).drawer(function () {
      const it = this.item;
      const o = { start: it.get('actualStart'), end: it.get('actualEnd'), alert: !!it.get('warn'), op: it.get('op'), changed: it.get('changed'), selected: it.get('selected') };
      const raw = it.get('raw');
      if (!raw) return;
      const sh = this.shapes;
      if (raw.group) self._drawCollapsed(sh, this.predictedBounds, o, raw);   // a collapsed mission: its actual bar and estimate strip
      else if (raw.code === 'IS' || raw.code === 'IA') self._drawPlan(sh, this.predictedBounds, o, raw);   // issued or aborted: no bar, only the estimate as a strip (faded when aborted)
      else { self._drawBar(sh, this.predictedBounds, o); self._drawStrip(sh, this.predictedBounds, o, raw); }
      sh.strip.fill({ color: T.strip, opacity: 1 }).stroke('none');   // grey strip: an estimate (always set here, so no state colour of the chart library can show through)
      sh.stripF.fill({ color: T.strip, opacity: ENDED_OPACITY }).stroke('none');   // faded strip: an aborted sortie's estimate
      sh.stripS.fill({ color: T.stripSelected, opacity: 1 }).stroke('none');   // the selected estimate strip
      sh.stripA.fill({ color: T.alert, opacity: 1 }).stroke('none');   // red strip: an issued sortie that needs attention
    });
    tl.baselines().enabled(false);   // the strip is drawn by the bar's drawer, above the bar

    // Hover counts only when the pointer is over the bar itself; clicks on bars are handled in _down/_up
    const onBar = (e) => {
      if (!(e.item && e.item.get('raw'))) return false;
      const raw = e.item.get('raw'), tol = this._msPerPx() * MIN_BAR_W;   // short bars: the target is the drawn minimum width
      const spans = raw.group ? raw.hit : [[e.item.get('bs'), e.item.get('be')]];   // a collapsed mission: its actual bar or its estimate strip
      return spans.some(([s, en]) => e.hoverDateTime >= s && e.hoverDateTime <= Math.max(en, s + tol));
    };
    chart.listen('rowMouseMove', (e) => {
      const i = e.item ? this._idxById.get(e.item.get('id')) : -1;
      this._setHover(i == null ? -1 : i);
      if (onBar(e)) {
        this.hoverFlight = e.item.get('raw');
        this.el.style.cursor = 'pointer';
      } else {
        this.hoverFlight = null;
        this.el.style.cursor = '';
      }
    });
    chart.listen('rowMouseOut', () => { this._setHover(-1); this.hoverFlight = null; this.el.style.cursor = ''; });
    chart.listen('rowClick', (e) => { if (!onBar(e) && this.h.onEmptyClick) this.h.onEmptyClick(); });   // bar clicks are handled by _up

    this.chart = chart;   // set before drawing: the drawers read the visible range from it
    chart.container(this.el);
    chart.draw();
    this._appliedY = 0;
    this._styleSplitter();
  }
}
