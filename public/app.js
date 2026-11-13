(() => {
  'use strict';
  const { $, $$, el, api, openModal, buildForm, FORMS, timeAgo } = window.LAM;

  let CFG = { location: {}, emergency: [], ai: {}, today: '', noticeCats: [], dirCats: [] };
  let WX = null;
  const DATA = { news: [], gallery: [], events: [], notices: [], directory: [] };

  /* ---------------------------------------------------------------- */
  /* helpers                                                          */
  /* ---------------------------------------------------------------- */
  // code → [label, day icon, night icon, sky]
  const WMO = {
    0: ['Clear sky', '☀️', '🌙'], 1: ['Mostly clear', '🌤️', '🌙'], 2: ['Partly cloudy', '⛅', '☁️'], 3: ['Overcast', '☁️', '☁️'],
    45: ['Fog', '🌫️', '🌫️'], 48: ['Freezing fog', '🌫️', '🌫️'],
    51: ['Light drizzle', '🌦️', '🌧️'], 53: ['Drizzle', '🌦️', '🌧️'], 55: ['Heavy drizzle', '🌧️', '🌧️'], 56: ['Freezing drizzle', '🌧️', '🌧️'], 57: ['Freezing drizzle', '🌧️', '🌧️'],
    61: ['Light rain', '🌦️', '🌧️'], 63: ['Rain', '🌧️', '🌧️'], 65: ['Heavy rain', '🌧️', '🌧️'], 66: ['Freezing rain', '🌧️', '🌧️'], 67: ['Freezing rain', '🌧️', '🌧️'],
    71: ['Light snow', '🌨️', '🌨️'], 73: ['Snow', '❄️', '❄️'], 75: ['Heavy snow', '❄️', '❄️'], 77: ['Snow grains', '🌨️', '🌨️'],
    80: ['Rain showers', '🌦️', '🌧️'], 81: ['Rain showers', '🌧️', '🌧️'], 82: ['Violent showers', '⛈️', '⛈️'],
    85: ['Snow showers', '🌨️', '🌨️'], 86: ['Heavy snow showers', '❄️', '❄️'],
    95: ['Thunderstorm', '⛈️', '⛈️'], 96: ['Thunderstorm, hail', '⛈️', '⛈️'], 99: ['Thunderstorm, hail', '⛈️', '⛈️'],
  };
  const wmo = (code, day = 1) => { const w = WMO[code] || ['Unknown', '🌡️', '🌡️']; return { label: w[0], icon: day ? w[1] : w[2] }; };
  function skyFor(code, isDay) {
    if (code >= 95) return 'storm';
    if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if (code === 45 || code === 48) return 'fog';
    if (code === 2 || code === 3) return 'cloudy';
    return isDay ? 'clear-day' : 'clear-night';
  }
  const deg = (n) => Math.round(n) + '°';
  const hm = (iso) => iso.slice(11, 16);
  function to12(hhmm) { const [h, m] = hhmm.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; }
  const short12 = (iso) => { const h = +iso.slice(11, 13); return `${h % 12 || 12}${h >= 12 ? 'p' : 'a'}`; };
  const parseYMD = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const weekday = (s, o = 'short') => parseYMD(s).toLocaleDateString('en-GB', { weekday: o });
  const dayMonth = (s) => parseYMD(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const compass = (d) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8];
  const mins = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const telHref = (p) => { const d = String(p || '').replace(/[^\d+]/g, ''); return d.length >= 3 ? 'tel:' + d : null; };
  const empty = (icon, text) => el('div', { class: 'empty' }, el('span', { class: 'big', text: icon }), text);

  /* ---------------------------------------------------------------- */
  /* sky effects                                                       */
  /* ---------------------------------------------------------------- */
  function setSky(sky) {
    const hero = $('#top'); hero.dataset.sky = sky;
    const fx = $('#skyFx'); fx.replaceChildren();
    const rnd = (a, b) => a + Math.random() * (b - a);
    const mk = (cls, vars) => { const n = el('i', { class: cls }); for (const [k, v] of Object.entries(vars)) n.style.setProperty(k, v); fx.append(n); };
    if (sky === 'rain' || sky === 'storm') for (let i = 0; i < (sky === 'storm' ? 90 : 60); i++) mk('drop', { '--x': rnd(0, 100) + '%', '--t': rnd(.5, .9) + 's', '--d': -rnd(0, 2) + 's' });
    else if (sky === 'snow') for (let i = 0; i < 55; i++) mk('flake', { '--x': rnd(0, 100) + '%', '--s': rnd(3, 8) + 'px', '--t': rnd(6, 12) + 's', '--d': -rnd(0, 10) + 's' });
    else if (sky === 'clear-night') for (let i = 0; i < 45; i++) mk('star', { '--x': rnd(0, 100) + '%', '--y': rnd(0, 55) + '%', '--d': -rnd(0, 3) + 's' });
    else if (sky === 'clear-day' || sky === 'cloudy') for (let i = 0; i < (sky === 'cloudy' ? 5 : 3); i++) mk('cloud', { '--y': rnd(4, 36) + '%', '--t': rnd(70, 130) + 's', '--d': -rnd(0, 100) + 's' });
  }

  /* ---------------------------------------------------------------- */
  /* weather rendering                                                 */
  /* ---------------------------------------------------------------- */
  function renderHero(w) {
    const c = w.current, t = w.daily[0], info = wmo(c.code, c.isDay);
    setSky(skyFor(c.code, c.isDay));
    $('#heroWx').replaceChildren(
      el('div', { class: 'wx-head' }, el('span', { text: '📍 ' + CFG.location.name }), el('span', { text: 'Local time ' + to12(hm(c.time)) })),
      el('div', { class: 'wx-main' }, el('span', { class: 'wx-ico', 'aria-hidden': 'true', text: info.icon }),
        el('div', { class: 'wx-temp' }, String(Math.round(c.temp)), el('sup', { text: '°C' }))),
      el('div', { class: 'wx-cond', text: info.label }),
      el('div', { class: 'wx-sub', text: `Feels like ${deg(c.feels)} · High ${deg(t.max)} · Low ${deg(t.min)}` }),
      el('div', { class: 'wx-grid' },
        ...[['Humidity', c.humidity + '%'], ['Wind', `${Math.round(c.wind)} km/h ${compass(c.windDir)}`], ['Rain today', (t.pop ?? 0) + '%'], ['Pressure', Math.round(c.pressure) + ' hPa']]
          .map(([k, v]) => el('div', {}, el('small', { text: k }), el('b', { text: v })))),
      w.stale ? el('div', { class: 'stale', text: '⚠️ Showing saved data — live update is temporarily unavailable.' }) : null);
    $('#wxUpdated').textContent = 'Updated ' + timeAgo(w.updated) + ' · Source: Open-Meteo';
  }

  function smoothPath(pts) {
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const f = (n) => n.toFixed(1);
      d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)}, ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)}, ${f(p2[0])} ${f(p2[1])}`;
    }
    return d;
  }

  function renderHourly(w) {
    const h = w.hourly, n = h.length;
    const W = 720, H = 236, pl = 16, pr = 16, pt = 34, pb = 26, rainH = 46, base = H - pb - rainH - 6;
    let tmin = Math.min(...h.map((x) => x.temp)), tmax = Math.max(...h.map((x) => x.temp));
    if (tmax - tmin < 4) { tmax += 2; tmin -= 2; }
    const X = (i) => pl + (i * (W - pl - pr)) / (n - 1);
    const Y = (v) => pt + (1 - (v - tmin) / (tmax - tmin)) * (base - pt);
    const pts = h.map((x, i) => [X(i), Y(x.temp)]);
    const line = smoothPath(pts);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Temperature from ${deg(tmin)} to ${deg(tmax)} over the next 24 hours">
      <defs><linearGradient id="tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e0662f" stop-opacity=".32"/><stop offset="1" stop-color="#e0662f" stop-opacity="0"/></linearGradient></defs>
      <line class="ch-grid" x1="${pl}" x2="${W - pr}" y1="${H - pb}" y2="${H - pb}"/>`;
    h.forEach((x, i) => {
      const bh = Math.max(0, ((x.pop || 0) / 100) * rainH);
      if (bh > 1) s += `<rect class="ch-bar" x="${(X(i) - 7).toFixed(1)}" y="${(H - pb - bh).toFixed(1)}" width="14" height="${bh.toFixed(1)}" rx="4"/>`;
    });
    s += `<path class="ch-area" d="${line} L${X(n - 1).toFixed(1)} ${base} L${X(0).toFixed(1)} ${base} Z"/><path class="ch-line" d="${line}"/>`;
    h.forEach((x, i) => {
      if (i % 3 !== 0) return;
      s += `<circle class="ch-dot" cx="${X(i).toFixed(1)}" cy="${Y(x.temp).toFixed(1)}" r="4.5"/>
        <text class="ch-val" x="${X(i).toFixed(1)}" y="${(Y(x.temp) - 12).toFixed(1)}">${deg(x.temp)}</text>
        <text class="ch-axis" text-anchor="middle" x="${X(i).toFixed(1)}" y="${H - 6}">${i === 0 ? 'Now' : short12(x.time)}</text>`;
    });
    s += '</svg>';
    $('#hourChart').innerHTML = s; // numbers/labels generated above only — no user text

    $('#hourStrip').replaceChildren(...h.map((x, i) => el('div', { class: 'hour' + (i === 0 ? ' now' : '') },
      el('small', { text: i === 0 ? 'Now' : short12(x.time) }), el('span', { class: 'ic', 'aria-hidden': 'true', text: wmo(x.code, x.day).icon }),
      el('b', { text: deg(x.temp) }), el('small', { text: (x.pop || 0) + '%' }))));
  }

  function dayLabel(i, d) { return i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : weekday(d.date, 'long'); }

  function renderDaily(w) {
    const ds = w.daily, gmin = Math.min(...ds.map((d) => d.min)), gmax = Math.max(...ds.map((d) => d.max)), span = Math.max(1, gmax - gmin);
    $('#dailyList').replaceChildren(...ds.map((d, i) => {
      const bar = el('span'); bar.style.left = ((d.min - gmin) / span) * 100 + '%'; bar.style.width = Math.max(6, ((d.max - d.min) / span) * 100) + '%';
      return el('div', { class: 'day' },
        el('div', { class: 'dn' }, i === 0 ? 'Today' : i === 1 ? 'Tmrw' : weekday(d.date), el('small', { text: dayMonth(d.date) })),
        el('span', { class: 'di', title: wmo(d.code).label, text: wmo(d.code).icon }),
        el('span', { class: 'dp', text: (d.pop ?? 0) + '%' }),
        el('span', { class: 'lo', text: deg(d.min) }), el('div', { class: 'range', 'aria-hidden': 'true' }, bar), el('span', { class: 'hi', text: deg(d.max) }));
    }));
  }

  function renderStats(w) {
    const c = w.current;
    const rows = [['Feels like', deg(c.feels)], ['Humidity', c.humidity + '%'], ['Wind', `${Math.round(c.wind)} km/h ${compass(c.windDir)}`], ['Gusts', Math.round(c.gust) + ' km/h'],
      ['Pressure', Math.round(c.pressure) + ' hPa'], ['Cloud cover', c.clouds + '%'], ['UV (today max)', String(Math.round(w.daily[0].uv ?? 0))], ['Elevation', Math.round(w.elevation) + ' m']];
    $('#statList').replaceChildren(...rows.map(([k, v]) => el('div', {}, el('dt', { text: k }), el('dd', { text: v }))));
  }

  function renderSun(w) {
    const d = w.daily[0], rise = mins(hm(d.sunrise)), set = mins(hm(d.sunset)), now = mins(hm(w.current.time));
    const p = Math.min(1, Math.max(0, (now - rise) / (set - rise)));
    const cx = 150 - 130 * Math.cos(Math.PI * p), cy = 112 - 100 * Math.sin(Math.PI * p);
    const dl = set - rise;
    $('#sunBox').innerHTML = `<div class="sun-arc"><svg viewBox="0 0 300 130" role="img" aria-label="Sun position">
      <path class="arc-bg" d="M20 112 A130 100 0 0 1 280 112"/>
      <path class="arc-fg" pathLength="100" stroke-dasharray="${(p * 100).toFixed(1)} 100" d="M20 112 A130 100 0 0 1 280 112"/>
      <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="9" fill="#f0b24a" stroke="#fff" stroke-width="3"/></svg></div>`;
    $('#sunBox').append(el('div', { class: 'sun-times' },
      el('div', {}, el('small', { text: 'Sunrise' }), to12(hm(d.sunrise))),
      el('div', { class: 'ta-c' }, el('small', { text: 'Daylight' }), `${Math.floor(dl / 60)}h ${dl % 60}m`),
      el('div', {}, el('small', { text: 'Sunset' }), to12(hm(d.sunset)))));
  }

  function renderAqi(w) {
    const box = $('#aqiBox');
    if (!w.aqi || w.aqi.us == null) { box.replaceChildren(el('p', { class: 'muted', text: 'Air quality data is not available right now.' })); return; }
    const v = Math.round(w.aqi.us);
    const cat = v <= 50 ? 'Good' : v <= 100 ? 'Moderate' : v <= 150 ? 'Unhealthy for sensitive people' : v <= 200 ? 'Unhealthy' : v <= 300 ? 'Very unhealthy' : 'Hazardous';
    const mark = el('i'); mark.style.left = `calc(${Math.min(v / 250, 1) * 100}% - 2px)`;
    box.replaceChildren(el('div', { class: 'aqi-num', text: String(v) }), el('b', { text: cat }),
      el('div', { class: 'aqi-bar', 'aria-hidden': 'true' }, mark),
      el('small', { class: 'muted', text: `PM2.5 ${Math.round(w.aqi.pm25 ?? 0)} µg/m³ · PM10 ${Math.round(w.aqi.pm10 ?? 0)} µg/m³` }));
  }

  function makeTips(w) {
    const tips = [], c = w.current, d0 = w.daily[0];
    const add = (icon, text, level = '') => tips.push({ icon, text, level });
    const snow = w.daily.findIndex((d) => (d.snow || 0) > 0.3);
    if (snow >= 0) add('❄️', `Snow possible ${dayLabel(snow, w.daily[snow]).toLowerCase()} (${w.daily[snow].snow.toFixed(1)} cm). Roads to higher areas may be slippery — check road conditions before travelling.`, 'warn');
    const heavy = w.daily.slice(0, 3).findIndex((d) => (d.rain || 0) >= 15);
    if (heavy >= 0) add('🌧️', `Heavy rain possible ${dayLabel(heavy, w.daily[heavy]).toLowerCase()} (about ${Math.round(w.daily[heavy].rain)} mm). Keep away from streams and steep slopes; landslides are possible on hill roads.`, 'alert');
    else if ((d0.pop || 0) >= 50) add('☔', `${d0.pop}% chance of rain today — take an umbrella.`);
    if (w.daily.slice(0, 3).some((d) => d.code >= 95)) add('⛈️', 'Thunderstorms are in the forecast. Avoid open ground and tall trees during lightning.', 'alert');
    if ((d0.gust || 0) >= 50) add('💨', `Strong gusts up to ${Math.round(d0.gust)} km/h today. Secure loose roofing and tin sheets.`, 'warn');
    if (d0.min <= 0) add('🥶', `Freezing tonight (${deg(d0.min)}). Protect water pipes, animals and young plants.`, 'warn');
    else if (c.temp <= 8) add('🧣', 'It is cold right now — dress in warm layers, especially for children and elders.');
    if (d0.max >= 35) add('🥵', `Hot day ahead (${deg(d0.max)}). Drink plenty of water and avoid working in the midday sun.`, 'warn');
    if ((d0.uv || 0) >= 8) add('🧴', 'UV index is very high today — wear a hat and sunscreen at altitude.');
    if (w.aqi && w.aqi.us > 100) add('😷', 'Air quality is unhealthy. Limit time outdoors, especially for people with asthma.', 'warn');
    if ([45, 48].includes(c.code)) add('🌫️', 'Fog reduces visibility. Drive slowly with headlights on.', 'warn');
    if (!tips.length) {
      if (d0.max >= 14 && d0.max <= 30) add('🌿', 'Pleasant weather today — a good day for outdoor work, farming and travel.');
      else add('✅', 'No weather concerns in the forecast right now.');
    }
    return tips;
  }
  function renderTips(w) {
    $('#tips').replaceChildren(...makeTips(w).map((t) => el('li', { class: t.level }, el('span', { class: 'ti', 'aria-hidden': 'true', text: t.icon }), el('span', { text: t.text }))));
  }

  async function loadPrayer() {
    try {
      const p = await api('/api/prayer');
      const nowMin = WX ? mins(hm(WX.current.time)) : new Date().getHours() * 60 + new Date().getMinutes();
      const order = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
      let next = order.filter((k) => k !== 'Sunrise').find((k) => mins(p.timings[k]) > nowMin) || 'Fajr';
      $('#hijri').textContent = p.approx ? 'approx.' : (p.hijri || 'today');
      $('#prayerList').replaceChildren(...order.map((k) => el('li', { class: next === k ? 'next' : '' }, el('span', { text: k + (next === k ? ' · next' : '') }), el('span', { text: to12(p.timings[k].slice(0, 5)) }))));
    } catch {
      $('#prayerList').replaceChildren(el('li', { class: 'muted', text: 'Prayer times are not available right now.' }));
    }
  }

  async function loadWeather() {
    try {
      WX = await api('/api/weather');
      renderHero(WX); renderHourly(WX); renderDaily(WX); renderStats(WX); renderSun(WX); renderAqi(WX); renderTips(WX);
    } catch (e) {
      const retry = el('button', { class: 'btn light sm', text: 'Try again', onclick: loadWeather });
      $('#heroWx').replaceChildren(el('p', { text: '☁️ ' + e.message }), retry);
      for (const id of ['#hourChart', '#dailyList', '#tips', '#statList', '#sunBox', '#aqiBox']) $(id).replaceChildren(el('p', { class: 'muted', text: 'Weather is not available right now.' }));
    }
  }

  /* ---------------------------------------------------------------- */
  /* community content                                                 */
  /* ---------------------------------------------------------------- */
  function renderPulse() {
    const upcoming = DATA.events.filter((e) => e.date >= CFG.today).length;
    const items = [['📰', DATA.news.length, 'News posts', '#news'], ['📷', DATA.gallery.length, 'Photos', '#gallery'], ['📅', upcoming, 'Upcoming events', '#events'], ['🏪', DATA.directory.length, 'Listings', '#directory']];
    $('#pulse').replaceChildren(...items.map(([i, n, l, href]) => el('a', { href }, el('span', { 'aria-hidden': 'true', text: i }), el('div', {}, el('div', { class: 'n', text: String(n) }), el('div', { class: 'l', text: l })))));
  }

  function openArticle(n) {
    const body = el('div', {},
      n.image ? el('img', { class: 'article-img', src: n.image, alt: '' }) : null,
      el('div', { class: 'meta' }, el('span', { text: timeAgo(n.createdAt) }), n.author ? el('span', { text: '· by ' + n.author }) : null),
      el('p', { class: 'article-body', text: n.body }));
    openModal(n.title, body, { wide: true });
  }
  function renderNews() {
    const g = $('#newsGrid');
    if (!DATA.news.length) return g.replaceChildren(empty('📰', 'No news yet — be the first to share something!'));
    g.replaceChildren(...DATA.news.map((n, i) => el('button', { class: 'news-card' + (i === 0 && DATA.news.length > 1 && n.image ? ' lead-card' : '') + (n.image ? '' : ' no-thumb'), onclick: () => openArticle(n) },
      n.image ? el('div', { class: 'thumb' }, el('img', { src: n.image, alt: '', loading: 'lazy' })) : null,
      el('div', { class: 'txt' },
        el('div', { class: 'meta' }, n.featured ? el('span', { class: 'tag', text: 'Featured' }) : null, el('span', { text: timeAgo(n.createdAt) }), n.author ? el('span', { text: '· ' + n.author }) : null),
        el('h3', { text: n.title }), el('p', { text: n.body.length > 160 ? n.body.slice(0, 157).trimEnd() + '…' : n.body })))));
  }

  let lb = null;
  function openLightbox(idx) {
    const items = DATA.gallery;
    const img = el('img', { alt: '' }), cap = el('figcaption');
    const show = (i) => { lb.i = (i + items.length) % items.length; const it = items[lb.i]; img.src = it.image; img.alt = it.caption || 'Photo of Lamnian'; cap.replaceChildren(el('b', { text: it.caption || '' }), el('div', { text: [it.place, it.author && 'by ' + it.author].filter(Boolean).join(' · ') })); };
    const close = () => { lb.node.remove(); document.removeEventListener('keydown', key); lb = null; };
    const key = (e) => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight') show(lb.i + 1); else if (e.key === 'ArrowLeft') show(lb.i - 1); };
    const node = el('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo viewer', onclick: (e) => { if (e.target === node) close(); } },
      el('button', { class: 'lb-btn lb-close', 'aria-label': 'Close', onclick: close, text: '✕' }),
      items.length > 1 ? el('button', { class: 'lb-btn lb-prev', 'aria-label': 'Previous photo', onclick: () => show(lb.i - 1), text: '‹' }) : null,
      el('figure', {}, img, cap),
      items.length > 1 ? el('button', { class: 'lb-btn lb-next', 'aria-label': 'Next photo', onclick: () => show(lb.i + 1), text: '›' }) : null);
    lb = { node, i: idx }; document.body.append(node); document.addEventListener('keydown', key); show(idx);
  }
  function renderGallery() {
    const g = $('#galleryGrid');
    if (!DATA.gallery.length) return g.replaceChildren(empty('📷', 'No photos yet. Share the beauty of Lamnian!'));
    g.replaceChildren(...DATA.gallery.map((p, i) => el('button', { class: 'shot', 'aria-label': 'Open photo: ' + (p.caption || 'Lamnian'), onclick: () => openLightbox(i) },
      el('img', { src: p.image, alt: p.caption || 'Photo of Lamnian', loading: 'lazy' }),
      p.caption || p.place ? el('figcaption', {}, p.caption, p.place ? el('small', { text: '📍 ' + p.place }) : null) : null)));
  }

  function eventCard(e, past) {
    const d = parseYMD(e.date), tel = telHref(e.contact);
    return el('article', { class: 'event' + (past ? ' past' : '') },
      el('div', { class: 'date' }, el('b', { text: String(d.getDate()) }), el('small', { text: d.toLocaleDateString('en-GB', { month: 'short' }) })),
      el('div', {}, el('h3', { text: e.title }), el('div', { class: 'meta' }, el('span', { text: '🕒 ' + (e.time || weekday(e.date, 'long')) }), el('span', { text: '📍 ' + e.place }), e.author ? el('span', { text: '👤 ' + e.author }) : null),
        e.description ? el('p', { text: e.description }) : null),
      tel ? el('a', { class: 'btn sm call', href: tel, text: '📞 Call' }) : null);
  }
  function renderEvents() {
    const box = $('#eventsList');
    const up = DATA.events.filter((e) => e.date >= CFG.today), past = DATA.events.filter((e) => e.date < CFG.today).reverse().slice(0, 4);
    if (!up.length && !past.length) return box.replaceChildren(empty('📅', 'No events yet. Planning something? Add it here!'));
    box.replaceChildren(...(up.length ? up.map((e) => eventCard(e, false)) : [empty('📅', 'No upcoming events right now.')]),
      past.length ? el('div', { class: 'past-title', text: 'Recently held' }) : null, ...past.map((e) => eventCard(e, true)));
  }

  let noticeCat = 'All';
  function renderNotices() {
    const chips = $('#noticeChips');
    chips.replaceChildren(...['All', ...CFG.noticeCats].map((c) => el('button', { 'aria-pressed': String(c === noticeCat), text: c, onclick: () => { noticeCat = c; renderNotices(); } })));
    const list = DATA.notices.filter((n) => noticeCat === 'All' || n.category === noticeCat);
    const g = $('#noticeGrid');
    if (!list.length) return g.replaceChildren(empty('📌', 'Nothing posted here yet.'));
    g.replaceChildren(...list.map((n) => { const tel = telHref(n.phone); return el('article', { class: 'notice', dataset: { cat: n.category } },
      el('div', { class: 'meta' }, el('span', { class: 'tag', text: n.category }), el('span', { text: timeAgo(n.createdAt) })),
      n.image ? el('img', { src: n.image, alt: '', loading: 'lazy' }) : null,
      el('h3', { text: n.title }), el('p', { text: n.body }),
      el('div', { class: 'meta', text: n.author ? 'Posted by ' + n.author : '' }),
      tel ? el('a', { class: 'btn sm call', href: tel, text: '📞 ' + n.phone }) : null); }));
  }

  let dirCat = 'All', dirQ = '';
  function renderDirectory() {
    $('#dirChips').replaceChildren(...['All', ...CFG.dirCats].map((c) => el('button', { 'aria-pressed': String(c === dirCat), text: c, onclick: () => { dirCat = c; renderDirectory(); } })));
    const q = dirQ.trim().toLowerCase();
    const list = DATA.directory.filter((b) => (dirCat === 'All' || b.category === dirCat) && (!q || [b.name, b.category, b.address, b.description].join(' ').toLowerCase().includes(q)));
    const g = $('#dirGrid');
    if (!list.length) return g.replaceChildren(empty('🏪', DATA.directory.length ? 'No listings match your search.' : 'No listings yet. Add your shop or service!'));
    g.replaceChildren(...list.map((b) => { const tel = telHref(b.phone); return el('article', { class: 'biz' },
      b.image ? el('img', { src: b.image, alt: '', loading: 'lazy' }) : null,
      el('div', { class: 'meta' }, el('span', { class: 'tag', text: b.category })),
      el('h3', { text: b.name }),
      b.description ? el('div', { class: 'row', text: b.description }) : null,
      b.address ? el('div', { class: 'row', text: '📍 ' + b.address }) : null,
      b.hours ? el('div', { class: 'row', text: '🕒 ' + b.hours }) : null,
      tel ? el('a', { class: 'btn sm call', href: tel, text: '📞 ' + b.phone }) : null); }));
  }
  function renderEmergency() {
    $('#emergency').replaceChildren(...CFG.emergency.map((e) => el('a', { class: 'sos', href: 'tel:' + e.number.replace(/\D/g, '') },
      el('span', { class: 'num', text: e.number }), el('span', {}, el('b', { text: e.name }), el('small', { text: e.note || '' })))));
  }

  async function loadAll() {
    const names = ['news', 'gallery', 'events', 'notices', 'directory'];
    await Promise.all(names.map(async (n) => { try { DATA[n] = (await api('/api/' + n)).items; } catch { DATA[n] = []; } }));
    renderNews(); renderGallery(); renderEvents(); renderNotices(); renderDirectory(); renderPulse();
  }

  /* ---------------------------------------------------------------- */
  /* contribute / share                                                */
  /* ---------------------------------------------------------------- */
  function openShare(kind) {
    const def = FORMS[kind];
    let modal;
    const form = buildForm(def, {
      submitLabel: 'Send for approval',
      onSubmit: async (payload) => {
        const r = await api('/api/submit/' + kind, { method: 'POST', body: payload });
        modal.close();
        openModal('Thank you!', el('div', { class: 'success' }, el('div', { class: 'big', text: '✅' }), el('p', { text: r.message || 'Your post will appear after approval.' }),
          el('button', { class: 'btn primary', text: 'Done', onclick: (e) => e.target.closest('.modal-overlay').querySelector('.icon-btn').click() })));
      },
    });
    modal = openModal(`${def.icon} Share ${def.label.toLowerCase()}`, el('div', {}, el('p', { class: 'muted', text: def.blurb + ' The admin reviews every post before it goes live.' }), form));
  }
  function openContribute() {
    const m = openModal('What would you like to share?', el('div', { class: 'pick' }, ...Object.entries(FORMS).map(([k, d]) =>
      el('button', { onclick: () => { m.close(); openShare(k); } }, el('span', { class: 'pi', text: d.icon }), el('b', { text: d.label }), el('small', { text: d.blurb })))));
  }

  /* ---------------------------------------------------------------- */
  /* AI chat                                                           */
  /* ---------------------------------------------------------------- */
  const history = [];
  function setupAI() {
    const on = !!CFG.ai.connected, name = CFG.ai.name || 'Lamnian AI';
    $('#aiTitle').textContent = name;
    $('#chatInput').placeholder = on ? `Ask ${name}…` : 'Coming soon…';
    $('#chatInput').disabled = !on; $('#chatSend').disabled = !on;
    $('#chat').classList.toggle('off', !on);
    const badge = $('#aiBadge'); badge.textContent = on ? 'Online' : 'Not connected yet'; badge.classList.toggle('on', on);
    $('#aiLead').textContent = on ? 'Ask about the weather, travel, local events or anything else. Urdu and English both work.' : 'Ask about the weather, the roads, local events or anything else. Coming soon.';
    $$('.nav .pill-new').forEach((p) => { p.hidden = on; });
    addMsg('bot', on ? 'Assalam o Alaikum! 👋 I am the Lamnian assistant. Ask me about the weather, travelling or what is happening locally.'
      : 'Assalam o Alaikum! 👋 I am not switched on yet, but soon you will be able to ask me about the weather, roads, events and more — in English or Urdu.');
    const sug = ['Is tomorrow good for travelling?', 'What is happening this week?', 'Kal mausam kaisa hoga?', 'Summarise the latest news'];
    $('#suggest').replaceChildren(...sug.map((s) => el('button', { type: 'button', disabled: !on, text: s, onclick: () => { $('#chatInput').value = s; $('#chatForm').requestSubmit(); } })));
  }
  function addMsg(role, text, cls = '') {
    const m = el('div', { class: 'msg ' + role + ' ' + cls, text }); const log = $('#chatLog'); log.append(m); log.scrollTop = log.scrollHeight; return m;
  }
  $('#chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = $('#chatInput'), text = inp.value.trim();
    if (!text || inp.disabled) return;
    inp.value = ''; addMsg('user', text); history.push({ role: 'user', content: text });
    const typing = addMsg('bot', 'Thinking…', 'typing');
    $('#chatSend').disabled = true;
    try {
      const r = await api('/api/ai', { method: 'POST', body: { messages: history.slice(-10) } });
      typing.remove(); addMsg('bot', r.reply); history.push({ role: 'assistant', content: r.reply });
    } catch (err) { typing.remove(); addMsg('bot', '⚠️ ' + err.message); history.pop(); }
    finally { $('#chatSend').disabled = false; inp.focus(); }
  });

  /* ---------------------------------------------------------------- */
  /* page chrome                                                       */
  /* ---------------------------------------------------------------- */
  function initChrome() {
    $('#themeBtn').addEventListener('click', () => {
      const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = t; try { localStorage.setItem('lam-theme', t); } catch { /* private mode */ }
    });
    const nav = $('#nav'), mb = $('#menuBtn');
    mb.addEventListener('click', () => { const o = nav.classList.toggle('open'); mb.setAttribute('aria-expanded', String(o)); });
    nav.addEventListener('click', (e) => { if (e.target.closest('a')) { nav.classList.remove('open'); mb.setAttribute('aria-expanded', 'false'); } });
    $('#contributeBtn').addEventListener('click', openContribute);
    $$('[data-share]').forEach((b) => b.addEventListener('click', () => openShare(b.dataset.share)));
    $('#dirSearch').addEventListener('input', (e) => { dirQ = e.target.value; renderDirectory(); });
    // highlight nav link of the section in view
    const links = new Map($$('.nav a').map((a) => [a.getAttribute('href').slice(1), a]));
    const io = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { links.forEach((a) => a.classList.remove('active')); const a = links.get(en.target.id); if (a) a.classList.add('active'); } }), { rootMargin: '-45% 0px -50% 0px' });
    links.forEach((_, id) => { const s = document.getElementById(id); if (s) io.observe(s); });
  }

  async function init() {
    initChrome();
    try { CFG = await api('/api/config'); } catch { /* keep defaults */ }
    $('#heroRegion').textContent = CFG.location.region || '';
    if (CFG.tagline) $('#heroTagline').textContent = CFG.tagline + ' — all in one place.';
    if (CFG.alert) { const a = $('#alertBar'); a.textContent = (CFG.alert.level === 'info' ? 'ℹ️ ' : '⚠️ ') + CFG.alert.text; a.className = 'alert-bar ' + CFG.alert.level; a.hidden = false; }
    renderEmergency(); setupAI();
    await loadWeather();
    loadPrayer(); loadAll();
    setInterval(loadWeather, 10 * 60e3);
  }
  init();
})();
