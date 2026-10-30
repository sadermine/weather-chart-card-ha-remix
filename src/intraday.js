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

/** The instant of local midnight that starts the day containing `timeMs`, exact across a DST change. */
export function localMidnight(timeMs, timeZone) {
  const { date } = localDateHour(timeMs, timeZone);
  let midnight = timeMs;
  for (let attempt = 0; attempt < 3; attempt++) {
    const local = localDateHour(midnight, timeZone);
    if (local.date === date && local.hour === 0) break;
    midnight += local.date === date ? -local.hour * HOUR_MS : (24 - local.hour) * HOUR_MS;
  }
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
      .filter((p) => Number.isFinite(p.y) && p.x > coveredUntil);
    return [{ column: place.column, samples, min: entry.temp.min, max: entry.temp.max }];
  });

  const byX = (a, b) => a.x - b.x;
  const line = [...actualPoints, ...hourlyPoints, ...days.flatMap((d) => d.samples)].sort(byX);
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

/** Each day's highest and lowest point on the line, coloured by the part it is on. */
export function dayLabels(points, columnCount, colors) {
  const labels = [];
  for (let column = 0; column < columnCount; column++) {
    const own = points.filter((p) => p.x >= column - 0.5 && p.x < column + 0.5);
    if (!own.length) continue;
    const high = own.reduce((best, p) => (p.y > best.y ? p : best));
    const low = own.reduce((best, p) => (p.y < best.y ? p : best));
    labels.push({ column, kind: 'high', point: high, color: colors[high.part] });
    labels.push({ column, kind: 'low', point: low, color: colors[low.part] });
  }
  return labels;
}

const LABEL_GAP = 1;

function overlaps(a, b) {
  return Math.abs(a.cx - b.cx) < (a.width + b.width) / 2
    && a.top < b.top + b.height && b.top < a.top + a.height;
}

/**
 * Final horizontal centre and visibility of each label, in pixels. A label is
 * `{ column, kind, value, cx, top, width, height }`; `columns[i]` is
 * `{ left, right }` of day column i and `area` the chart's `{ left, right }`.
 * When two days' labels of the same kind overlap, each slides into its own
 * column; if they still overlap, only the lower low or the higher high stays.
 */
export function placeLabels(labels, columns, area) {
  const placed = labels.map((label) => ({
    ...label,
    cx: Math.min(area.right - label.width / 2, Math.max(area.left + label.width / 2, label.cx)),
    visible: true,
  }));
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      if (!a.visible || !b.visible || a.kind !== b.kind || a.column === b.column || !overlaps(a, b)) continue;
      const [left, right] = columns[a.column].left < columns[b.column].left ? [a, b] : [b, a];
      const leftColumn = columns[left.column];
      const rightColumn = columns[right.column];
      left.cx = Math.min(left.cx, Math.max(leftColumn.right - LABEL_GAP - left.width / 2, (leftColumn.left + leftColumn.right) / 2));
      right.cx = Math.max(right.cx, Math.min(rightColumn.left + LABEL_GAP + right.width / 2, (rightColumn.left + rightColumn.right) / 2));
      if (overlaps(left, right)) {
        const keepA = a.kind === 'high' ? a.value >= b.value : a.value <= b.value;
        (keepA ? b : a).visible = false;
      }
    }
  }
  return placed;
}
