import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const localeSource = readFileSync(new URL('../src/locale.js', import.meta.url), 'utf8');
const { default: locale } = await import('data:text/javascript;base64,' + Buffer.from(localeSource).toString('base64'));
const bundle = readFileSync(new URL('../dist/weather-chart-card-ha.js', import.meta.url), 'utf8');
let browser;
before(async () => {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });
});
after(async () => { await browser?.close(); });

test('Hebrew covers every existing translation and unit, including Auto', () => {
  for (const key of Object.keys(locale.en)) assert.ok(locale.he[key], key);
  for (const key of Object.keys(locale.en.units)) assert.ok(locale.he.units[key], key);
  for (const strings of Object.values(locale)) {
    assert.ok(strings.daily);
    assert.ok(strings.hourly);
    assert.ok(strings.auto);
  }
});

for (const width of [390, 1200]) {
  for (const language of ['en', 'he-IL', 'zh-Hant']) {
    test('shipped card: ' + language + ', width ' + width, async () => {
      const direction = language.startsWith('he') ? 'rtl' : 'ltr';
      const strings = locale[language] || locale[language.split('-')[0]];
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      const errors = [];
      page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
      try {
        await page.clock.setFixedTime(new Date('2026-10-18T12:00:00Z'));
        await page.route('**/*', route => {
          const path = new URL(route.request().url()).pathname;
          if (path === '/card.js') return route.fulfill({ contentType:'text/javascript', body:bundle });
          if (path === '/') return route.fulfill({ contentType:'text/html', body:'<!doctype html><html dir="' + direction + '" style="--direction:' + direction + '"><meta charset="utf-8"><style>body{margin:0}weather-chart-card-ha{display:block;max-width:600px;margin:auto}ha-card{display:block;background:#fff}</style><script src="/card.js"></script></html>' });
          return route.abort();
        });
        await page.goto('http://rtl.test/');
        await page.evaluate(({ language }) => {
          const card = document.createElement('weather-chart-card-ha');
          const forecasts = Array.from({length:5}, (_, i) => ({
            datetime: new Date(Date.UTC(2026, 9, 18 + i, 12)).toISOString(),
            temperature: 24, templow: 17, condition: 'sunny', precipitation: 2.5,
            precipitation_probability: 65, wind_speed: 15, wind_bearing: 90,
          }));
          const hass = {
            language, config: { time_zone:'UTC', unit_system:{ temperature:'\u00b0C', length:'km', wind_speed:'km/h', pressure:'hPa' } },
            states: { 'weather.home': { state:'sunny', last_changed:'2026-10-18T11:00:00Z', attributes:{
              temperature:-3, temperature_unit:'\u00b0C', humidity:65,
              pressure:1000, pressure_unit:'hPa', dew_point:-5, uv_index:4.2,
              visibility:10, visibility_unit:'km', wind_speed:15,
              wind_speed_unit:'km/h', wind_gust_speed:30, wind_bearing:90, supported_features:3,
            } } },
            connection: { subscribeMessage(callback) {
              setTimeout(() => callback({forecast:forecasts}), 0);
              return Promise.resolve(() => {});
            } },
          };
          card.setConfig({
            entity:'weather.home', title:'Weather', animated_icons:false,
            show_time:true, show_day:true, show_date:true, show_forecast_toggle:true,
            show_dew_point:true, show_visibility:true, show_wind_gust_speed:true, show_sun:false,
            units:{temperature:'\u00b0F', pressure:'mmHg', speed:'mph', visibility:'mi'},
            forecast:{condition_icons:false, disable_animation:true, show_probability:true},
          });
          card.hass = hass;
          document.body.append(card);
          window.fixture = {card, hass};
        }, {language});
        await page.waitForFunction(() => window.fixture.card.forecastChart, null, {timeout:10000});
        const result = await page.evaluate(() => {
          const card = window.fixture.card;
          card.updateClock();
          const root = card.shadowRoot;
          const rain = card.forecastChart.data.datasets[2];
          const directions = Object.fromEntries(['current-temp', 'water-percent', 'pressure', 'dew-point', 'visibility', 'uv-index', 'wind-speed-attribute', 'wind-gust-speed', 'attributes', 'chart-container', 'date-text'].map(name => [name, getComputedStyle(root.querySelector('.' + name)).direction]));
          const text = name => root.querySelector('.' + name).textContent.trim();
          return {
            directions, day:card.getLocalizedDayName(new Date('2026-10-18T12:00:00Z'), 'UTC'),
            zonedDay:card.getLocalizedDayName(new Date('2026-10-18T23:30:00Z'), 'Asia/Jerusalem'),
            date:root.querySelector('.date-text.date').textContent,
            humidity:text('water-percent'), pressure:text('pressure'), dewPoint:text('dew-point'),
            wind:text('wind-speed-attribute'), gust:text('wind-gust-speed'), visibility:text('visibility'),
            rainLabel:rain.datalabels.formatter(2.5, {dataset:rain, dataIndex:0}),
            overflow:document.documentElement.scrollWidth > innerWidth,
          };
        });
        for (const [name, actual] of Object.entries(result.directions)) {
          assert.equal(actual, ['attributes', 'date-text'].includes(name) ? direction : 'ltr', name);
        }
        const weekday = direction === 'rtl' ? 'long' : 'short';
        const formatDay = (date, timeZone) => new Intl.DateTimeFormat(language, {weekday, timeZone}).format(new Date(date)).replace(/[.\s]+$/u, '');
        const expectedDay = formatDay('2026-10-18T12:00:00Z', 'UTC');
        assert.equal(result.day, direction === 'rtl' ? expectedDay : expectedDay.toLocaleUpperCase(language));
        const zonedDay = formatDay('2026-10-18T23:30:00Z', 'Asia/Jerusalem');
        assert.equal(result.zonedDay, direction === 'rtl' ? zonedDay : zonedDay.toLocaleUpperCase(language));
        assert.equal(result.date, new Intl.DateTimeFormat(language, {day:'numeric', month:'long', timeZone:'UTC'}).format(new Date('2026-10-18T12:00:00Z')));
        assert.equal(result.humidity, '65 %');
        assert.equal(result.pressure, '750 ' + strings.units.mmHg);
        assert.equal(result.dewPoint, '23 \u00b0F');
        assert.equal(result.wind, '9 ' + strings.units.mph);
        assert.equal(result.gust, '19 ' + strings.units.mph);
        assert.equal(result.visibility, '6.2 mi');
        assert.equal(result.overflow, false);
        const lines = result.rainLabel.split('\n');
        assert.ok(lines.includes(''), 'preserve blank line between rain and probability');
        for (const line of lines.filter(Boolean)) {
          if (direction === 'rtl') assert.match(line, /^\u202B.*\u202C$/);
          else assert.doesNotMatch(line, /[\u202B\u202C]/);
        }
        const toggle = page.locator('weather-chart-card-ha .forecast-toggle');
        assert.equal((await toggle.textContent()).trim(), strings.hourly);
        await toggle.click();
        await page.waitForFunction(() => window.fixture.card.config.forecast.type === 'hourly');
        assert.equal((await toggle.textContent()).trim(), strings.daily);
        await toggle.click();
        await page.waitForFunction(() => window.fixture.card.config.forecast.type === 'daily');
        assert.equal((await toggle.textContent()).trim(), strings.hourly);
        if (direction === 'rtl') {
          const fallback = await page.evaluate(() => {
            const card = window.fixture.card;
            card.config.locale = 'he-invalid!'; // Force Intl to use the translation fallback.
            return card.getLocalizedDayName(new Date('2026-10-18T12:00:00Z'), 'UTC');
          });
          assert.equal(fallback, strings.days[0]);
        }
        await page.evaluate(async () => {
          const card = window.fixture.card;
          card.config = {...card.config, locale:undefined, show_main:false};
          await card.updateComplete;
        });
        assert.equal(await page.locator('weather-chart-card-ha .attributes').count(), 0);
        assert.equal(await toggle.count(), 1);
        await page.evaluate(async () => {
          const card = window.fixture.card;
          card.config = {...card.config, forecast:{...card.config.forecast, auto_rotate:10}};
          await card.updateComplete;
        });
        // Auto-rotate keeps the manual label and button, marked with an icon.
        assert.equal((await toggle.textContent()).trim(), strings.hourly);
        assert.equal(await toggle.isDisabled(), false);
        assert.equal(await toggle.getAttribute('title'), strings.auto);
        assert.equal(await page.locator('weather-chart-card-ha .forecast-toggle .auto-rotate-icon').count(), 1);
        await toggle.click();
        await page.waitForFunction(() => window.fixture.card.config.forecast.type === 'hourly');
        assert.equal((await toggle.textContent()).trim(), strings.daily);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

for (const direction of ['ltr', 'rtl']) {
  for (const intraday of [false, true]) {
    test((intraday ? 'the rain band replaces the bars and the line centres on its day columns: ' : 'rain bars centre on their day columns: ') + direction, async () => {
      const page = await browser.newPage({ viewport: { width: 440, height: 844 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.clock.setFixedTime(new Date('2026-10-18T15:00:00Z'));
        await page.route('**/*', route => {
          const path = new URL(route.request().url()).pathname;
          if (path === '/card.js') return route.fulfill({ contentType:'text/javascript', body:bundle });
          if (path === '/') return route.fulfill({ contentType:'text/html', body:'<!doctype html><html dir="' + direction + '"><meta charset="utf-8"><style>body{margin:0}weather-chart-card-ha{display:block}ha-card{display:block;background:#fff}</style><script src="/card.js"></script></html>' });
          return route.abort();
        });
        await page.goto('http://bars.test/');
        await page.evaluate(({ intraday }) => {
          const card = document.createElement('weather-chart-card-ha');
          const daily = Array.from({length:6}, (_, i) => ({
            datetime: new Date(Date.UTC(2026, 9, 18 + i, 12)).toISOString(),
            temperature: 20 + i, templow: 10 + i, condition: 'rainy', precipitation: 1 + i,
          }));
          const hourly = Array.from({length:48}, (_, i) => ({
            datetime: new Date(Date.UTC(2026, 9, 18, 16 + i)).toISOString(), temperature: 15 + 5 * Math.sin(i / 4),
          }));
          const hass = {
            language:'en', config: { time_zone:'UTC', unit_system:{ temperature:'°C', length:'km', wind_speed:'km/h', pressure:'hPa' } },
            states: { 'weather.home': { state:'rainy', last_updated:'2026-10-18T14:50:00Z', last_changed:'2026-10-18T14:50:00Z', attributes:{
              temperature:18, temperature_unit:'°C', humidity:65, pressure:1000, pressure_unit:'hPa', wind_speed:15, wind_speed_unit:'km/h', wind_bearing:90, supported_features:3,
            } } },
            callWS: () => Promise.resolve({}),
            connection: { subscribeMessage(callback, message) {
              setTimeout(() => callback({forecast: message.forecast_type === 'hourly' ? hourly : daily}), 0);
              return Promise.resolve(() => {});
            } },
          };
          card.setConfig({ entity:'weather.home', forecast:{ type:'daily', condition_icons:false, disable_animation:true, intraday_line:intraday } });
          card.hass = hass;
          document.body.append(card);
          window.fixture = {card};
        }, { intraday });
        await page.waitForFunction(({ intraday }) => {
          const chart = window.fixture.card.forecastChart;
          return chart && (!intraday || chart.scales.intradayX);
        }, { intraday }, {timeout:10000});
        const result = await page.evaluate(() => {
          const chart = window.fixture.card.forecastChart;
          const rain = chart.data.datasets.findIndex(d => d.key === 'precip');
          const x = chart.scales.x;
          const columnWidth = Math.abs(x.getPixelForValue(1) - x.getPixelForValue(0));
          return {
            bars: rain < 0 ? [] : chart.getDatasetMeta(rain).data.map((bar, k) => ({ offCentre: bar.x - x.getPixelForValue(k), width: bar.width })),
            expectedWidth: rain < 0 ? 0 : columnWidth * chart.data.datasets[rain].barPercentage,
            lineOffsets: chart.scales.intradayX ? chart.data.labels.map((_, k) => chart.scales.intradayX.getPixelForValue(k) - x.getPixelForValue(k)) : [],
          };
        });
        assert.equal(result.bars.length, intraday ? 0 : 6);
        for (const bar of result.bars) {
          assert.ok(Math.abs(bar.offCentre) < 1, 'bar centred on its column: ' + JSON.stringify(bar));
          assert.ok(Math.abs(bar.width - result.expectedWidth) < 1, 'bar keeps its full width: ' + JSON.stringify(bar));
        }
        assert.equal(result.lineOffsets.length, intraday ? 6 : 0);
        for (const offset of result.lineOffsets) assert.ok(Math.abs(offset) < 1, 'line column centre matches the day column: ' + offset);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}
