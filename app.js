'use strict';
/* Путь лозы — карманный справочник. Работает без интернета; погода обновляется, когда есть сеть. */

// ---------- утилиты ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => isoDate(new Date());
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const fmtDate = iso => { const d = new Date(iso + 'T12:00'); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const fmtT = v => v == null || isNaN(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v)) + '°';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const srcLabel = r => r.gen ? '<span class="src">общая практика</span>' : r.ext ? '<span class="src">другие источники</span>' : r.src ? `<span class="src">книга, с. ${r.src}</span>` : '';

const LS = {
  get(k, d) { try { const v = localStorage.getItem('loza.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('loza.' + k, JSON.stringify(v)); } catch (e) { toast('Не удалось сохранить: память браузера недоступна'); } }
};

// ---------- база на устройстве (фото, журнал, кусты) ----------
const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      let req;
      try { req = indexedDB.open('lozadb', 1); } catch (e) { return rej(e); }
      req.onupgradeneeded = () => {
        const d = req.result;
        ['photos', 'journal', 'bushes'].forEach(s => { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); });
      };
      req.onsuccess = () => { this.db = req.result; res(this.db); };
      req.onerror = () => rej(req.error);
    });
  },
  async tx(store, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode); const s = t.objectStore(store);
      const r = fn(s); t.oncomplete = () => res(r && r.result !== undefined ? r.result : r); t.onerror = () => rej(t.error);
    });
  },
  all(store) { return this.tx(store, 'readonly', s => s.getAll()).catch(() => []); },
  put(store, obj) { return this.tx(store, 'readwrite', s => s.put(obj)); },
  del(store, id) { return this.tx(store, 'readwrite', s => s.delete(id)); },
  clear(store) { return this.tx(store, 'readwrite', s => s.clear()); }
};

// ---------- состояние ----------
const DEFAULT_SETTINGS = { place: 'Засосна (Белгородская обл.)', lat: 50.6307, lon: 38.3965, ages: ['adult'], stage: 'auto' };
let settings = Object.assign({}, DEFAULT_SETTINGS, LS.get('settings', {}));
const year = new Date().getFullYear();
let flags = LS.get('flags', {});
if (flags.year !== year) flags = { year, opened: false, harvested: false, covered: false, frost: false };
let checks = LS.get('checks', {});
let wxRaw = LS.get('wx', null);
let manualWx = LS.get('manualWx', null);
let tab = LS.get('tab', 'today');
let sub = null;          // подраздел во вкладке «Ещё»
let worksStage = null;
let pickedSigns = new Set();
let bushes = [], journal = [], photos = [];

function saveSettings() { LS.set('settings', settings); }
function saveFlags() { LS.set('flags', flags); }

// ---------- погода ----------
function weatherUrls() {
  const { lat, lon } = settings;
  const f = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,precipitation_probability_max,wind_speed_10m_max' +
    '&hourly=soil_temperature_6cm,soil_temperature_18cm,soil_temperature_54cm,soil_moisture_3_to_9cm' +
    '&wind_speed_unit=ms&timezone=Europe%2FMoscow&past_days=31&forecast_days=16';
  const end = new Date(Date.now() - 6 * 864e5);
  const a = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${year}-04-01&end_date=${isoDate(end)}&daily=temperature_2m_mean,temperature_2m_min&timezone=Europe%2FMoscow`;
  return { f, a };
}

async function fetchJSON(url, ms = 20000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}

async function refreshWeather(silent) {
  if (!navigator.onLine && !silent) { toast('Нет интернета — показываю сохранённую погоду'); return; }
  const { f, a } = weatherUrls();
  try {
    const fc = await fetchJSON(f);
    let ar = null;
    if (new Date() > new Date(`${year}-04-08`)) { try { ar = await fetchJSON(a); } catch (e) { ar = null; } }
    wxRaw = { at: Date.now(), lat: settings.lat, lon: settings.lon, fc, ar };
    LS.set('wx', wxRaw);
    if (!silent) toast('Погода обновлена');
    render();
  } catch (e) {
    if (!silent) toast('Не удалось обновить погоду: ' + (e.name === 'AbortError' ? 'нет ответа' : e.message));
  }
}

// Сводка погоды для правил
function weatherSummary() {
  const today = todayISO();
  const out = { src: null, days: [], today: null };
  if (wxRaw && wxRaw.fc && wxRaw.fc.daily) {
    const d = wxRaw.fc.daily, h = wxRaw.fc.hourly || {};
    const days = d.time.map((t, i) => ({ date: t, tmax: d.temperature_2m_max[i], tmin: d.temperature_2m_min[i], tmean: d.temperature_2m_mean ? d.temperature_2m_mean[i] : (d.temperature_2m_max[i] + d.temperature_2m_min[i]) / 2, rain: d.precipitation_sum[i], prob: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null, wind: d.wind_speed_10m_max ? d.wind_speed_10m_max[i] : null }));
    const idx = days.findIndex(x => x.date === today);
    if (idx >= 0) {
      out.src = 'forecast';
      out.days = days;
      out.idx = idx;
      const td = days[idx];
      const soil = key => { if (!h.time || !h[key]) return null; const v = h.time.map((t, i) => t.startsWith(today) ? h[key][i] : null).filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
      const next7 = days.slice(idx, idx + 7);
      const past = days.slice(Math.max(0, idx - 3), idx);
      let frost7 = null, frostDay = null;
      next7.forEach(x => { if (x.tmin != null && (frost7 === null || x.tmin < frost7)) { frost7 = x.tmin; frostDay = x.date; } });
      const tomorrow = days[idx + 1];
      const rainy = x => x && ((x.rain ?? 0) >= 1 || (x.prob ?? 0) >= 60);
      // сумма активных температур (≥ +10 °C) с 1 апреля
      const map = new Map();
      if (wxRaw.ar && wxRaw.ar.daily) wxRaw.ar.daily.time.forEach((t, i) => map.set(t, { tmean: wxRaw.ar.daily.temperature_2m_mean[i], tmin: wxRaw.ar.daily.temperature_2m_min[i] }));
      days.slice(0, idx + 1).forEach(x => map.set(x.date, { tmean: x.tmean, tmin: x.tmin }));
      let sat = 0, satFrom = null, autumnFrost = false;
      [...map.keys()].sort().forEach(k => {
        const v = map.get(k); if (k < `${year}-04-01` || k > today) return;
        if (!satFrom) satFrom = k;
        if (v.tmean != null && v.tmean >= 10) sat += v.tmean;
        if (k >= `${year}-09-01` && v.tmin != null && v.tmin <= 0) autumnFrost = true;
      });
      Object.assign(out, {
        today: td, tmean: td.tmean, tmin: td.tmin, tmax: td.tmax, windToday: td.wind ?? 0,
        soil6: soil('soil_temperature_6cm'), soil18: soil('soil_temperature_18cm'), soil54: soil('soil_temperature_54cm'),
        frost7, frostDay, rainSoon: rainy(td) || rainy(tomorrow),
        wet3: past.reduce((s, x) => s + (x.rain || 0), 0) >= 5 && (td.tmean ?? 0) >= 15,
        nightMin7: Math.min(...next7.map(x => x.tmin ?? 99)),
        dayMax7: next7.reduce((s, x) => s + (x.tmax ?? 0), 0) / next7.length,
        sat: map.size && satFrom ? Math.round(sat) : null, satFrom, satFull: !!(wxRaw.ar && satFrom === `${year}-04-01`),
        autumnFrost, age: Date.now() - wxRaw.at
      });
    } else out.stale = true;
  }
  if (!out.src && manualWx && manualWx.date === today) {
    Object.assign(out, { src: 'manual', tmean: manualWx.tmean, tmin: manualWx.tmin, tmax: manualWx.tmax ?? manualWx.tmean, soil18: manualWx.soil ?? null, soil6: null,
      frost7: manualWx.frost ? -1 : null, frostDay: null, rainSoon: !!manualWx.rain, windToday: manualWx.wind ? 6 : 0, wet3: false,
      nightMin7: manualWx.tmin, dayMax7: manualWx.tmax ?? manualWx.tmean, sat: null });
  }
  return out;
}

// ---------- этап сезона ----------
function autoStage(w) {
  const d = new Date(), m = d.getMonth() + 1, day = d.getDate();
  const frostHappened = flags.frost || (w && w.autumnFrost);
  if (m === 12 || m <= 2) return flags.covered || m !== 12 ? 'winter' : 'cover';
  if (m >= 3 && m <= 5) return flags.opened ? 'spring' : 'preopen';
  if (m === 6 || m === 7) return 'summer';
  if (m === 8) return flags.harvested ? 'autumn' : 'ripening';
  if (m === 9) return (flags.harvested || day >= 15) ? (frostHappened ? 'cover' : 'autumn') : 'ripening';
  if (m >= 10) { if (flags.covered) return 'winter'; return frostHappened || (m === 10 && day >= 20) || m === 11 ? 'cover' : 'autumn'; }
  return 'summer';
}
function currentStage(w) { return settings.stage && settings.stage !== 'auto' ? settings.stage : autoStage(w); }

async function effectiveAges() {
  if (bushes.length) {
    const s = new Set(bushes.map(b => ageOf(b)).filter(Boolean));
    if (s.size) return s;
  }
  return new Set(settings.ages && settings.ages.length ? settings.ages : ['adult']);
}
function ageOf(b) {
  if (!b.year) return 'adult';
  const n = year - Number(b.year) + (new Date().getMonth() >= 2 ? 0 : -1);
  return n <= 0 ? 'a1' : n === 1 ? 'a2' : n === 2 ? 'a3' : 'adult';
}

// динамические подсказки к правилам
function dynText(key, w) {
  if (!w || !w.src) return 'Нет данных о погоде — обновите при наличии сети или введите вручную.';
  if (key === 'openReady') {
    const okSoil = w.soil18 != null ? w.soil18 >= 10 : null, okNight = w.nightMin7 >= 5, okDay = w.dayMax7 >= 12;
    const mark = v => v == null ? '?' : v ? '✔' : '✘';
    return `${mark(okSoil)} почва на 18 см: ${fmtT(w.soil18)} (нужно +10°) · ${mark(okNight)} ночи на неделю: мин ${fmtT(w.nightMin7)} (нужно не ниже +5°) · ${mark(okDay)} дни: ~${fmtT(w.dayMax7)} (нужно +10…+15°)` +
      (okSoil && okNight && okDay ? ' → по погоде можно открывать.' : ' → рано.');
  }
  if (key === 'frostDay') return w.frostDay ? `Минимум ${fmtT(w.frost7)} — ${fmtDate(w.frostDay)} (${WD[new Date(w.frostDay + 'T12:00').getDay()]}).` : '';
  if (key === 'pruneWindow') {
    const list = (w.days || []).slice(w.idx, w.idx + 16).filter(x => x.tmin <= -1 && x.tmin >= -5).map(x => fmtDate(x.date));
    const hard = (w.days || []).slice(w.idx, w.idx + 16).filter(x => x.tmin < -5).map(x => fmtDate(x.date));
    return (list.length ? 'Подходящие ночи (−1…−5°): ' + list.join(', ') + '.' : 'В прогнозе пока нет ночей −1…−5°.') + (hard.length ? ' Сильнее −5°: ' + hard.join(', ') + ' — успеть до них.' : '');
  }
  return '';
}

function rulesFor(stage, ages, w, withWeather = true) {
  return RULES.filter(r => r.stage.includes(stage))
    .filter(r => !r.ages || r.ages.some(a => ages.has(a)))
    .filter(r => !r.when || (withWeather && r.when({ w })))
    .filter(r => !r.noFrostYet || !(flags.frost || (w && w.autumnFrost)))
    .filter(r => !r.frostOnly || flags.frost || (w && w.autumnFrost));
}

// ---------- отрисовка ----------
const KIND = { warn: ['Внимание', 'k-warn'], do: ['Сделать', 'k-do'], check: ['Проверить', 'k-check'], dont: ['Не делать', 'k-dont'] };
const ORDER = { warn: 0, do: 1, check: 2, dont: 3 };

function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const v = $('#view');
  const fn = { today: viewToday, works: viewWorks, ill: viewIll, photo: viewPhoto, more: viewMore }[tab] || viewToday;
  Promise.resolve(fn()).then(html => { v.innerHTML = html; bind(); });
}

async function viewToday() {
  const w = weatherSummary();
  const stage = currentStage(w);
  const ages = await effectiveAges();
  const st = STAGES.find(s => s.id === stage);
  $('#hdrSub').textContent = `${settings.place} · ${fmtDate(todayISO())}`;
  let h = '';

  // погода
  h += '<div class="card">';
  if (w.src === 'forecast') {
    const ageH = Math.round(w.age / 36e5);
    h += `<div class="row" style="justify-content:space-between"><h2 style="margin:0">Погода сегодня</h2><button class="small ghost" data-act="wx">Обновить</button></div>
    <div class="muted small">Open-Meteo · обновлено ${ageH < 1 ? 'только что' : ageH < 48 ? ageH + ' ч назад' : Math.round(ageH / 24) + ' дн. назад'}</div>
    <div class="grid2" style="margin-top:8px">
      <div class="stat"><b>${fmtT(w.tmean)}</b><span>средняя за сутки</span></div>
      <div class="stat"><b>${fmtT(w.tmin)} / ${fmtT(w.tmax)}</b><span>ночь / день</span></div>
      <div class="stat"><b>${fmtT(w.soil6)} / ${fmtT(w.soil18)}</b><span>почва 6 / 18 см</span></div>
      <div class="stat"><b>${w.today.rain != null ? w.today.rain.toFixed(1) + ' мм' : '—'}</b><span>осадки${w.today.prob != null ? ', вероятность ' + w.today.prob + '%' : ''} · ветер ${w.windToday != null ? Math.round(w.windToday) + ' м/с' : '—'}</span></div>
    </div>`;
    h += '<h3>Прогноз</h3><div class="days">' + w.days.slice(w.idx, w.idx + 16).map(x => {
      const dd = new Date(x.date + 'T12:00');
      return `<div class="day ${x.tmin <= 0 ? 'frost' : ''}"><div class="small">${WD[dd.getDay()]} ${dd.getDate()}</div><div class="t">${fmtT(x.tmax)}</div><div class="small">${fmtT(x.tmin)}</div><div class="small">${x.rain >= 0.5 ? '☂ ' + x.rain.toFixed(0) : '&nbsp;'}</div></div>`;
    }).join('') + '</div>';
    if (w.sat != null) h += `<div class="muted small" style="margin-top:6px">Сумма активных температур (дни от +10°) ${w.satFull ? 'с 1 апреля' : 'с ' + fmtDate(w.satFrom) + ' (архив недоступен, сумма неполная)'}: <b>${w.sat}°</b></div>`;
    if (w.age > 7 * 864e5) h += '<div class="alert warn" style="margin-top:8px">Прогноз старше недели — обновите, когда появится сеть.</div>';
  } else {
    h += `<h2>Погода</h2>`;
    if (w.src === 'manual') h += `<div class="muted">Введено вручную: средняя ${fmtT(w.tmean)}, ночь ${fmtT(w.tmin)}${w.soil18 != null ? ', почва ' + fmtT(w.soil18) : ''}.</div>`;
    else h += `<div class="alert info">${w.stale ? 'Сохранённый прогноз закончился.' : 'Прогноза ещё нет.'} Обновите погоду, когда будет интернет, или введите данные вручную.</div>`;
    h += `<div class="sticky-actions"><button data-act="wx">Обновить погоду</button><button class="ghost" data-act="manual">Ввести вручную</button></div>`;
  }
  h += '</div>';

  // этап
  h += `<div class="card"><h2>Этап: ${esc(st.name)}</h2>
    <div class="muted small">${settings.stage === 'auto' ? 'Определён автоматически по дате, погоде и вашим отметкам.' : 'Выбран вручную.'} Нажмите, чтобы сменить:</div>
    <div class="chips" style="margin-top:6px"><button class="chip ${settings.stage === 'auto' ? 'on' : ''}" data-stage="auto">Авто</button>` +
    STAGES.map(s => `<button class="chip ${settings.stage === s.id ? 'on' : ''}" data-stage="${s.id}">${s.short}</button>`).join('') + '</div>';
  const fl = [];
  if (['preopen', 'spring'].includes(stage)) fl.push(['opened', 'Укрытие снято']);
  if (['ripening', 'autumn'].includes(stage)) fl.push(['harvested', 'Урожай снят']);
  if (['autumn', 'cover'].includes(stage)) fl.push(['frost', 'Заморозок уже был' + (w.autumnFrost ? ' (по погоде — да)' : '')]);
  if (['cover', 'winter'].includes(stage)) fl.push(['covered', 'Кусты укрыты']);
  if (fl.length) h += '<div class="chips" style="margin-top:8px">' + fl.map(([k, t]) => `<button class="chip ${flags[k] ? 'on' : ''}" data-flag="${k}">${flags[k] ? '✔ ' : ''}${t}</button>`).join('') + '</div>';
  h += `<div class="muted small" style="margin-top:8px">Возраст кустов: ${[...ages].map(a => AGES.find(x => x.id === a).name).join(', ')}${bushes.length ? ' (по списку кустов)' : ' — <a href="#" data-go="bushes">указать кусты</a>'}</div></div>`;

  // чек-лист
  const list = rulesFor(stage, ages, w).sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  const day = todayISO(); const done = checks[day] || {};
  const n = list.filter(r => r.kind !== 'warn' && r.kind !== 'dont').length, k = list.filter(r => done[r.id]).length;
  h += `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Чек-лист на сегодня</h2><span class="muted small">${k} из ${n}</span></div><ul class="check">` +
    list.map(r => {
      const d = done[r.id];
      const box = (r.kind === 'warn' || r.kind === 'dont') ? '<span style="width:22px;flex:0 0 22px;text-align:center">' + (r.kind === 'warn' ? '⚠' : '⛔') + '</span>' : `<input type="checkbox" data-chk="${r.id}" ${d ? 'checked' : ''}>`;
      return `<li class="${d ? 'done' : ''}">${box}<div><div class="tx"><span class="tag ${KIND[r.kind][1]}">${KIND[r.kind][0]}</span>${esc(r.text)}</div>` +
        (r.why ? `<div class="why">${esc(r.why)}</div>` : '') + (r.dyn ? `<div class="dyn">${esc(dynText(r.dyn, w))}</div>` : '') + srcLabel(r) + '</div></li>';
    }).join('') + '</ul><div class="muted small" style="margin-top:8px">Отмеченное попадает в журнал работ.</div></div>';
  return h;
}

function viewWorks() {
  const w = weatherSummary();
  const stage = worksStage || currentStage(w);
  let h = `<div class="card"><h2>Работы по этапам</h2><div class="chips">` + STAGES.map(s => `<button class="chip ${s.id === stage ? 'on' : ''}" data-ws="${s.id}">${s.short}</button>`).join('') + '</div></div>';
  const st = STAGES.find(s => s.id === stage);
  const list = RULES.filter(r => r.stage.includes(stage)).sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  h += `<div class="card"><h2>${esc(st.name)}</h2><ul class="check">` + list.map(r =>
    `<li><div><div><span class="tag ${KIND[r.kind][1]}">${KIND[r.kind][0]}</span>${r.ages ? '<span class="tag k-check">' + r.ages.map(a => AGES.find(x => x.id === a).name).join(', ') + '</span>' : ''}${r.when ? '<span class="tag k-warn">по погоде</span>' : ''}${esc(r.text)}</div>` +
    (r.why ? `<div class="why">${esc(r.why)}</div>` : '') + srcLabel(r) + '</div></li>').join('') + '</ul></div>';
  return h;
}

function diagnose() {
  return DISEASES.map(d => {
    let s = 0, max = 0;
    Object.entries(d.signs).forEach(([k, v]) => { max += v; if (pickedSigns.has(k)) s += v; });
    return { d, s, pct: max ? Math.round(100 * s / max) : 0 };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s || b.pct - a.pct);
}

function diseaseCard(d, open) {
  const li = a => a && a.length ? '<ul>' + a.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>' : '';
  const mine = photos.filter(p => p.diag === d.id);
  return `<details ${open ? 'open' : ''} id="d-${d.id}"><summary>${esc(d.name)} <span class="muted small">— ${esc(d.type)}</span></summary>
    <h3>Признаки</h3>${li(d.symptoms)}${d.diff ? `<div class="alert warn">${esc(d.diff)}</div>` : ''}
    ${d.cause ? '<h3>Причины</h3>' + li(d.cause) : ''}${d.prevent ? '<h3>Профилактика</h3>' + li(d.prevent) : ''}
    <h3>Лечение</h3>${li(d.treat)}${d.mix ? `<div class="muted small">${esc(d.mix)}</div>` : ''}
    ${mine.length ? '<h3>Мои фото с этим диагнозом</h3><div class="photos">' + mine.map(p => `<div class="ph" data-ph="${p.id}"><img alt="" data-src="${p.id}"></div>`).join('') + '</div>' : ''}
    <div style="margin-top:6px">${d.ext ? '<span class="src">Источники: ' + esc(d.sources.join('; ')) + '</span>' : `<span class="src">книга, с. ${d.src}</span>`}</div></details>`;
}

function viewIll() {
  let h = `<div class="card"><h2>Что вижу на кусте?</h2><div class="muted small">Отметьте признаки — сверху появятся подходящие варианты.</div>`;
  if (pickedSigns.size) {
    const res = diagnose();
    h += `<div class="alert info" style="margin-top:8px"><div class="row" style="justify-content:space-between"><b>Похоже на:</b><button class="small ghost" data-act="clearSigns">Сбросить</button></div>` +
      (res.length ? res.map((x, i) => `<div class="list-item"><a href="#d-${x.d.id}" data-open="${x.d.id}"><b>${esc(x.d.name)}</b></a> <span class="score">совпадение ${x.pct}%</span>${i === 0 && res[1] && res[1].s === x.s ? ' <span class="score">— варианты равны, сравните признаки</span>' : ''}</div>`).join('') : '<div>Нет совпадений.</div>') +
      '<div class="small" style="margin-top:6px">Это подсказка, а не диагноз. Сомневаетесь — сфотографируйте и разберите, когда будет сеть.</div></div>';
  }
  h += '<div class="chips" style="margin-top:8px">' + SIGNS.map(s => `<button class="chip ${pickedSigns.has(s.id) ? 'on' : ''}" data-sign="${s.id}">${esc(s.text)}</button>`).join('') + '</div>';
  h += '</div><div class="card"><h2>Справочник</h2>' + DISEASES.map(d => diseaseCard(d, false)).join('') + '</div>';
  return h;
}

async function viewPhoto() {
  photos = await DB.all('photos'); photos.sort((a, b) => b.at - a.at);
  const nNew = photos.filter(p => p.status !== 'done').length;
  let h = `<div class="card"><h2>Фото в поле</h2><div class="muted small">Снимайте лист (сверху и снизу), гроздь или побег. Фото хранятся на телефоне. Когда появится сеть — отправьте на разбор.</div>
    <div class="sticky-actions"><button data-act="shoot">📷 Сфотографировать</button></div></div>`;
  if (!photos.length) return h + '<div class="card muted">Фото пока нет.</div>';
  h += `<div class="card"><h2>Ждут разбора: ${nNew}</h2><div class="photos">` + photos.filter(p => p.status !== 'done').map(phThumb).join('') + '</div></div>';
  const doneP = photos.filter(p => p.status === 'done');
  if (doneP.length) h += `<div class="card"><h2>Разобраны: ${doneP.length}</h2><div class="photos">` + doneP.map(phThumb).join('') + '</div></div>';
  return h;
}
function phThumb(p) {
  const d = DISEASES.find(x => x.id === p.diag);
  return `<div class="ph" data-ph="${p.id}"><img alt="" data-src="${p.id}"><span class="badge">${fmtDate(isoDate(new Date(p.at)))}${d ? ' · ' + esc(d.name.split(' ')[0]) : ''}</span></div>`;
}

async function viewPhotoOne(id) {
  const p = photos.find(x => x.id === id) || (await DB.all('photos')).find(x => x.id === id);
  if (!p) return '<div class="card">Фото не найдено.</div>';
  const bOpts = '<option value="">—</option>' + bushes.map(b => `<option value="${b.id}" ${p.bush === b.id ? 'selected' : ''}>${esc(b.name)} (${esc(b.variety || '')})</option>`).join('');
  return `<div class="card"><button class="small ghost" data-act="back">← Назад</button>
    <img class="big-img" style="margin-top:8px" alt="" data-src="${p.id}">
    <div class="muted small" style="margin-top:6px">${new Date(p.at).toLocaleString('ru-RU')}</div>
    <label>Что на фото</label><select data-pf="part">${['Лист сверху', 'Лист снизу', 'Гроздь', 'Побег', 'Лоза', 'Другое'].map(x => `<option ${p.part === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
    <label>Куст</label><select data-pf="bush">${bOpts}</select>
    <label>Заметка</label><textarea rows="2" data-pf="note" placeholder="Что заметили, сколько кустов, где">${esc(p.note || '')}</textarea>
    <label>Диагноз</label><select data-pf="diag"><option value="">Не определено</option>${DISEASES.map(d => `<option value="${d.id}" ${p.diag === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}<option value="other" ${p.diag === 'other' ? 'selected' : ''}>Другое (в заметке)</option></select>
    <label>Статус</label><select data-pf="status"><option value="new" ${p.status !== 'done' ? 'selected' : ''}>Ждёт разбора</option><option value="done" ${p.status === 'done' ? 'selected' : ''}>Разобрано</option></select>
    <div class="sticky-actions">
      <button data-act="share" data-id="${p.id}">Отправить на разбор</button>
      <button class="ghost" data-act="toSigns">Определитель</button>
      <button class="ghost" data-act="dl" data-id="${p.id}">Сохранить файл</button>
      <button class="ghost" data-act="delPh" data-id="${p.id}">Удалить</button>
    </div>
    <div class="muted small" style="margin-top:8px">«Отправить на разбор» откроет меню «Поделиться»: выберите Claude или мессенджер. К фото приложится готовый вопрос.</div></div>`;
}
let openPhoto = null;
let sortPicks = {};      // выбранные признаки для определителя сорта
let sortFor = null;      // куст, для которого определяем сорт
let pendingVar = null;   // сорт, выбранный в определителе, для формы нового куста

function rankVarieties() {
  const keys = Object.keys(sortPicks);
  return Object.entries(VTRAITS).map(([n, t]) => {
    let s = 0, known = 0;
    keys.forEach(k => { const v = t[k]; if (v == null) { s += 0.4; } else { known++; if (v.includes(sortPicks[k])) s += 1; } });
    return { n, t, pct: keys.length ? Math.round(100 * s / keys.length) : 0, known };
  }).sort((a, b) => b.pct - a.pct || b.known - a.known);
}

function viewSort() {
  const b = sortFor ? bushes.find(x => x.id === sortFor) : null;
  let h = `<div class="card">${backBtn}<h2>Определить сорт${b ? ': ' + esc(b.name) : ''}</h2>
    <div class="muted small">Отметьте, что видите на зрелой грозди. Сравниваются 31 сорт из книги. Если вашего сорта в книге нет — совпадение будет низким у всех.</div>` +
    VFEATS.map(f => `<h3>${f.name}</h3><div class="chips">` + f.opts.map(([v, t]) => `<button class="chip ${sortPicks[f.id] === v ? 'on' : ''}" data-sf="${f.id}" data-sv="${v}">${esc(t)}</button>`).join('') + '</div>').join('') + '</div>';
  const n = Object.keys(sortPicks).length;
  if (n) {
    const res = rankVarieties().slice(0, 6);
    h += `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Похожие сорта</h2><button class="small ghost" data-act="clearSort">Сбросить</button></div>` +
      res.map(x => {
        const v = VARIETIES.find(y => y.n === x.n) || {};
        const ph = PHOTO_LINKS[x.n];
        return `<div class="list-item"><b>${esc(x.n)}</b> <span class="score">совпадение ${x.pct}%</span><div class="small">${esc(x.t.note)}</div><div class="muted small">${esc(v.g || '')} · созревание ${esc(v.ripen || '?')} дн. · мороз ${esc(v.frost || '?')} · книга, с. ${v.page}</div>` +
          `<div class="row" style="margin-top:4px;gap:6px"><button class="small ghost" data-pickvar="${esc(x.n)}">${b ? 'Записать этот сорт кусту' : 'Добавить куст с этим сортом'}</button>` +
          (ph ? `<a class="small" href="${esc(ph.url)}" target="_blank" rel="noopener">Фото у автора →</a>` : '') + '</div>' +
          (ph && ph.note ? `<div class="muted small">${esc(ph.note)}</div>` : '') + '</div>';
      }).join('') +
      `<div class="muted small" style="margin-top:8px">${n < 4 ? 'Отметьте больше признаков — выбор станет точнее. ' : ''}Это подсказка: у разных сортов бывают похожие грозди, а на молодых кустах ягоды мельче. Надёжнее всего — сравнить с фото сорта и с тем, что писал продавец саженцев.</div></div>`;
  }
  h += `<div class="card"><h2>Про листья</h2><div class="small">В книге листья описаны только у двух сортов («Гарольд» — светло-изумрудный пятилопастной с пушком снизу; «Юкка» — трёхлопастной, почти цельный), поэтому определять по листу приложение не берётся. Лист — хорошая подсказка для опытного глаза, но сфотографируйте лист сверху и снизу рядом с гроздью и отправьте на разбор, когда будет сеть.</div></div>`;
  return h;
}

function viewMore() {
  if (sub === 'feed') return viewFeed();
  if (sub === 'bushes') return viewBushes();
  if (sub === 'journal') return viewJournal();
  if (sub === 'vars') return viewVars();
  if (sub === 'settings') return viewSettings();
  if (sub === 'sort') return viewSort();
  return `<div class="card"><h2>Ещё</h2>
    ${[['feed', 'Подкормки и обработки', 'дозы, сроки, правила баковых смесей'], ['bushes', 'Мои кусты', 'сорт, год посадки — от них зависит чек-лист'], ['journal', 'Журнал работ', 'что и когда сделано'], ['sort', 'Определить сорт', 'по грозди и ягоде — какой сорт из книги похож'], ['vars', 'Сорта из книги', 'срок созревания, морозостойкость'], ['settings', 'Настройки и резервная копия', 'место, погода, перенос данных']]
      .map(([k, t, d]) => `<div class="list-item"><a href="#" data-go="${k}"><b>${t}</b></a><div class="muted small">${d}</div></div>`).join('')}</div>`;
}
const backBtn = '<button class="small ghost" data-go="">← Ещё</button>';

function viewFeed() {
  return `<div class="card">${backBtn}<h2>Подкормки и обработки</h2><table><tr><th>Когда</th><th>Что и доза</th></tr>` +
    FEEDING.map(f => `<tr><td>${esc(f.when)}</td><td><b>${esc(f.what)}</b><br>${esc(f.dose)} · ${esc(f.how)}<br><span class="src">книга, с. ${f.src}</span></td></tr>`).join('') +
    `</table></div><div class="card"><h2>Баковые смеси</h2><ol>${MIX_RULES.map(x => `<li>${esc(x)}</li>`).join('')}</ol><span class="src">общая практика; смесь «Ридомил Голд + Топаз + монофосфат калия» советуют авторы книги (с. 70)</span></div>`;
}

function viewBushes() {
  const vOpts = VARIETIES.map(v => `<option>${esc(v.n)}</option>`).join('');
  return `<div class="card">${backBtn}<h2>Мои кусты</h2>` +
    (bushes.length ? bushes.map(b => `<div class="list-item row" style="justify-content:space-between"><div style="flex:1"><b>${esc(b.name)}</b><select data-bvar="${b.id}" style="margin:4px 0">${VARIETIES.map(v => `<option ${v.n === b.variety ? 'selected' : ''}>${esc(v.n)}</option>`).join('')}</select>${b.variety === 'Сорт не известен' ? `<a href="#" data-sortfor="${b.id}">Определить сорт этого куста →</a>` : ''}<div class="muted small">посажен ${esc(b.year || '?')} · ${AGES.find(a => a.id === ageOf(b)).name}${b.note ? ' · ' + esc(b.note) : ''}</div></div><button class="small ghost" data-delbush="${b.id}">✕</button></div>`).join('') : '<div class="muted">Кустов пока нет. Без списка чек-лист считает все кусты взрослыми (можно поменять в настройках).</div>') +
    `</div><div class="card"><h2>Добавить куст</h2>
    <label>Номер или название</label><input id="bName" placeholder="Например: 1 ряд, 3 куст">
    <label>Сорт</label><select id="bVar">${VARIETIES.map(v => `<option ${v.n === pendingVar ? 'selected' : ''}>${esc(v.n)}</option>`).join('')}</select><div class="small"><a href="#" data-go="sort">Не знаете сорт? Определить по грозди</a></div>
    <label>Год посадки</label><input id="bYear" type="number" inputmode="numeric" value="${year}">
    <label>Заметка</label><input id="bNote">
    <div class="sticky-actions"><button data-act="addBush">Добавить</button></div></div>`;
}

function viewJournal() {
  const list = [...journal].sort((a, b) => (b.date + b.at).localeCompare(a.date + a.at));
  const bOpts = bushes.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  return `<div class="card">${backBtn}<h2>Новая запись</h2>
    <label>Дата</label><input id="jDate" type="date" value="${todayISO()}">
    <label>Работа</label><select id="jWork">${WORKS.map(x => `<option>${x}</option>`).join('')}</select>
    ${bushes.length ? `<label>Кусты (не выбрано — все)</label><select id="jBush" multiple size="${Math.min(5, bushes.length)}">${bOpts}</select>` : ''}
    <label>Препарат, доза</label><input id="jDrug" placeholder="Например: Топаз 6 г / 10 л">
    <label>Заметка</label><input id="jNote">
    <div class="sticky-actions"><button data-act="addJ">Записать</button></div></div>
    <div class="card"><h2>Журнал</h2>` +
    (list.length ? list.map(j => `<div class="list-item"><div class="row" style="justify-content:space-between"><b>${fmtDate(j.date)} · ${esc(j.work)}</b><button class="small ghost" data-delj="${j.id}">✕</button></div>
      ${j.drug ? `<div>${esc(j.drug)}</div>` : ''}${j.note ? `<div class="muted small">${esc(j.note)}</div>` : ''}${j.bushes && j.bushes.length ? `<div class="muted small">Кусты: ${j.bushes.map(id => esc((bushes.find(b => b.id === id) || {}).name || '?')).join(', ')}</div>` : ''}</div>`).join('') : '<div class="muted">Записей пока нет.</div>') + '</div>';
}

function viewVars() {
  const groups = [...new Set(VARIETIES.filter(v => v.g).map(v => v.g))];
  return `<div class="card">${backBtn}<h2>Сорта из книги</h2><div class="muted small">Срок — дней от распускания почек до зрелости. Морозостойкость — по данным книги.</div></div>` +
    groups.map(g => `<div class="card"><h3>${g}</h3><table><tr><th>Сорт</th><th>Срок</th><th>Мороз</th><th>с.</th></tr>` +
      VARIETIES.filter(v => v.g === g).map(v => {
        const ph = PHOTO_LINKS[v.n];
        return `<tr><td><b>${esc(v.n)}</b>${v.color ? `<div class="muted small">${esc(v.color)}</div>` : ''}${ph ? `<div class="small"><a href="${esc(ph.url)}" target="_blank" rel="noopener">фото у автора →</a></div>` : ''}</td><td>${esc(v.ripen)}</td><td>${esc(v.frost)}</td><td>${v.page}</td></tr>`;
      }).join('') + '</table></div>').join('');
}

function viewSettings() {
  return `<div class="card">${backBtn}<h2>Место</h2>
    <label>Название</label><input id="sPlace" value="${esc(settings.place)}">
    <div class="grid2"><div><label>Широта</label><input id="sLat" inputmode="decimal" value="${settings.lat}"></div><div><label>Долгота</label><input id="sLon" inputmode="decimal" value="${settings.lon}"></div></div>
    <div class="sticky-actions"><button data-act="savePlace">Сохранить и обновить погоду</button></div>
    <div class="muted small" style="margin-top:6px">По умолчанию — Засосна, Красногвардейский район Белгородской области (50,63° с. ш., 38,40° в. д.). Погода — Open-Meteo: воздух, почва на 6, 18 и 54 см, прогноз на 16 дней.</div></div>
    <div class="card"><h2>Возраст кустов (если список кустов пуст)</h2><div class="chips">${AGES.map(a => `<button class="chip ${settings.ages.includes(a.id) ? 'on' : ''}" data-age="${a.id}">${a.name}</button>`).join('')}</div></div>
    <div class="card"><h2>Резервная копия</h2><div class="muted small">Все данные живут только в этом телефоне. Делайте копию — её можно перенести на другой телефон или компьютер.</div>
    <div class="sticky-actions"><button data-act="export">Сохранить копию (без фото)</button><button class="ghost" data-act="exportPh">С фото</button><button class="ghost" data-act="import">Восстановить из файла</button></div></div>
    <div class="card"><h2>О справочнике</h2><div class="small">Основа — книга П. П. Данилюка и В. С. Мурыгина «Виноград. Путь лозы. Шпаргалка-трекер: от черенка до грозди» (АСТ, 2026). Номера страниц указаны у каждого пункта. Пункты «общая практика» и «другие источники» — не из книги. Справочник для личного пользования.</div>
    <div class="muted small" style="margin-top:6px">Версия 1.1</div></div>`;
}

// ---------- события ----------
function bind() {
  const v = $('#view');
  v.querySelectorAll('img[data-src]').forEach(async img => {
    const p = photos.find(x => x.id === img.dataset.src) || (await DB.all('photos')).find(x => x.id === img.dataset.src);
    if (p && p.blob) img.src = URL.createObjectURL(p.blob);
  });
}

document.addEventListener('click', async e => {
  const t = e.target.closest('button,a,[data-ph]');
  if (!t) return;
  const ds = t.dataset;
  if (t.closest('#tabs')) { tab = ds.tab; sub = null; openPhoto = null; LS.set('tab', tab); render(); window.scrollTo(0, 0); return; }
  if (ds.go !== undefined) { e.preventDefault(); tab = 'more'; sub = ds.go || null; if (ds.go === 'sort' && !t.closest('[data-sortfor]')) sortFor = null; render(); window.scrollTo(0, 0); return; }
  if (ds.stage) { settings.stage = ds.stage; saveSettings(); render(); return; }
  if (ds.flag) { flags[ds.flag] = !flags[ds.flag]; saveFlags(); render(); return; }
  if (ds.ws) { worksStage = ds.ws; render(); return; }
  if (ds.sign) { pickedSigns.has(ds.sign) ? pickedSigns.delete(ds.sign) : pickedSigns.add(ds.sign); render(); return; }
  if (ds.open) { e.preventDefault(); const d = document.getElementById('d-' + ds.open); if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth' }); } return; }
  if (ds.age) { const s = new Set(settings.ages); s.has(ds.age) ? s.delete(ds.age) : s.add(ds.age); settings.ages = [...s]; saveSettings(); render(); return; }
  if (ds.ph) { tab = 'photo'; openPhoto = ds.ph; $('#view').innerHTML = await viewPhotoOne(ds.ph); bind(); bindPhotoForm(ds.ph); window.scrollTo(0, 0); return; }
  if (ds.sf) { sortPicks[ds.sf] === ds.sv ? delete sortPicks[ds.sf] : sortPicks[ds.sf] = ds.sv; render(); return; }
  if (ds.sortfor) { e.preventDefault(); sortFor = ds.sortfor; sortPicks = {}; tab = 'more'; sub = 'sort'; render(); window.scrollTo(0, 0); return; }
  if (ds.pickvar) {
    if (sortFor) { const b = bushes.find(x => x.id === sortFor); if (b) { b.variety = ds.pickvar; await DB.put('bushes', b); bushes = await DB.all('bushes'); toast('Сорт записан: ' + ds.pickvar); } sortFor = null; }
    else pendingVar = ds.pickvar;
    sub = 'bushes'; render(); window.scrollTo(0, 0); return;
  }
  if (ds.delbush) { await DB.del('bushes', ds.delbush); bushes = await DB.all('bushes'); render(); return; }
  if (ds.delj) { await DB.del('journal', ds.delj); journal = await DB.all('journal'); render(); return; }
  const act = ds.act; if (!act) return;
  if (act === 'wx') refreshWeather(false);
  if (act === 'manual') manualEntry();
  if (act === 'clearSigns') { pickedSigns.clear(); render(); }
  if (act === 'clearSort') { sortPicks = {}; render(); }
  if (act === 'shoot') $('#fileInput').click();
  if (act === 'back') { openPhoto = null; render(); }
  if (act === 'toSigns') { tab = 'ill'; render(); }
  if (act === 'share') sharePhoto(ds.id);
  if (act === 'dl') { const p = photos.find(x => x.id === ds.id); if (p) download(p.blob, `vinograd_${isoDate(new Date(p.at))}_${p.id}.jpg`); }
  if (act === 'delPh') { if (confirm('Удалить фото?')) { await DB.del('photos', ds.id); openPhoto = null; render(); } }
  if (act === 'addBush') {
    const name = $('#bName').value.trim() || ('Куст ' + (bushes.length + 1));
    await DB.put('bushes', { id: uid(), name, variety: $('#bVar').value, year: $('#bYear').value, note: $('#bNote').value.trim() });
    bushes = await DB.all('bushes'); pendingVar = null; toast('Куст добавлен'); render();
  }
  if (act === 'addJ') {
    const sel = $('#jBush'); const bs = sel ? [...sel.selectedOptions].map(o => o.value) : [];
    await DB.put('journal', { id: uid(), at: new Date().toISOString(), date: $('#jDate').value || todayISO(), work: $('#jWork').value, drug: $('#jDrug').value.trim(), note: $('#jNote').value.trim(), bushes: bs });
    journal = await DB.all('journal'); toast('Записано'); render();
  }
  if (act === 'savePlace') {
    const lat = parseFloat($('#sLat').value.replace(',', '.')), lon = parseFloat($('#sLon').value.replace(',', '.'));
    if (isNaN(lat) || isNaN(lon)) { toast('Проверьте координаты'); return; }
    settings.place = $('#sPlace').value.trim() || settings.place; settings.lat = lat; settings.lon = lon; saveSettings();
    wxRaw = null; LS.set('wx', null); refreshWeather(false); render();
  }
  if (act === 'export') exportData(false);
  if (act === 'exportPh') exportData(true);
  if (act === 'import') $('#importInput').click();
});

document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.bvar) { const b = bushes.find(x => x.id === t.dataset.bvar); if (b) { b.variety = t.value; await DB.put('bushes', b); bushes = await DB.all('bushes'); toast('Сорт изменён'); render(); } return; }
  if (t.dataset.chk) {
    const day = todayISO(); checks[day] = checks[day] || {};
    const r = RULES.find(x => x.id === t.dataset.chk);
    if (t.checked) {
      const jid = uid(); checks[day][r.id] = jid;
      await DB.put('journal', { id: jid, at: new Date().toISOString(), date: day, work: 'Чек-лист', note: r.text, drug: '', bushes: [] });
    } else {
      const jid = checks[day][r.id]; if (typeof jid === 'string') await DB.del('journal', jid).catch(() => {});
      delete checks[day][r.id];
    }
    // храним отметки только за последние 60 дней
    const keys = Object.keys(checks).sort(); while (keys.length > 60) delete checks[keys.shift()];
    LS.set('checks', checks); journal = await DB.all('journal'); render();
  }
});

$('#fileInput').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const blob = await shrink(f);
    const p = { id: uid(), at: Date.now(), blob, part: 'Лист сверху', note: '', status: 'new', diag: '', bush: '' };
    await DB.put('photos', p); photos = await DB.all('photos');
    tab = 'photo'; openPhoto = p.id; $('#view').innerHTML = await viewPhotoOne(p.id); bind(); bindPhotoForm(p.id);
    toast('Фото сохранено');
  } catch (err) { toast('Не удалось сохранить фото: ' + err.message); }
});

$('#importInput').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data || data.app !== 'put-lozy') throw new Error('это не копия справочника');
    if (!confirm('Заменить кусты и журнал данными из копии? Фото из копии добавятся к имеющимся.')) return;
    if (data.settings) { settings = Object.assign({}, DEFAULT_SETTINGS, data.settings); saveSettings(); }
    if (data.flags) { flags = data.flags; saveFlags(); }
    if (data.checks) { checks = data.checks; LS.set('checks', checks); }
    await DB.clear('bushes'); for (const b of data.bushes || []) await DB.put('bushes', b);
    await DB.clear('journal'); for (const j of data.journal || []) await DB.put('journal', j);
    for (const p of data.photos || []) { const blob = await (await fetch(p.data)).blob(); delete p.data; p.blob = blob; await DB.put('photos', p); }
    await loadAll(); toast('Данные восстановлены'); render();
  } catch (err) { toast('Не удалось прочитать файл: ' + err.message); }
});

function bindPhotoForm(id) {
  $('#view').querySelectorAll('[data-pf]').forEach(el => el.addEventListener('change', async () => {
    const p = (await DB.all('photos')).find(x => x.id === id); if (!p) return;
    p[el.dataset.pf] = el.value; await DB.put('photos', p); photos = await DB.all('photos'); toast('Сохранено');
  }));
}

// ---------- фото ----------
async function shrink(file) {
  const max = 1600;
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (e) { return file; }
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise(res => c.toBlob(b => res(b || file), 'image/jpeg', 0.85));
}

function sharePrompt(p) {
  const w = weatherSummary();
  const b = bushes.find(x => x.id === p.bush);
  return `Виноград, ${settings.place}. Фото от ${new Date(p.at).toLocaleDateString('ru-RU')}: ${p.part}.` +
    (b ? ` Сорт: ${b.variety}, посажен ${b.year}.` : '') + (p.note ? ` Заметка: ${p.note}.` : '') +
    (w.src === 'forecast' ? ` Погода сейчас: средняя ${fmtT(w.tmean)}, ночью ${fmtT(w.tmin)}.` : '') +
    ' Что это — болезнь, вредитель или особенность сорта? Как отличить от похожих и чем обработать в средней полосе России?';
}
async function sharePhoto(id) {
  const p = photos.find(x => x.id === id); if (!p) return;
  const text = sharePrompt(p);
  const file = new File([p.blob], `vinograd_${p.id}.jpg`, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text, title: 'Разбор фото винограда' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(text); toast('Вопрос скопирован. Сохраняю фото — приложите его вручную.'); } catch (e) { toast('Сохраняю фото — приложите его вручную.'); }
  download(p.blob, file.name);
}

// ---------- копия ----------
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const toDataURL = blob => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
async function exportData(withPhotos) {
  const data = { app: 'put-lozy', version: 1, at: new Date().toISOString(), settings, flags, checks, bushes: await DB.all('bushes'), journal: await DB.all('journal') };
  if (withPhotos) { data.photos = []; for (const p of await DB.all('photos')) { const { blob, ...rest } = p; data.photos.push({ ...rest, data: await toDataURL(blob) }); } }
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `put-lozy_${todayISO()}${withPhotos ? '_foto' : ''}.json`);
}

// ---------- ручной ввод погоды ----------
function manualEntry() {
  const v = $('#view');
  v.innerHTML = `<div class="card"><h2>Погода вручную</h2><div class="muted small">На сегодня, если нет прогноза. Посмотрите на термометр или в прогноз.</div>
    <label>Средняя за сутки, °C</label><input id="mT" inputmode="decimal" value="${manualWx ? manualWx.tmean : ''}">
    <label>Ночью, °C</label><input id="mN" inputmode="decimal" value="${manualWx ? manualWx.tmin : ''}">
    <label>Днём, °C</label><input id="mD" inputmode="decimal" value="${manualWx && manualWx.tmax != null ? manualWx.tmax : ''}">
    <label>Почва на глубине 15–20 см, °C (если известно)</label><input id="mS" inputmode="decimal">
    <div class="chips" style="margin-top:10px"><label class="chip"><input type="checkbox" id="mR" style="width:auto"> дождь сегодня-завтра</label><label class="chip"><input type="checkbox" id="mF" style="width:auto"> обещают заморозок</label><label class="chip"><input type="checkbox" id="mW" style="width:auto"> сильный ветер</label></div>
    <div class="sticky-actions"><button id="mSave">Сохранить</button><button class="ghost" id="mCancel">Отмена</button></div></div>`;
  const num = id => { const x = parseFloat($(id).value.replace(',', '.').replace('−', '-')); return isNaN(x) ? null : x; };
  $('#mSave').onclick = () => {
    const tmean = num('#mT'), tmin = num('#mN'), tmax = num('#mD');
    if (tmean == null && tmin == null) { toast('Введите хотя бы среднюю или ночную температуру'); return; }
    manualWx = { date: todayISO(), tmean: tmean ?? ((tmin + (tmax ?? tmin)) / 2), tmin: tmin ?? tmean, tmax, soil: num('#mS'), rain: $('#mR').checked, frost: $('#mF').checked, wind: $('#mW').checked };
    LS.set('manualWx', manualWx); render();
  };
  $('#mCancel').onclick = render;
}

// ---------- сообщения ----------
let toastT;
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.style.cssText = 'position:fixed;left:16px;right:16px;bottom:84px;z-index:9;background:#222;color:#fff;padding:10px 14px;border-radius:10px;font-size:14px;text-align:center;box-shadow:0 4px 16px #0004'; document.body.appendChild(el); }
  el.textContent = msg; el.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => el.style.display = 'none', 3200);
}

// ---------- запуск ----------
async function loadAll() {
  try { bushes = await DB.all('bushes'); journal = await DB.all('journal'); photos = await DB.all('photos'); } catch (e) { bushes = []; journal = []; photos = []; }
}
(async function start() {
  await loadAll();
  render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const stale = !wxRaw || Date.now() - wxRaw.at > 6 * 36e5;
  if (stale && navigator.onLine) refreshWeather(true);
  window.addEventListener('online', () => refreshWeather(true));
})();
