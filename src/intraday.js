// The daily chart's intraday line: one temperature line that runs through each
// day's column. Pure functions, so node tests can drive them without a browser.

const HOUR_MS = 60 * 60 * 1000;

// Drawing order is also the order the parts join end to end.
export const INTRADAY_PARTS = {
  actual: { colorOption: 'temperature1_color', borderDash: [] },
  hourly: { colorOption: 'temperature2_color', borderDash: [] },
  fourADay: { colorOption: 'temperature2_color', borderDash: [6, 4] },
};

// OpenWeatherMap One Call daily entries: `temp` key and the local hour it is drawn at.
const FOUR_A_DAY_SAMPLES = [['morn', 6], ['day', 12], ['eve', 18], ['night', 23]];

const ESTIMATE_EARLIEST_HOUR = 0.5;
const ESTIMATE_LATEST_HOUR = 23.5;

/** x of a time `hour` hours into day column `column`, on an axis whose columns are centred on integers. */
export function columnPosition(column, hour) {
  return column - 0.5 + hour / 24;
}

const formatters = new Map();

/** Local calendar date (YYYY-MM-DD) and hour of day, minutes included, of an instant in a time zone. */
export function localDateHour(timeMs, timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }));
  }
  const parts = formatters.get(timeZone).formatToParts(new Date(timeMs));
  const part = (type) => Number((parts.find((p) => p.type === type) || {}).value);
  const date = `${String(part('year')).padStart(4, '0')}-${String(part('month')).padStart(2, '0')}-${String(part('day')).padStart(2, '0')}`;
  return { date, hour: part('hour') + part('minute') / 60 + part('second') / 3600 };
}

/** The first instant of the local day containing `timeMs`, exact across a DST change. */
export function localMidnight(timeMs, timeZone) {
  const { date } = localDateHour(timeMs, timeZone);
  let midnight = timeMs;
  for (let attempt = 0; attempt < 3; attempt++) {
    const local = localDateHour(midnight, timeZone);
    if (local.date === date && local.hour === 0) break;
    midnight += local.date === date ? -local.hour * HOUR_MS : (24 - local.hour) * HOUR_MS;
  }
  const local = localDateHour(midnight, timeZone);
  // Where the clocks skip midnight, the day starts at the first hour that exists.
  if (local.date !== date) midnight += (24 - local.hour) * HOUR_MS;
  return midnight;
}

function placeInColumns(timeMs, columns, timeZone) {
  const { date, hour } = localDateHour(timeMs, timeZone);
  const column = columns.indexOf(date);
  return column < 0 ? null : { column, x: columnPosition(column, hour) };
}

function timedPoints(readings, part, columns, timeZone) {
  return readings.flatMap(({ time, value }) => {
    const place = placeInColumns(time, columns, timeZone);
    return place ? [{ x: place.x, y: value, part }] : [];
  });
}

/**
 * The estimated point that lets the line reach a day's `temp.max` or `temp.min`.
 * Placed between the day's sample nearest the extreme and whichever of that
 * sample's neighbours is closer to it in value, inside the day's own column.
 */
function estimateExtreme(line, samples, extreme, isHigh, column) {
  if (!samples.length || !Number.isFinite(extreme)) return null;
  const sample = samples.reduce((best, s) => ((isHigh ? s.y > best.y : s.y < best.y) ? s : best));
  if (isHigh ? extreme <= sample.y : extreme >= sample.y) return null;
  const index = line.indexOf(sample);
  // The extreme sample lies under the hourly forecast, which already shows that day's extreme.
  if (index < 0) return null;
  const neighbours = [line[index - 1], line[index + 1]].filter(Boolean);
  if (!neighbours.length) return null;
  const neighbour = neighbours.reduce((best, n) => (Math.abs(n.y - extreme) < Math.abs(best.y - extreme) ? n : best));
  const toNeighbour = Math.abs(neighbour.y - extreme);
  const fraction = toNeighbour / (toNeighbour + Math.abs(sample.y - extreme));
  const x = neighbour.x + (sample.x - neighbour.x) * fraction;
  const earliest = columnPosition(column, ESTIMATE_EARLIEST_HOUR);
  const latest = columnPosition(column, ESTIMATE_LATEST_HOUR);
  return { x: Math.min(latest, Math.max(earliest, x)), y: extreme, part: 'fourADay' };
}

/**
 * The line's points, sorted by x. `columns` are the chart's day columns as
 * local dates. `actual` and `hourly` are `{ time, value }` readings; `daily`
 * are One Call daily entries (`dt` in seconds, `temp` in the display unit).
 * Readings outside the columns are dropped; the hourly part starts after
 * `now`, and four-a-day samples only where the earlier parts end.
 */
export function buildIntradayLine({ columns, actual = [], hourly = [], daily = [], now, timeZone }) {
  const actualPoints = timedPoints(actual.filter((r) => r.time <= now), 'actual', columns, timeZone);
  const hourlyPoints = timedPoints(hourly.filter((r) => r.time > now), 'hourly', columns, timeZone);
  const nowPlace = placeInColumns(now, columns, timeZone);
  const coveredUntil = Math.max(
    nowPlace ? nowPlace.x : -Infinity,
    ...actualPoints.map((p) => p.x),
    ...hourlyPoints.map((p) => p.x),
  );

  const days = daily.flatMap((entry) => {
    const place = placeInColumns(entry.dt * 1000, columns, timeZone);
    if (!place || !entry.temp) return [];
    const samples = FOUR_A_DAY_SAMPLES
      .map(([key, hour]) => ({ x: columnPosition(place.column, hour), y: entry.temp[key], part: 'fourADay' }))
      .filter((p) => Number.isFinite(p.y));
    return [{ column: place.column, samples, min: entry.temp.min, max: entry.temp.max }];
  });

  const byX = (a, b) => a.x - b.x;
  const drawn = days.flatMap((d) => d.samples).filter((p) => p.x > coveredUntil);
  const line = [...actualPoints, ...hourlyPoints, ...drawn].sort(byX);
  const estimates = days.flatMap((day) => [
    estimateExtreme(line, day.samples, day.max, true, day.column),
    estimateExtreme(line, day.samples, day.min, false, day.column),
  ]).filter(Boolean);
  return [...line, ...estimates].sort(byX);
}

/**
 * One series per part, each starting from the previous part's last point so
 * the parts join into one line.
 */
export function splitParts(points) {
  const series = {};
  let previous = null;
  for (const part of Object.keys(INTRADAY_PARTS)) {
    const own = points.filter((p) => p.part === part);
    series[part] = previous && own.length ? [previous, ...own] : own;
    if (own.length) previous = own[own.length - 1];
  }
  return series;
}

/** Each day's highest and lowest point on the line, coloured by the part it is on, with its value in whole degrees. */
export function dayLabels(points, columnCount, colors) {
  const labels = [];
  for (let column = 0; column < columnCount; column++) {
    const own = points.filter((p) => p.x >= column - 0.5 && p.x < column + 0.5);
    if (!own.length) continue;
    const high = own.reduce((best, p) => (p.y > best.y ? p : best));
    const low = own.reduce((best, p) => (p.y < best.y ? p : best));
    labels.push({ column, kind: 'high', point: high, value: Math.round(high.y), color: colors[high.part] });
    labels.push({ column, kind: 'low', point: low, value: Math.round(low.y), color: colors[low.part] });
  }
  return labels;
}

/**
 * The highest and lowest value the line can take between x0 and x1. Monotone
 * interpolation keeps each segment between its two points, so the points inside
 * the range and the one on either side of it bound the line there.
 */
export function lineExtent(points, x0, x1) {
  const before = points.filter((p) => p.x < x0).at(-1);
  const after = points.find((p) => p.x > x1);
  const near = [before, ...points.filter((p) => p.x >= x0 && p.x <= x1), after].filter(Boolean);
  if (!near.length) return null;
  const ys = near.map((p) => p.y);
  return { min: Math.min(...ys), max: Math.max(...ys) };
}

/**
 * Top of a number `height` tall that sits `gap` above (`up`) or below (`down`)
 * its guide at `guideY`, in pixels. Where the line, from `lineTop` to
 * `lineBottom`, passes through it, the number moves further out the same way.
 */
export function numberTop(direction, guideY, height, gap, line) {
  let top = direction === 'up' ? guideY - gap - height : guideY + gap;
  if (line && line.top < top + height && line.bottom > top) {
    top = direction === 'up' ? line.top - gap - height : line.bottom + gap;
  }
  return top;
}

const RATE_STEP_MS = 15 * 60 * 1000;

/**
 * Rain per local hour, `[{ time, amount }]` with `time` the hour's first
 * instant. A rate sensor's readings (per hour) are integrated until `now`; a
 * total's rises are summed, and a fall is a reset, so the new value counts.
 */
export function hourlyRainfall(readings, { now, isRate, timeZone }) {
  const hours = new Map();
  const add = (time, amount) => {
    const { hour } = localDateHour(time, timeZone);
    // Recorder timestamps carry milliseconds, which the local hour leaves out.
    const start = Math.floor(time / 1000) * 1000 - Math.round((hour % 1) * 3600) * 1000;
    hours.set(start, (hours.get(start) || 0) + amount);
  };
  const known = isRate ? readings : readings.filter((r) => Number.isFinite(r.value));
  known.forEach((reading, i) => {
    if (isRate) {
      const end = Math.min(now, i + 1 < known.length ? known[i + 1].time : now);
      // An unavailable sensor counts as no rain, so the hour still shows as measured.
      // Every zone's offset is a whole number of quarter hours, so no step spans two local hours.
      for (let t = reading.time; t < end;) {
        const next = Math.min(end, (Math.floor(t / RATE_STEP_MS) + 1) * RATE_STEP_MS);
        add(t, (reading.value > 0 ? reading.value : 0) * (next - t) / HOUR_MS);
        t = next;
      }
    } else if (i > 0) {
      const rise = reading.value - known[i - 1].value;
      add(reading.time, rise >= 0 ? rise : reading.value);
    }
  });
  return [...hours].map(([time, amount]) => ({ time, amount })).sort((a, b) => a.time - b.time);
}

/**
 * The rain band under the line. `slots` are hours: `actual` ones before the
 * current hour, from `actual` (`{ time, amount }`), and `hourly` ones from the
 * current hour on (`{ time, chance, amount }`). `spans` carry `daily[column]`
 * (`{ chance, amount }`) over the rest of each day. `peaks` are each day's
 * highest hourly chance and amount, across the hours it has. `hourly` is the
 * x range the hourly forecast covers, or null.
 */
export function buildRainBand({ columns, actual = [], hourly = [], daily = [], now, timeZone }) {
  const slot = (time, kind, chance, amount) => {
    const place = placeInColumns(time, columns, timeZone);
    return place ? [{ column: place.column, x0: place.x, x1: place.x + 1 / 24, kind, chance, amount }] : [];
  };
  const forecastSlots = hourly
    .filter((h) => h.time + HOUR_MS > now)
    .flatMap((h) => slot(h.time, 'hourly', h.chance, h.amount));
  const firstForecast = Math.min(...hourly.filter((h) => h.time + HOUR_MS > now).map((h) => h.time));
  const actualSlots = actual
    .filter((a) => a.time <= now && a.time < firstForecast)
    .flatMap((a) => slot(a.time, 'actual', null, a.amount));
  const slots = [...actualSlots, ...forecastSlots].sort((a, b) => a.x0 - b.x0);

  const nowPlace = placeInColumns(now, columns, timeZone);
  const coveredUntil = Math.max(nowPlace ? nowPlace.x : -Infinity, ...slots.map((s) => s.x1));
  const spans = daily.flatMap((day, column) => {
    const x0 = Math.max(column - 0.5, coveredUntil);
    return day && x0 < column + 0.5 ? [{ column, x0, x1: column + 0.5, chance: day.chance, amount: day.amount }] : [];
  });

  const peaks = [];
  for (let column = 0; column < columns.length; column++) {
    const own = slots.filter((s) => s.column === column);
    if (!own.length) continue;
    const top = (values) => Math.max(0, ...values.filter(Number.isFinite));
    peaks.push({
      column,
      x0: own[0].x0,
      x1: own.at(-1).x1,
      chance: top(own.map((s) => s.chance)),
      amount: top(own.map((s) => s.amount)),
    });
  }

  const forecastRange = forecastSlots.length
    ? { x0: Math.min(...forecastSlots.map((s) => s.x0)), x1: Math.max(...forecastSlots.map((s) => s.x1)) }
    : null;
  return { slots, spans, peaks, hourly: forecastRange };
}
