import assert from 'node:assert/strict';
import { test } from 'node:test';

// main.js registers itself on `window`; Lit's Node build shims the DOM classes.
globalThis.window = globalThis;
const { default: WeatherChartCard } = await import('../src/main.js');
const { DEFAULTS, FORECAST_DEFAULTS, configValue } = await import('../src/defaults.js');

// A card with config and hass applied, without rendering it.
function makeCard(config = {}, hass = {}) {
  const card = new WeatherChartCard();
  card.setConfig({ entity: 'weather.home', ...config });
  card._hass = {
    states: {},
    config: { time_zone: 'UTC', unit_system: { length: 'km', temperature: '°C' } },
    ...hass,
  };
  return card;
}

test('#1 turning autoscroll on starts the timer, turning it off cancels it', async () => {
  const card = makeCard({ autoscroll: true });
  const calls = [];
  card.autoscroll = () => calls.push('start');
  card.cancelAutoscroll = () => calls.push('cancel');
  card.drawChart = () => {};
  card.syncForecastSubscriptions = () => {};
  // updated() awaits updateComplete, which only settles once the card is connected.
  card.getUpdateComplete = async () => true;

  await card.updated(new Map([['config', { ...card.config, autoscroll: false }]]));
  card.config = { ...card.config, autoscroll: false };
  await card.updated(new Map([['config', { ...card.config, autoscroll: true }]]));
  assert.deepEqual(calls, ['start', 'cancel']);
});

test('#2 weekday and month follow the card timezone, not the browser', () => {
  const card = makeCard({ locale: 'en' });
  // 23:30 UTC on Saturday 31 October is already Sunday 1 November in Tokyo.
  const instant = new Date('2026-10-31T23:30:00Z');
  assert.deepEqual(card.getZonedDateIndices(instant, 'Asia/Tokyo'), { dayIndex: 0, monthIndex: 10 });
  assert.deepEqual(card.getZonedDateIndices(instant, 'America/Los_Angeles'), { dayIndex: 6, monthIndex: 9 });
  assert.equal(card.getLocalizedDayNameFull(instant, 'Asia/Tokyo'), 'Sunday');
  assert.equal(card.getLocalizedMonthName(instant, 'Asia/Tokyo'), 'November');
  assert.equal(card.getLocalizedMonthNameShort(instant, 'America/Los_Angeles'), 'OCT');
});

test('#3 autoscroll drops past slots before limiting the column count', () => {
  const card = makeCard({ autoscroll: true, forecast: { type: 'hourly' } });
  const hour = 60 * 60 * 1000;
  const now = Date.now();
  card.forecasts = [-3, -2, 0, 1, 2, 3].map((h) => ({ datetime: new Date(now + h * hour).toISOString(), temperature: 10 }));
  const visible = card.getVisibleForecast(3);
  assert.equal(visible.length, 3);
  assert.equal(visible[0], card.forecasts[2]);
  // The chart is built from the same slice as the icon and wind rows.
  assert.deepEqual(card.computeForecastData({ config: card.config, forecastItems: 3 }).forecast, visible);
});

test('#4 missing or unavailable alternative sensors fall back to the weather entity', () => {
  const card = makeCard();
  const hass = { states: {
    'sensor.ok': { state: '21.5', attributes: {} },
    'sensor.down': { state: 'unavailable', attributes: {} },
  } };
  assert.equal(card.readSensorState(hass, 'sensor.ok', 10), '21.5');
  assert.equal(card.readSensorState(hass, 'sensor.down', 10), 10);
  assert.equal(card.readSensorState(hass, 'sensor.renamed', 10), 10);
  assert.equal(card.readSensorState(hass, undefined, 10), 10);
});

test('#5 #13 the stub and the card share one set of defaults', () => {
  const stub = WeatherChartCard.getStubConfig({}, ['weather.home'], ['weather.home']);
  assert.equal(stub.entity, 'weather.home');
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (typeof value !== 'object') assert.equal(stub[key], value, key);
  }
  assert.deepEqual(stub.forecast, FORECAST_DEFAULTS);
  assert.equal(typeof stub.forecast.labels_font_size, 'number');
  assert.equal(makeCard().config.show_feels_like, false);
  // The editor reads absent keys from the same defaults.
  assert.equal(configValue({}, 'show_feels_like'), false);
  assert.equal(configValue({}, 'animated_icons'), true);
  assert.equal(configValue({ forecast: {} }, 'forecast.show_wind_forecast'), true);
  assert.equal(configValue({ forecast: { round_temp: true } }, 'forecast.round_temp'), true);
});

test('#7 Norwegian resolves through both nb and no', () => {
  assert.notEqual(makeCard({ locale: 'nb' }).ll('daily'), makeCard({ locale: 'en' }).ll('daily'));
  assert.equal(makeCard({ locale: 'no' }).ll('daily'), makeCard({ locale: 'nb' }).ll('daily'));
  assert.equal(makeCard({ locale: 'no' }).getLocaleArray('days')[0], makeCard({ locale: 'nb' }).getLocaleArray('days')[0]);
});

test('#10 precipitation bars use the display unit, with a matching axis ceiling', () => {
  const card = makeCard({ units: { precipitation: 'mm' } }, {
    states: { 'weather.home': { state: 'rainy', attributes: { precipitation_unit: 'in', supported_features: 1 } } },
  });
  card.forecasts = [{ datetime: '2026-10-21T00:00:00Z', temperature: 10, precipitation: 0.5 }];
  assert.deepEqual(card.computeForecastData({ config: card.config, forecastItems: 1 }).precip, [12.7]);
  assert.equal(card.getPrecipitationAxisMax('mm', true), 4);
  assert.equal(card.getPrecipitationAxisMax('mm', false), 20);
  assert.equal(card.getPrecipitationAxisMax('cm', false), 2);
  assert.equal(card.getPrecipitationAxisMax('in', false), 1);
});

test('#11 pressure converts between every Home Assistant unit', () => {
  const card = makeCard();
  assert.deepEqual(card.formatPressure(1013.25, 'hPa', 'inHg'), { value: '29.92', unit: 'inHg' });
  assert.deepEqual(card.formatPressure(1013.25, 'mbar', 'hPa'), { value: 1013, unit: 'hPa' });
  assert.deepEqual(card.formatPressure(101.325, 'kPa', 'hPa'), { value: 1013, unit: 'hPa' });
  assert.deepEqual(card.formatPressure(14.696, 'psi', 'mmHg'), { value: 760, unit: 'mmHg' });
  assert.deepEqual(card.formatPressure(1013.25, 'hPa', 'kPa'), { value: '101.3', unit: 'kPa' });
  // An unknown unit is shown as reported, labelled with its own unit.
  assert.deepEqual(card.formatPressure(1013.25, 'weird', 'hPa'), { value: 1013, unit: 'weird' });
  assert.deepEqual(card.formatPressure(undefined, 'hPa', 'hPa'), { value: undefined, unit: 'hPa' });
});

test('#16 unknown and unavailable conditions fall back to Home Assistant translations', () => {
  const card = makeCard({ locale: 'en' }, {
    localize: (key) => ({ 'state.default.unavailable': 'Unavailable' })[key] || '',
  });
  assert.equal(card.localizeCondition('rainy'), 'Rainy');
  assert.equal(card.localizeCondition('unavailable'), 'Unavailable');
  assert.equal(card.localizeCondition('unknown'), 'unknown');
});

test('#17 the card is listed in the picker once', () => {
  assert.equal(window.customCards.filter((card) => card.type === 'weather-chart-card-ha').length, 1);
});

test('#14 README option tables list the defaults the card uses', async () => {
  const { readFileSync } = await import('node:fs');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = (heading) => readme.split(heading)[1].split('\n### ')[0];
  const tableDefaults = (text) => Object.fromEntries(text.split('\n')
    .filter((line) => /^\| [a-z_0-9]+ *\|/.test(line))
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .map(([, name, , value]) => [name, value.replace(/^'(.*)'$/, '$1')]));

  const tables = [
    [section('### Card Options'), DEFAULTS],
    [section('### Forecast Options'), FORECAST_DEFAULTS],
    [section('### Units of Measurement'), DEFAULTS.units],
  ];
  for (const [text, defaults] of tables) {
    const documented = tableDefaults(text);
    for (const [key, value] of Object.entries(defaults)) {
      if (typeof value === 'object') continue;
      assert.ok(key in documented, `${key} is not documented`);
      assert.equal(documented[key], String(value), `README default for ${key}`);
    }
  }
  assert.ok(!readme.includes('location_name') && !readme.includes('condition_icon_size_multiplier'));
});

test('auto-rotate interval is minutes plus 0/5/10/15/30 seconds, 5 s to 60 min 30 s', () => {
  const ms = (forecast) => makeCard({ forecast }).getAutoRotateMs();
  assert.equal(ms({}), 0);
  assert.equal(ms({ auto_rotate: 0, auto_rotate_seconds: 0 }), 0);
  assert.equal(ms({ auto_rotate: 0, auto_rotate_seconds: 5 }), 5000);
  assert.equal(ms({ auto_rotate: '2', auto_rotate_seconds: 30 }), 150000);
  assert.equal(ms({ auto_rotate: 60, auto_rotate_seconds: 30 }), 3630000);
  // Out of range minutes clamp; seconds outside the dropdown are ignored.
  assert.equal(ms({ auto_rotate: 90, auto_rotate_seconds: 7 }), 3600000);
});

test('auto-rotate keeps both subscriptions, switches instantly, and a click restarts the timer', (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable(['setTimeout']);
  const tick = (ms) => {
    now += ms;
    t.mock.timers.tick(ms);
  };
  const subscribed = [];
  const callbacks = {};
  const supported = { state: 'sunny', attributes: { supported_features: 3 } };
  const card = makeCard({ forecast: { auto_rotate: 0, auto_rotate_seconds: 10, type: 'daily' } }, {
    states: { 'weather.home': supported },
    connection: { subscribeMessage(callback, message) {
      subscribed.push(message.forecast_type);
      callbacks[message.forecast_type] = callback;
      return Promise.resolve(() => {});
    } },
  });
  card.drawChart = () => {};
  card.updateChart = () => {};

  card.syncForecastSubscriptions();
  assert.deepEqual(subscribed.sort(), ['daily', 'hourly']);
  const daily = [{ datetime: '2026-10-21T12:00:00Z', temperature: 20 }];
  const hourly = [{ datetime: '2026-10-21T13:00:00Z', temperature: 18 }];
  callbacks.daily({ forecast: daily });
  callbacks.hourly({ forecast: hourly });
  assert.equal(card.forecasts, daily);

  card.startAutoRotate();
  tick(10000);
  assert.equal(card.config.forecast.type, 'hourly');
  assert.equal(card.forecasts, hourly, 'switches to the cached payload at once');
  assert.equal(subscribed.length, 2, 'no re-subscribe on a rotation');

  // Click 4 s into the next interval: switch now, next auto switch 10 s later.
  tick(4000);
  card.handleForecastToggleClick();
  assert.equal(card.config.forecast.type, 'daily');
  tick(9999);
  assert.equal(card.config.forecast.type, 'daily');
  tick(1);
  assert.equal(card.config.forecast.type, 'hourly');
  card.stopAutoRotate();
});

test('without auto-rotate only the forecast on screen stays subscribed', () => {
  const subscribed = [];
  const card = makeCard({ forecast: { type: 'daily' } }, {
    states: { 'weather.home': { state: 'sunny', attributes: { supported_features: 3 } } },
    connection: { subscribeMessage(callback, message) {
      subscribed.push(message.forecast_type);
      return Promise.resolve(() => {});
    } },
  });
  card.syncForecastSubscriptions();
  card.handleForecastTypeToggle();
  assert.deepEqual(subscribed, ['daily', 'hourly']);
  assert.deepEqual(Object.keys(card._forecastSubscriptions), ['hourly']);
});

test('a single-point temperature gradient has a valid stop offset', () => {
  const card = makeCard();
  const stops = [];
  const ctx = { createLinearGradient: () => ({ addColorStop(offset, color) {
    // CanvasGradient.addColorStop throws on a non-finite offset.
    if (!Number.isFinite(offset) || offset < 0 || offset > 1) throw new RangeError(`bad offset ${offset}`);
    stops.push([offset, color]);
  } }) };
  const area = { left: 0, right: 100 };
  card.createTemperatureGradient([12], '°C', ctx, area);
  assert.deepEqual(stops.map(([offset]) => offset), [0]);
  stops.length = 0;
  card.createTemperatureGradient([12, 15, 18], '°C', ctx, area);
  assert.deepEqual(stops.map(([offset]) => offset), [0, 0.5, 1]);
});

test('auto-rotate targets the next boundary, so a late timeout does not drift', (t) => {
  // Hand-driven clock and timers, so a timeout can be delivered late.
  let now = 0;
  let pending = null;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => (pending = { callback, at: now + delay }));
  t.mock.method(globalThis, 'clearTimeout', () => { pending = null; });
  const fire = (at) => { now = at; const { callback } = pending; pending = null; callback(); };

  const card = makeCard({ forecast: { auto_rotate: 0, auto_rotate_seconds: 10 } }, {
    states: { 'weather.home': { state: 'sunny', attributes: { supported_features: 3 } } },
  });
  card.handleForecastTypeToggle = () => {};
  card.startAutoRotate();
  assert.equal(pending.at, 10000);
  fire(25000); // throttled: 15 s late
  assert.equal(pending.at, 30000, 'back on the shared boundary, not 35 s');
  fire(29999); // early by 1 ms: must not switch again for the same boundary
  assert.equal(pending.at, 40000);

  // A click 4 s after a boundary: full interval from the click, then that cadence.
  now = 44000;
  card.startAutoRotate({ fromNow: true });
  assert.equal(pending.at, 54000);
  fire(61000);
  assert.equal(pending.at, 64000);
  card.stopAutoRotate();
});

test('config changes select the cached forecast before redrawing', async () => {
  const callbacks = {};
  const supported = { state: 'sunny', attributes: { supported_features: 3 } };
  const card = makeCard({ forecast: { auto_rotate: 1, type: 'daily' } }, {
    states: { 'weather.home': supported },
    connection: { subscribeMessage(callback, message) {
      callbacks[message.forecast_type] = callback;
      return Promise.resolve(() => {});
    } },
  });
  const drawnForecasts = [];
  card.drawChart = () => drawnForecasts.push(card.forecasts);
  card.getUpdateComplete = async () => true;
  card.syncForecastSubscriptions();

  const daily = [{ datetime: '2026-10-21T12:00:00Z', temperature: 20 }];
  const hourly = [{ datetime: '2026-10-21T13:00:00Z', temperature: 18 }];
  callbacks.daily({ forecast: daily });
  callbacks.hourly({ forecast: hourly });

  const oldConfig = card.config;
  card.config = { ...oldConfig, forecast: { ...oldConfig.forecast, type: 'hourly', auto_rotate: 0 } };
  await card.updated(new Map([['config', oldConfig]]));

  assert.equal(card.forecasts, hourly);
  assert.equal(drawnForecasts.at(-1), hourly);
  assert.deepEqual(Object.keys(card._forecastSubscriptions), ['hourly']);
});

const { columnPosition, buildIntradayLine, dayLabels, placeLabels, localMidnight } = await import('../src/intraday.js');
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
const owmDay = (dt, [morn, day, eve, night], min, max) => ({ dt, temp: { morn, day, eve, night, min, max } });
const noonUtc = (day) => Date.UTC(2026, 2, day, 12) / 1000;

test('#2 criterion 2: a time h hours into day column i sits at i - 0.5 + h / 24', () => {
  assert.equal(columnPosition(0, 0), -0.5);
  assert.equal(columnPosition(2, 12), 2);
  assert.equal(columnPosition(2, 6), 1.75);
});

test('#2 criterion 3: four-a-day samples land at 6 AM, noon, 6 PM and 11 PM local time, across a DST change', () => {
  // 2024-11-02 16:00 UTC is noon EDT; 2024-11-03 16:00 UTC is 11:00 EST, after the clock change.
  const line = buildIntradayLine({
    columns: ['2024-11-02', '2024-11-03'],
    daily: [owmDay(1730563200, [40, 50, 45, 42], 40, 50), owmDay(1730649600, [41, 51, 46, 43], 41, 51)],
    now: 0,
    timeZone: 'America/New_York',
  });
  assert.deepEqual(line.map((p) => p.x), [-0.25, 0, 0.25, columnPosition(0, 23), 0.75, 1, 1.25, columnPosition(1, 23)]);
});

test('#2 criterion 6: temp.max and temp.min become points between the extreme sample and its closer neighbour', () => {
  const xsOf = (line, y) => line.filter((p) => p.y === y).map((p) => p.x);
  const oneDay = buildIntradayLine({ columns: ['2026-03-10'], daily: [owmDay(noonUtc(10), [35, 50, 62, 56], 35, 65)], now: 0, timeZone: 'UTC' });
  assert.equal(xsOf(oneDay, 65).length, 1);
  near(xsOf(oneDay, 65)[0], columnPosition(0, 19.25), '65 at 19:15');

  const overnight = buildIntradayLine({
    columns: ['2026-03-10', '2026-03-11'],
    daily: [owmDay(noonUtc(10), [45, 50, 48, 37], 37, 50), owmDay(noonUtc(11), [36, 50, 48, 45], 34, 50)],
    now: 0,
    timeZone: 'UTC',
  });
  assert.equal(xsOf(overnight, 34).length, 1);
  near(xsOf(overnight, 34)[0], columnPosition(1, 3.2), '34 at 03:12');

  const noExtra = buildIntradayLine({ columns: ['2026-03-10'], daily: [owmDay(noonUtc(10), [35, 50, 62, 56], 35, 62)], now: 0, timeZone: 'UTC' });
  assert.equal(noExtra.length, 4, 'an extreme equal to its sample adds no point');

  // The 11 PM sample is the day's highest and the next morning is closer to temp.max.
  const lateHigh = buildIntradayLine({
    columns: ['2026-03-10', '2026-03-11'],
    daily: [owmDay(noonUtc(10), [40, 50, 45, 52], 40, 54), owmDay(noonUtc(11), [53, 40, 41, 42], 40, 53)],
    now: 0,
    timeZone: 'UTC',
  });
  assert.equal(xsOf(lateHigh, 54).length, 1);
  assert.ok(xsOf(lateHigh, 54)[0] <= columnPosition(0, 23.5), 'stays in its own day, no later than 23:30');
});

test('#2 criterion 6: no estimate when the extreme sample lies under the hourly forecast', () => {
  // Hourly covers day 1 until 15:00, including its 06:00 low; the lowest remaining sample (11 PM) is not the day's low.
  const hourly = [];
  for (let h = 15; h <= 39; h++) hourly.push({ time: Date.UTC(2026, 2, 9, h), value: h === 30 ? 49 : 55 });
  const line = buildIntradayLine({
    columns: ['2026-03-09', '2026-03-10'],
    hourly,
    daily: [owmDay(noonUtc(10), [49, 63, 60, 56], 48, 63)],
    now: Date.UTC(2026, 2, 9, 14),
    timeZone: 'UTC',
  });
  assert.equal(line.filter((p) => p.y === 48).length, 0, 'no 48 point late in the day');
});

test('#2 localMidnight: a day whose midnight is skipped starts at 01:00', () => {
  // America/Santiago moves its clocks from 00:00 to 01:00 on 2026-09-06.
  const start = localMidnight(Date.UTC(2026, 8, 6, 15), 'America/Santiago');
  assert.equal(new Date(start).toISOString(), '2026-09-06T04:00:00.000Z');
});

test('#2 criterion 7: each day gets one high and one low label, at its extremes, in the colour of their part', () => {
  const colors = { actual: 'orange', hourly: 'blue', fourADay: 'navy' };
  const points = [
    { x: -0.5, y: 30, part: 'actual' },
    { x: -0.1, y: 38, part: 'actual' },
    { x: 0.2, y: 41, part: 'hourly' },
    { x: 0.6, y: 33, part: 'hourly' },
    { x: 1.0, y: 45, part: 'fourADay' },
  ];
  assert.deepEqual(dayLabels(points, 2, colors).map(({ column, kind, point, color }) => [column, kind, point.y, color]), [
    [0, 'high', 41, 'blue'],
    [0, 'low', 30, 'orange'],
    [1, 'high', 45, 'navy'],
    [1, 'low', 33, 'blue'],
  ]);
});

test('#2 criterion 7: day numbers show whole degrees, whatever the source precision', () => {
  const colors = { actual: 'orange', hourly: 'blue', fourADay: 'navy' };
  const points = [
    { x: -0.2, y: 41.9, part: 'fourADay' },
    { x: 0.1, y: 65.3, part: 'fourADay' },
    { x: 0.3, y: 50.5, part: 'fourADay' },
  ];
  assert.deepEqual(dayLabels(points, 1, colors).map(({ kind, value }) => [kind, value]), [
    ['high', 65],
    ['low', 42],
  ]);
});

test('#2 criterion 7: overlapping numbers slide into their own columns, and only the lower low stays if that is not enough', () => {
  const columns = [{ left: 0, right: 50 }, { left: 50, right: 100 }];
  const area = { left: 0, right: 100 };
  const label = (kind, column, value, cx, width) => ({ column, kind, value, cx, width, top: 100, height: 12 });

  const slid = placeLabels([label('low', 0, 36, 47, 20), label('low', 1, 34, 53, 20)], columns, area);
  assert.deepEqual(slid.map((l) => l.visible), [true, true]);
  assert.ok(slid[0].cx + slid[0].width / 2 <= 50 && slid[1].cx - slid[1].width / 2 >= 50, 'each inside its own column');

  const lows = placeLabels([label('low', 0, 36, 47, 70), label('low', 1, 34, 53, 70)], columns, area);
  assert.deepEqual(lows.map((l) => l.visible), [false, true], 'the lower low stays');
  const highs = placeLabels([label('high', 0, 50, 47, 70), label('high', 1, 48, 53, 70)], columns, area);
  assert.deepEqual(highs.map((l) => l.visible), [true, false], 'the higher high stays');
});

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 2, 10, 22, 53);
const MIDNIGHT = Date.UTC(2026, 2, 10);
const nowX = columnPosition(0, 22 + 53 / 60);
const chartTheme = { backgroundColor: '#000', textColor: '#fff', dividerColor: '#333', rtl: false };

/**
 * A card with the intraday line on, fed through `set hass` and the forecast
 * subscriptions as Home Assistant would. `history` is what `callWS` returns.
 */
async function intradayCard(t, forecast, history) {
  t.mock.method(Date, 'now', () => NOW);
  const errors = t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  const callbacks = {};
  const historyCalls = [];
  const card = makeCard({ forecast: { type: 'daily', intraday_line: true, ...forecast } });
  card.drawChart = () => {};
  card.hass = {
    states: {
      'weather.home': { state: 'cloudy', last_updated: new Date(NOW - 5 * 60 * 1000).toISOString(), attributes: { temperature: 12, temperature_unit: '°C', supported_features: 3 } },
      'sensor.owm': { state: 'ok', attributes: { daily: [3, 4, 5].map((day) => owmDay(noonUtc(10 + day), [5, 10, 8, 6], 4, 11)) } },
    },
    config: { time_zone: 'UTC', unit_system: { length: 'km', temperature: '°C' } },
    callWS: (message) => { historyCalls.push(message); return history(); },
    connection: { subscribeMessage(callback, message) {
      callbacks[message.forecast_type] = callback;
      return Promise.resolve(() => {});
    } },
  };
  await new Promise((resolve) => setImmediate(resolve));
  callbacks.daily({ forecast: Array.from({ length: 8 }, (_, i) => ({ datetime: new Date(MIDNIGHT + (24 * i + 12) * HOUR).toISOString(), temperature: 14, templow: 4, precipitation: 0 })) });
  callbacks.hourly({ forecast: Array.from({ length: 48 }, (_, k) => ({ datetime: new Date(MIDNIGHT + (23 + k) * HOUR).toISOString(), temperature: 9 })) });
  const line = card.computeForecastData().intraday;
  return { card, line, errors, historyCalls, parts: [...new Set(line.map((p) => p.part))] };
}

const recordedToday = () => Promise.resolve({ 'weather.home': Array.from({ length: 23 }, (_, h) => ({ s: 'cloudy', a: { temperature: 5 + h / 4 }, lu: (MIDNIGHT + h * HOUR) / 1000 })) });

test('#2 criterion 4: without intraday_line the chart keeps its high, low and precipitation datasets and its axes', () => {
  const card = makeCard({ forecast: { type: 'daily' } }, { states: { 'weather.home': { state: 'sunny', attributes: { temperature: 10, temperature_unit: '°C' } } } });
  card.forecasts = [{ datetime: '2026-03-10T12:00:00Z', temperature: 14, templow: 4, precipitation: 1 }];
  const chart = card.buildChartConfig(chartTheme);
  assert.deepEqual(chart.data.datasets.map((d) => [d.label, d.type]), [[card.ll('tempHi'), 'line'], [card.ll('tempLo'), 'line'], [card.ll('precip'), 'bar']]);
  assert.deepEqual(Object.keys(chart.options.scales), ['x', 'TempAxis', 'PrecipAxis']);
});

test('#2 criterion 5: with intraday_line the high and low lines give way to the three parts of one line', async (t) => {
  const { card } = await intradayCard(t, { intraday_entity: 'sensor.owm', temperature1_color: 'orange', temperature2_color: 'blue' }, recordedToday);
  const datasets = card.buildChartConfig(chartTheme).data.datasets;
  assert.ok(!datasets.some((d) => d.label === card.ll('tempHi') || d.label === card.ll('tempLo')), 'no high or low line');
  assert.equal(datasets.filter((d) => d.type === 'bar' && d.label === card.ll('precip')).length, 1);
  const lines = datasets.filter((d) => d.type === 'line');
  assert.deepEqual(lines.map((d) => d.data.at(-1).part), ['actual', 'hourly', 'fourADay']);
  assert.deepEqual(lines.map((d) => [d.borderColor, d.borderDash.length > 0]), [['orange', false], ['blue', false], ['blue', true]]);
});

test('#2 a dotted guide marks the high and low of each day across its own column, under the line', async (t) => {
  const { card, line } = await intradayCard(t, { intraday_entity: 'sensor.owm' }, recordedToday);
  const plugin = card.buildChartConfig(chartTheme).plugins.find((p) => p.id === 'intradayLabels');
  const strokes = [];
  let dash = [];
  let segment;
  const ctx = {
    save() {}, restore() {}, beginPath() { segment = []; },
    setLineDash(d) { dash = d; },
    moveTo(x, y) { segment.push([x, y]); },
    lineTo(x, y) { segment.push([x, y]); },
    stroke() { strokes.push({ segment, dash, color: ctx.strokeStyle }); },
  };
  const chart = {
    ctx,
    data: { labels: Array(8).fill('') },
    scales: { intradayX: { getPixelForValue: (v) => 100 * v + 50 }, TempAxis: { getPixelForValue: (v) => 300 - 10 * v } },
  };
  plugin.beforeDatasetsDraw(chart);

  const expected = dayLabels(line, 8, {}).map(({ column, point }) => [100 * column + 3, 100 * column + 97, 300 - 10 * point.y]);
  assert.ok(expected.length >= 8, 'a high and a low for several days');
  assert.deepEqual(strokes.map(({ segment: [[x1, y1], [x2, y2]] }) => { assert.equal(y1, y2, 'horizontal'); return [x1, x2, y1]; }), expected);
  assert.ok(strokes.every((s) => s.dash.length > 0 && s.color === chartTheme.textColor), 'dotted, in the theme text colour');
});

for (const [criterion, forecast] of [['#2 criterion 8: with no intraday_entity', {}], ['#2 criterion 9: with an intraday_entity that does not exist', { intraday_entity: 'sensor.missing' }]]) {
  test(`${criterion}, the line covers today until now and the 48 hourly hours`, async (t) => {
    const { card, line, errors, parts } = await intradayCard(t, forecast, recordedToday);
    assert.deepEqual(parts, ['actual', 'hourly']);
    assert.equal(line[0].x, -0.5, 'from midnight today');
    near(line.filter((p) => p.part === 'actual').at(-1).x, nowX, 'actual until now');
    const hourly = line.filter((p) => p.part === 'hourly');
    assert.equal(hourly.length, 48);
    near(hourly.at(-1).x, columnPosition(2, 22), 'hourly for 48 hours');
    card.buildChartConfig(chartTheme);
    assert.equal(errors.mock.callCount(), 0);
  });
}

test('#2 the weather entity history is read once, from local midnight, including attribute-only changes', async (t) => {
  const { historyCalls, line } = await intradayCard(t, {}, recordedToday);
  assert.deepEqual(historyCalls, [{
    type: 'history/history_during_period',
    start_time: '2026-03-10T00:00:00.000Z',
    entity_ids: ['weather.home'],
    include_start_time_state: true,
    significant_changes_only: false,
    minimal_response: false,
    no_attributes: false,
  }]);
  // 23 recorded hours and the reading at now.
  assert.equal(line.filter((p) => p.part === 'actual').length, 24);
});

for (const [name, history] of [['empty', () => Promise.resolve({})], ['failing', () => Promise.reject(new Error('Unknown command.'))]]) {
  test(`#2 criterion 10: with ${name} history the line starts at now and the card still draws`, async (t) => {
    const { card, line, errors, parts } = await intradayCard(t, { intraday_entity: 'sensor.owm' }, history);
    assert.equal(line[0].part, 'actual');
    near(line[0].x, nowX, 'now');
    assert.deepEqual(parts, ['actual', 'hourly', 'fourADay']);
    card.buildChartConfig(chartTheme);
    assert.equal(errors.mock.callCount(), 0);
  });
}
