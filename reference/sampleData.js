/**
 * Sample data that shows the expected shape. Replace with your API response. No flight starts out as updated.
 * Each mission has one A/C model; model + tail is the aircraft. Sorties on one tail never fly at the same time. UAV and TG
 * fly one sortie after the other: a sortie departs the moment the previous one lands (ATD = the previous ATA, a staircase), so it
 * is never 'issued' while the aircraft before it has landed. Their plans are a staircase too (ETD = the previous ETA).
 */
const T = (d, h, m = 0) => Date.UTC(2026, 10, d, h, m);
const extra = (a = 'ABC', b = 'DEF', c = 'GHI') => ({ fieldA: a, fieldB: b, fieldC: c });
const fl = (model, tail, id, code, etd, eta, atd, ata) => ({ id, model, tail, code, etd, eta, ...(atd ? { atd } : {}), ...(ata ? { ata } : {}), ...extra() });

/** "Now" frozen at 21 Nov 22:30 UTC so every scenario stays visible in the prototype. */
export const NOW = T(21, 22, 30);

/** The default 12-hour window. */
export const DEFAULT_RANGE = [T(21, 16, 0), T(22, 16, 0)];   // one day; the page also offers two days, from 20 Nov 16:00 (see RANGE_2D)
export const RANGE_2D = [T(20, 16, 0), T(22, 16, 0)];

const MISSIONS = [
  // ---- Not scheduled: a callsign none of whose sorties has a time. It has one anchor time, used only to place it in the date range;
  // the timeline shades its rows and says Not scheduled instead of drawing bars. ----
  { id: 'M', name: 'Mission M', model: 'HELI', anchor: T(21, 18, 0), children: [
    fl('HELI', '1101', 'VEGA01', 'IS'),
    fl('HELI', '1102', 'VEGA02', 'IS'),
    fl('HELI', '1103', 'VEGA03', 'IS'),
  ]},

  // ---- UAV and TG: one mission per case of the sheet's UAV/TG set, in the sheet's order (cases 1 to 8) ----
  // UAV: one aircraft flies several sorties. UAV-1111 has three (landed, flying, next); UAV-2222 has one that is late to depart.
  { id: 'A', name: 'Mission A', model: 'UAV', children: [
    fl('UAV', '1111', 'SOUR01', 'LD', T(21, 17, 0), T(21, 19, 0), T(21, 17, 10), T(21, 19, 5)),
    fl('UAV', '1111', 'SOUR02', 'FP', T(21, 19, 0), T(21, 23, 30), T(21, 19, 5)),     // departs when SOUR01 landed (19:05)
    fl('UAV', '1111', 'SOUR03', 'IS', T(21, 23, 30), T(22, 1, 30)),
    fl('UAV', '1111', 'SOUR04', 'IS', T(22, 1, 30), T(22, 3, 30)),
  ]},

  // UAV, one tail, all landed, as a staircase: each sortie departs the moment the previous one lands (ATD = the previous ATA).
  // DUSK02 left a little late and landed early, so DUSK03 left a little early.
  { id: 'B', name: 'Mission B', model: 'UAV', children: [
    fl('UAV', '6001', 'DUSK01', 'LD', T(21, 17, 0), T(21, 18, 30), T(21, 17, 10), T(21, 18, 35)),
    fl('UAV', '6001', 'DUSK02', 'LD', T(21, 18, 30), T(21, 20, 0), T(21, 18, 35), T(21, 19, 50)),
    fl('UAV', '6001', 'DUSK03', 'LD', T(21, 20, 0), T(21, 21, 30), T(21, 19, 50), T(21, 21, 40)),
  ]},

  // TG: one aircraft, two sorties landed, two aborted: the actual bar is short and the estimate runs on to the last ETA
  { id: 'C', name: 'Mission C', model: 'TG', children: [
    fl('TG', '3001', 'FISH01', 'LD', T(21, 17, 0), T(21, 19, 0), T(21, 17, 5), T(21, 19, 10)),
    fl('TG', '3001', 'FISH02', 'LD', T(21, 19, 0), T(21, 21, 0), T(21, 19, 10), T(21, 21, 5)),   // departs when FISH01 landed (19:10)
    fl('TG', '3001', 'FISH03', 'IA', T(21, 21, 0), T(21, 23, 0)),
    fl('TG', '3001', 'FISH04', 'IA', T(21, 23, 0), T(22, 1, 0)),
  ]},

  // TG, one tail, nothing has departed yet: a staircase plan, each sortie planned to start when the previous one ends. Collapsed: one IS block, NOVA01 +2.
  // NOVA01 is only 20 minutes long, shorter than its own label.
  { id: 'D', name: 'Mission D', model: 'TG', children: [
    fl('TG', '7001', 'NOVA01', 'IS', T(21, 23, 0), T(21, 23, 20)),
    fl('TG', '7001', 'NOVA02', 'IS', T(21, 23, 20), T(21, 23, 40)),
    fl('TG', '7001', 'NOVA03', 'IS', T(21, 23, 40), T(22, 1, 40)),
  ]},

  // UAV, one tail, every sortie aborted: faded bars, status IA when collapsed
  { id: 'E', name: 'Mission E', model: 'UAV', children: [
    fl('UAV', '8001', 'PIKE01', 'IA', T(21, 18, 0), T(21, 19, 30)),
    fl('UAV', '8001', 'PIKE02', 'IA', T(21, 19, 30), T(21, 21, 0)),
  ]},

  // TG, an anomaly: ZEBR01's ETD has passed and it has not departed. The two IS sorties combine into one bar, ZEBR01 +1, with the chip on it.
  { id: 'F', name: 'Mission F', model: 'TG', children: [
    fl('TG', '7101', 'ZEBR01', 'IS', T(21, 20, 30), T(21, 23, 0)),
    fl('TG', '7101', 'ZEBR02', 'IS', T(21, 23, 0), T(22, 1, 0)),
  ]},

  // UAV, an anomaly and a chain beyond the view: KILO02 is past its ETA with no landing. The chain started before the 16:00 start of the view, so
  // its one continuous bar is cut at the left edge and the label stays there.
  { id: 'G', name: 'Mission G', model: 'UAV', children: [
    fl('UAV', '6101', 'KILO01', 'LD', T(21, 14, 0), T(21, 17, 0), T(21, 14, 10), T(21, 17, 5)),
    fl('UAV', '6101', 'KILO02', 'FP', T(21, 17, 0), T(21, 22, 0), T(21, 17, 5)),
  ]},

  // ---- HELI and FTR: in the order of the sheet's HELI/FTR set (cases 1 to 7; two missions serve two cases each) ----
  // HELI, two aircraft (tails 0801 and 0802): APPLE01 landed, APPLE02 left on time. Collapsed, the gap keeps them as two blocks.
  { id: 'H', name: 'Mission H', model: 'HELI', children: [
    fl('HELI', '0801', 'APPLE01', 'LD', T(21, 17, 0), T(21, 18, 30), T(21, 17, 5), T(21, 18, 35)),
    fl('HELI', '0802', 'APPLE02', 'FP', T(21, 20, 0), T(21, 23, 0), T(21, 20, 0)),   // left exactly on time
  ]},

  // HELI: every sortie is its own aircraft. Two sorties have an anomaly (HAWK02 not arrived, HAWK03 not departed): collapsed, the chip reads "2 anomalies"
  { id: 'I', name: 'Mission I', model: 'HELI', children: [
    fl('HELI', '1001', 'HAWK00', 'LD', T(20, 18, 0), T(20, 20, 0), T(20, 18, 5), T(20, 20, 5)),   // only in the two-day range
    fl('HELI', '0101', 'HAWK01', 'FP', T(21, 19, 0), T(21, 23, 45), T(21, 19, 10)),
    fl('HELI', '0102', 'HAWK02', 'FP', T(21, 20, 0), T(21, 22, 0), T(21, 20, 5)),                // ETA passed, no ATA
    fl('HELI', '0103', 'HAWK03', 'IS', T(21, 21, 0), T(22, 1, 0)),                       // ETD passed, no ATD
    fl('HELI', '0104', 'HAWK04', 'IS', T(21, 23, 30), T(22, 3, 0)),
  ]},

  // HELI, three tails, all landed or closed: ONYX01 landed on time, ONYX02 late at both ends, ONYX03 closed. The bars start about 3.2 hours
  // apart (all before "now", the most the data allows) so that each label shows in full when collapsed, on a screen about 1500px wide or more
  // at the 24-hour view (a label stops where the next bar starts).
  { id: 'J', name: 'Mission J', model: 'HELI', children: [
    fl('HELI', '0601', 'ONYX01', 'LD', T(21, 16, 0), T(21, 17, 0), T(21, 16, 0), T(21, 17, 0)),   // on time
    fl('HELI', '0602', 'ONYX02', 'LD', T(21, 18, 40), T(21, 21, 50), T(21, 19, 10), T(21, 22, 20)),   // late out and late in; long enough for its whole label
    fl('HELI', '0603', 'ONYX03', 'CL', T(21, 22, 25), T(21, 22, 30), T(21, 22, 20), T(21, 22, 29)),   // starts when ONYX02 landed (2220): the bars touch, but flown and closed are different groups
  ]},

  // FTR: VIPR02 took off first although VIPR01 was planned earlier (VIPR01 is delayed)
  { id: 'K', name: 'Mission K', model: 'FTR', children: [
    fl('FTR', '0201', 'VIPR01', 'IS', T(21, 20, 0), T(21, 21, 30)),                      // ETD passed, no ATD
    fl('FTR', '0202', 'VIPR02', 'FP', T(21, 21, 0), T(22, 0, 30), T(21, 20, 55)),
    fl('FTR', '0203', 'VIPR03', 'IS', T(22, 0, 0), T(22, 2, 30)),
  ]},

  // FTR: bars that go beyond the view. With the default 16:00 to 04:00 window, GRYF01 starts before it, GRYF02 ends after it, GRYF03 does both
  // (its ETD has passed, so it is also an anomaly), GRYF04 is only 20 minutes long. Collapsed, the three issued sorties become one group on a second
  // lane that runs past both edges of the view, under GRYF01.
  { id: 'L', name: 'Mission L', model: 'FTR', children: [
    fl('FTR', '0701', 'GRYF01', 'LD', T(21, 14, 30), T(21, 17, 30), T(21, 14, 40), T(21, 17, 45)),
    fl('FTR', '0702', 'GRYF02', 'IS', T(22, 3, 0), T(22, 6, 0)),
    fl('FTR', '0703', 'GRYF03', 'IS', T(21, 14, 0), T(22, 7, 0)),
    fl('FTR', '0704', 'GRYF04', 'IS', T(21, 20, 40), T(21, 21, 0)),                       // 20 minutes and its ETD has passed: a short bar with a chip
  ]},
];

// What every mission row shows besides its callsign. Here all missions share these values; only the callsign differs, because it comes from the sorties.
const MISSION_INFO = { id: 'A12345678', code: 'ABCD', activityType: 'ACTIVITY ABCD' };
export const PARENTS = MISSIONS.map((m) => ({ ...m, info: MISSION_INFO }));
