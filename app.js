/* Mi Cartera — interfaz. Los cálculos están en core.js; aquí solo se pinta. */
(function () {
  'use strict';
  const C = window.Core;
  const LS = { conn: 'mc.conn', cache: 'mc.cache', ui: 'mc.ui' };
  const REFRESH_MS = 5 * 60 * 1000;

  // ---------------------------------------------------------------- estado
  const st = {
    conn: load(LS.conn) || null,      // { url, key }
    data: null, at: null,             // datos y hora de descarga
    loading: false, error: null, offline: false,
    tab: 'inicio',
    ui: Object.assign({ period: '1M', reparto: 'fondos' }, load(LS.ui) || {}),
  };
  const cached = load(LS.cache);
  if (cached && cached.data) { st.data = cached.data; st.at = cached.at; }

  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* almacenamiento no disponible */ } }

  // Enlace de configuración: …/#url=…&key=…  (se guarda y se borra de la barra de direcciones)
  (function readHash() {
    if (!location.hash || location.hash.length < 5) return;
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get('url') && p.get('key')) {
      st.conn = { url: p.get('url'), key: p.get('key') };
      save(LS.conn, st.conn);
      history.replaceState(null, '', location.pathname + location.search);
    }
  })();

  // ---------------------------------------------------------------- formato (es-ES, con separador de miles siempre)
  function fmtNum(x, dec = 2) {
    if (x == null || !isFinite(x)) return '—';
    const s = Math.abs(x).toFixed(dec);
    const [i, d] = s.split('.');
    const ig = i.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (x < 0 ? '−' : '') + ig + (d ? ',' + d : '');
  }
  const eur = (x, dec = 2) => fmtNum(x, dec) + ' €';
  const sEur = (x, dec = 2) => (x > 0 ? '+' : '') + eur(x, dec);
  const pct = (x, dec = 2) => (x == null || !isFinite(x) ? '—' : fmtNum(x * 100, dec) + ' %');
  const sPct = (x, dec = 2) => (x == null || !isFinite(x) ? '—' : (x > 0 ? '+' : '') + pct(x, dec));
  const cls = (x) => (x > 0.000001 ? 'pos' : x < -0.000001 ? 'neg' : 'muted');
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const dShort = (s) => (s ? `${+s.slice(8, 10)}/${+s.slice(5, 7)}` : '—');
  const dLong = (s) => (s ? `${+s.slice(8, 10)} ${MESES[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}` : '—');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function todayISO() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function timeHM(iso) { if (!iso) return ''; const d = new Date(iso); return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }); }

  const ICON = {
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  };

  // ---------------------------------------------------------------- red
  async function api(method, payload) {
    if (!st.conn) throw new Error('Sin conexión configurada');
    let res;
    if (method === 'GET') {
      const q = new URLSearchParams(Object.assign({ key: st.conn.key }, payload || {}));
      res = await fetch(st.conn.url + '?' + q.toString(), { redirect: 'follow' });
    } else {
      // text/plain evita la petición previa CORS, que Apps Script no admite
      res = await fetch(st.conn.url, { method: 'POST', body: JSON.stringify(Object.assign({ key: st.conn.key }, payload)), redirect: 'follow' });
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'Error del servidor');
    return j;
  }

  async function refresh(force) {
    if (!st.conn || st.loading) return;
    st.loading = true; st.error = null; paintRefresh();
    try {
      const j = await api('GET', { action: force ? 'refresh' : 'data' });
      st.data = j; st.at = new Date().toISOString(); st.offline = false;
      save(LS.cache, { data: j, at: st.at });
    } catch (e) {
      st.error = e.message; st.offline = !navigator.onLine || /Failed to fetch|NetworkError|HTTP/.test(e.message);
    } finally {
      st.loading = false; render();
    }
  }

  async function write(payload, okMsg) {
    try {
      await api('POST', payload);
      toast(okMsg || 'Guardado');
      closeSheet();
      await refresh(false);
      return true;
    } catch (e) { toast('No se pudo guardar: ' + e.message); return false; }
  }

  // ---------------------------------------------------------------- render
  const view = document.getElementById('view');
  function render() {
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === st.tab ? 'page' : 'false'));
    if (!st.conn) { view.innerHTML = renderSetup(); return; }
    if (!st.data) { view.innerHTML = renderLoading(); return; }
    const today = todayISO();
    let S;
    try { S = C.summary(st.data, today); } catch (e) { view.innerHTML = `<div class="empty">Error al calcular: ${esc(e.message)}</div>`; return; }
    const pages = { inicio: renderHome, mercados: renderMarkets, operaciones: renderOps, ajustes: renderSettings };
    view.innerHTML = pages[st.tab](S, today);
    if (st.tab === 'inicio') mountChart(S, today);
  }

  function paintRefresh() { const b = document.querySelector('[data-act="refresh"]'); if (b) b.classList.toggle('spin', st.loading); }

  function statusBanner() {
    if (st.error && st.data) return `<div class="banner">${st.offline ? 'Sin conexión' : 'No se pudo actualizar'} · datos de las ${esc(timeHM(st.at))}${st.offline ? '' : ' · ' + esc(st.error)}</div>`;
    if (st.error) return `<div class="banner">${esc(st.error)}</div>`;
    return '';
  }

  // Instalación como app (Chrome Android muestra el evento cuando la página es instalable)
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; render(); });
  window.addEventListener('appinstalled', () => { installEvt = null; toast('App instalada'); render(); });
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  function installBanner() {
    if (standalone()) return '';
    if (installEvt) return `<div class="banner" style="display:flex;justify-content:space-between;align-items:center;gap:10px">Instala Mi Cartera como app <button class="btn" style="height:36px;font-size:13px" data-act="install">Instalar</button></div>`;
    return '';
  }

  function renderLoading() {
    return `<div class="pad" style="display:flex;flex-direction:column;gap:14px;padding-top:30px">
      <div class="skeleton" style="width:40%"></div><div class="skeleton" style="height:40px;width:70%"></div>
      <div class="skeleton" style="height:140px"></div><div class="skeleton" style="height:80px"></div>
      ${st.error ? `<div class="banner">${esc(st.error)}</div>` : ''}</div>`;
  }

  function renderSetup() {
    return `<div class="page-h"><h1>Mi Cartera</h1></div>
      <div class="pad"><p class="muted">Conecta la app con tu hoja de Google. Pega la dirección de la aplicación web de Apps Script y tu clave secreta (está en la pestaña <b>Config</b> de la hoja).</p>
      <form class="form" data-form="conn">
        <label>Dirección de la aplicación web<input name="url" type="url" required placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off"></label>
        <label>Clave secreta<input name="key" type="password" required autocomplete="off"></label>
        <button class="btn" type="submit">Conectar</button>
      </form></div>`;
  }

  // ---------- Inicio
  function renderHome(S, today) {
    const g = S.gain;
    const tr = S.tr;
    const xirrSub = S.xirr != null ? `XIRR ${sPct(S.xirr, 1)}` : 'desde compra';
    return `
      <header class="head">
        <div><div class="hello">${st.data.config && st.data.config.nombre ? 'Hola, ' + esc(st.data.config.nombre) : 'Hola'}</div><h1>Mi Cartera</h1></div>
        <div style="display:flex;gap:8px">
          <button class="iconbtn${st.loading ? ' spin' : ''}" data-act="refresh" aria-label="Actualizar">${ICON.refresh}</button>
          <button class="fab" data-act="add" aria-label="Añadir operación">${ICON.plus}</button>
        </div>
      </header>
      ${statusBanner()}${installBanner()}
      <section class="total">
        <span class="label">Patrimonio total</span>
        <span class="big num">${eur(S.total)}</span>
        <div class="gain"><span class="${cls(g)} num">${g >= 0 ? '▲' : '▼'} ${sEur(g)} · ${sPct(S.gainPct)}</span><small>en fondos y acciones</small></div>
      </section>
      <section class="chart" id="chart">
        <div class="scrub" id="scrub"></div>
        <svg id="chart-svg" role="img" aria-label="Evolución del valor de tus inversiones"></svg>
        <div class="legend"><span><i class="sw"></i>Valor invertido</span><span><i class="sw dash"></i>Lo que has aportado</span><span class="delta num" id="chart-delta"></span></div>
        <div class="periods" role="group" aria-label="Periodo">
          ${['1S', '1M', '6M', '1A', 'Máx'].map((p) => `<button data-period="${p}" aria-pressed="${st.ui.period === p}">${p}</button>`).join('')}
        </div>
      </section>
      <section class="tiles">
        <div class="tile"><span class="l">Último día</span><span class="v num ${cls(S.day)}">${sEur(S.day)}</span><span class="s">VL ${dShort(S.navDate)}${lastStockDate(S) ? ' · acc. ' + dShort(lastStockDate(S)) : ''}</span></div>
        <div class="tile"><span class="l">Rentab. total</span><span class="v num ${cls(S.gainPct)}">${sPct(S.gainPct)}</span><span class="s">${xirrSub}</span></div>
        <div class="tile"><span class="l">Invertido</span><span class="v num">${eur(S.aportado, 0)}</span><span class="s">en mercado</span></div>
      </section>
      ${renderReparto(S)}
      <div class="section-h"><h2>Posiciones</h2><span class="aside">${st.at ? 'act. ' + esc(timeHM(st.at)) : ''}</span></div>
      <div class="list">
        ${S.funds.map((p) => posRow(p)).join('')}
        ${S.stocks.length ? `<button class="row" data-open="stocks">
          <span class="badge b-stk">${S.stocks.length}</span>
          <span class="mid"><span class="t">Acciones</span><span class="st">${esc(S.stocks.map((p) => p.asset.corto).join(' · '))}</span></span>
          <span class="end"><b class="num">${eur(S.stocksValue)}</b><span class="num ${cls(S.stocksValue - S.stocksAporta)}">${sPct(S.stocksAporta ? (S.stocksValue - S.stocksAporta) / S.stocksAporta : 0, 1)}</span></span>
        </button>` : ''}
        ${tr ? `<button class="row" data-open="tr">
          ${badge('TR', 'b-tr', 'TR')}
          <span class="mid"><span class="t">Trade Republic · ${pct(tr.rate)}</span><span class="st">${sEur(tr.perDayNet)}/día neto · cobro el ${dShort(tr.nextPay)}</span></span>
          <span class="end"><b class="num">${eur(S.trBalance)}</b><span class="num pos">${sEur(tr.monthNet)} neto · mes</span></span>
        </button>` : ''}
        <button class="row" data-open="ing">
          ${badge('ING', 'b-ing', 'ING')}
          <span class="mid"><span class="t">ING Nómina</span><span class="st">Colchón del día a día</span></span>
          <span class="end"><b class="num">${eur(S.ingBalance)}</b></span>
        </button>
      </div>
      ${renderMarketsCard(S)}`;
  }


  // Logos: dominio por activo guardado en la hoja (Config → logos), nunca en el código público
  function logos() { try { const l = st.data && st.data.config && st.data.config.logos; return typeof l === 'string' ? JSON.parse(l) : (l || {}); } catch (e) { return {}; } }
  // Iconos propios para fondos e índices (globo): verde = mundo desarrollado, ámbar = emergentes
  const GLOBE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.9 5.2 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.2-3.9-8.5S9.4 5.9 12 3.5z"/></svg>';
  const GLOBE_EM = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.9 5.2 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.2-3.9-8.5S9.4 5.9 12 3.5z"/><path d="M15.5 8.5l3-3m0 0h-2.6m2.6 0v2.6" stroke-width="1.8"/></svg>';
  function glyphFor(key) {
    const a = st.data && st.data.assets && st.data.assets.find((x) => x.id === key);
    if (!a) return null;
    if (a.clase === 'world' || key === 'IWDA') return ['g-world', GLOBE];
    if (a.clase === 'em' || key === 'EMIM') return ['g-em', GLOBE_EM];
    return null;
  }
  function badge(key, cls, text) {
    const g = glyphFor(key);
    if (g) return `<span class="badge glyph ${g[0]}${cls.includes('sm') ? ' sm' : ''}">${g[1]}</span>`;
    const dom = logos()[key];
    const img = dom ? `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(dom)}&sz=128" alt="" loading="lazy" onerror="this.remove()">` : '';
    return `<span class="badge ${cls}${dom ? ' has-logo' : ''}"><b>${esc(text)}</b>${img}</span>`;
  }

  function lastStockDate(S) { return S.stocks.map((p) => p.quote && p.quote.date).filter(Boolean).sort().pop() || null; }

  function posRow(p) {
    const b = p.asset.clase === 'world' ? ['b-world', 'MW'] : p.asset.clase === 'em' ? ['b-em', 'EM'] : ['b-gen', p.asset.corto.slice(0, 3)];
    return `<button class="row" data-open="asset" data-id="${esc(p.asset.id)}">
      ${badge(p.asset.id, b[0], b[1])}
      <span class="mid"><span class="t">iShares ${esc(p.asset.corto)}</span><span class="st">${fmtNum(p.shares, 2)} part. · VL ${dShort(p.quote && p.quote.date)}</span></span>
      <span class="end"><b class="num">${eur(p.value)}</b><span class="num ${cls(p.gain)}">${sPct(p.gainPct)}</span></span>
    </button>`;
  }

  // Semicírculo de reparto
  function arcPoint(t, r) { const a = Math.PI * (1 - t); return [160 + r * Math.cos(a), 160 - r * Math.sin(a)]; }
  function renderReparto(S) {
    const mode = st.ui.reparto;
    let segs, center, minis, hint = '';
    if (mode === 'fondos') {
      if (!S.world || !S.em) return '';
      segs = [[S.worldWeight, 'var(--accent)'], [S.emWeight, 'var(--em)']];
      center = ['Fondos', eur(S.fundsValue)];
      minis = `<div class="mini">
        <div><span class="n"><i style="background:var(--accent)"></i>World S</span><span class="p num">${pct(S.worldWeight, 1)}</span><span class="d num">${eur(S.world.value, 0)} · obj. ${pct(S.target, 0)}</span></div>
        <div><span class="n"><i style="background:var(--em)"></i>Emergentes S</span><span class="p num">${pct(S.emWeight, 1)}</span><span class="d num">${eur(S.em.value, 0)} · obj. ${pct(1 - S.target, 0)}</span></div></div>`;
      const r = S.rebalance;
      if (r && r.amount > 1) hint = `<div class="hint">Aporta ~${eur(Math.ceil(r.amount), 0)} al ${r.to.clase === 'world' ? 'World' : 'Emergentes'} para volver al ${Math.round(S.target * 100)}/${Math.round((1 - S.target) * 100)}</div>`;
      else hint = `<div class="hint ok">Reparto en objetivo</div>`;
    } else {
      const T = S.total || 1;
      const parts = [['World S', S.world ? S.world.value : 0, 'var(--accent)'], ['Emergentes S', S.em ? S.em.value : 0, 'var(--em)'], ['Acciones', S.stocksValue, 'var(--stocks)'], ['Trade Republic', S.trBalance, 'var(--tr)'], ['ING', S.ingBalance, 'var(--ing)']].filter((x) => x[1] > 0);
      segs = parts.map((x) => [x[1] / T, x[2]]);
      center = ['Patrimonio', eur(S.total, 0)];
      minis = `<div class="mini three">${parts.map((x) => `<div><span class="n"><i style="background:${x[2]}"></i>${x[0]}</span><span class="p num" style="font-size:17px">${pct(x[1] / T, 1)}</span><span class="d num">${eur(x[1], 0)}</span></div>`).join('')}</div>`;
    }
    let acc = 0, arcs = '';
    const gap = segs.length > 1 ? 0.5 : 0;
    segs.forEach(([w, col]) => {
      const len = Math.max(0, w * 100 - gap);
      arcs += `<path d="M 30 160 A 130 130 0 0 1 290 160" fill="none" stroke="${col}" stroke-width="26" pathLength="100" stroke-dasharray="0 ${(acc + (acc ? gap / 2 : 0)).toFixed(2)} ${len.toFixed(2)} 200"/>`;
      acc += w * 100;
    });
    let tick = '';
    if (mode === 'fondos') {
      const [x1, y1] = arcPoint(S.target, 115), [x2, y2] = arcPoint(S.target, 145), [lx, ly] = arcPoint(S.target, 160);
      tick = `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="#F2F4F5" stroke-width="2.5" stroke-linecap="round"/>
        <text x="${lx.toFixed(1)}" y="${(ly - 2).toFixed(1)}" font-size="11" font-weight="700" fill="#C9D0D5" text-anchor="middle">${Math.round(S.target * 100)} %</text>`;
    }
    return `<section class="card">
      <div class="card-h"><h2>Reparto</h2>
        <div class="seg" role="tablist" aria-label="Vista del reparto">
          <button role="tab" data-reparto="fondos" aria-selected="${mode === 'fondos'}">Fondos</button>
          <button role="tab" data-reparto="todo" aria-selected="${mode === 'todo'}">Todo</button>
        </div></div>
      <div class="gauge"><svg viewBox="0 0 320 176" role="img" aria-label="Reparto">
        <path d="M 30 160 A 130 130 0 0 1 290 160" fill="none" stroke="var(--track)" stroke-width="26"/>
        ${arcs}${tick}
        <text x="160" y="128" text-anchor="middle" font-size="12" fill="#9AA3AB" font-weight="600">${center[0]}</text>
        <text x="160" y="156" text-anchor="middle" font-size="26" font-weight="800" fill="#F2F4F5">${center[1]}</text>
      </svg></div>
      ${minis}${hint}
    </section>`;
  }

  function renderMarketsCard(S) {
    // Mis mercados: solo lo que tienes (fondos con su VL oficial, acciones y la divisa). El detalle completo está en la pestaña Mercados.
    const fx = C.markets(st.data).find((m) => m.fx);
    const items = S.funds.map((p) => ({ id: p.asset.id, cls: p.asset.clase === 'world' ? 'b-world' : 'b-em', t: p.asset.clase === 'world' ? 'MW' : 'EM', n: p.asset.clase === 'world' ? 'World S' : 'Emergentes S', pct: p.dayPct }))
      .concat(S.stocks.map((p) => ({ id: p.asset.id, cls: 'b-stk', t: p.asset.corto.slice(0, 3).toUpperCase(), n: p.asset.corto, pct: p.dayPct })));
    if (fx && fx.price) items.push({ id: 'EURUSD', cls: 'b-gen', t: '€/$', n: 'Euro / Dólar (EUR/USD)', val: fmtNum(fx.price, 4), wide: true });
    const sd = lastStockDate(S);
    return `<section class="card">
      <div class="card-h"><h2>Mis mercados</h2><span class="aside">VL ${dShort(S.navDate)}${sd ? ' · acc. ' + dShort(sd) : ''}</span></div>
      <div class="mymk">${items.map((it) => `<div${it.wide ? ' class="wide"' : ''}>${badge(it.id, it.cls + ' sm', it.t)}<span class="n">${esc(it.n)}</span><span class="v num ${it.val ? '' : cls(it.pct)}">${it.val || sPct(it.pct, 1)}</span></div>`).join('')}</div>
    </section>`;
  }

  // Gráfico
  function mountChart(S, today) {
    const svg = document.getElementById('chart-svg');
    if (!svg) return;
    const all = C.history(st.data, today);
    const days = { '1S': 7, '1M': 30, '6M': 182, '1A': 365, 'Máx': 1e6 }[st.ui.period];
    const from = C.addDays(today, -days);
    let pts = all.filter((p) => p[0] >= from);
    if (pts.length < 2) pts = all.slice(-2);
    const W = svg.clientWidth || 366, H = 150, top = 12, bot = 8;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (pts.length < 2) { svg.innerHTML = ''; return; }
    const vals = pts.flatMap((p) => [p[1], p[2]]);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const padv = (hi - lo) * 0.08 || hi * 0.01 || 1; lo -= padv; hi += padv;
    const x = (i) => (i / (pts.length - 1)) * W;
    const y = (v) => top + (1 - (v - lo) / (hi - lo)) * (H - top - bot);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[1]).toFixed(1)}`).join(' ');
    const dash = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[2]).toFixed(1)}`).join(' ');
    const last = pts[pts.length - 1];
    svg.innerHTML = `<defs><linearGradient id="gd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2BD4A4" stop-opacity="0.26"/><stop offset="1" stop-color="#2BD4A4" stop-opacity="0"/></linearGradient></defs>
      <path d="${line} L${W} ${H} L0 ${H} Z" fill="url(#gd)"/>
      <path d="${dash}" fill="none" stroke="#5B656D" stroke-width="1.4" stroke-dasharray="4 5"/>
      <path d="${line}" fill="none" stroke="#2BD4A4" stroke-width="2.4" stroke-linejoin="round"/>
      <circle cx="${W - 3}" cy="${y(last[1]).toFixed(1)}" r="4" fill="#2BD4A4"/>
      <line id="cur" x1="0" x2="0" y1="0" y2="${H}" stroke="#5B656D" stroke-width="1" visibility="hidden"/>`;
    // Ganancia del periodo = variación de valor − variación de lo aportado
    const first = pts[0];
    const g = (last[1] - first[1]) - (last[2] - first[2]);
    const dEl = document.getElementById('chart-delta');
    dEl.className = 'delta num ' + cls(g); dEl.textContent = `${sEur(g)} en ${st.ui.period === 'Máx' ? 'total' : st.ui.period}`;
    // Arrastrar para ver valores
    const scrub = document.getElementById('scrub'), cur = svg.querySelector('#cur');
    const show = (clientX) => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(((clientX - r.left) / r.width) * (pts.length - 1))));
      const p = pts[i];
      cur.setAttribute('x1', x(i)); cur.setAttribute('x2', x(i)); cur.setAttribute('visibility', 'visible');
      scrub.textContent = `${dLong(p[0])} · ${eur(p[1])} · aportado ${eur(p[2], 0)}`;
    };
    const hide = () => { cur.setAttribute('visibility', 'hidden'); scrub.textContent = ''; };
    svg.addEventListener('pointerdown', (e) => show(e.clientX));
    svg.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') show(e.clientX); });
    svg.addEventListener('pointerup', hide); svg.addEventListener('pointerleave', hide);
  }

  // ---------- Mercados
  function renderMarkets(S) {
    const mk = C.markets(st.data);
    const live = st.data.live && st.data.live._fetched;
    return `<div class="page-h"><h1>Mercados</h1><button class="iconbtn${st.loading ? ' spin' : ''}" data-act="refresh" aria-label="Actualizar">${ICON.refresh}</button></div>
      ${statusBanner()}
      <div class="group-h">Índices y divisa</div>
      <div class="list">${mk.map((m) => `<div class="row">${badge(m.fx ? 'EURUSD' : m.asset.id, 'b-gen', m.fx ? '€/$' : m.asset.id === 'IWDA' ? 'MW' : 'EM')}
        <span class="mid"><span class="t">${esc(m.asset.nombre || m.asset.corto)}</span><span class="st">${m.date ? 'sesión ' + dShort(m.date) : 'sin datos'}</span></span>
        <span class="end"><b class="num">${m.fx ? fmtNum(m.price, 4) : m.price ? fmtNum(m.price, 2) : '—'}</b><span class="num ${cls(m.pct)}">${sPct(m.pct)}</span></span></div>`).join('')}</div>
      <div class="group-h">Tus fondos · valor liquidativo oficial</div>
      <div class="list">${S.funds.map((p) => `<button class="row" data-open="asset" data-id="${esc(p.asset.id)}">${badge(p.asset.id, p.asset.clase === 'world' ? 'b-world' : 'b-em', p.asset.clase === 'world' ? 'MW' : 'EM')}
        <span class="mid"><span class="t">${esc(p.asset.corto)}</span><span class="st">VL ${dShort(p.quote && p.quote.date)} · TER ${fmtNum(p.asset.ter, 2)} %</span></span>
        <span class="end"><b class="num">${fmtNum(p.price, 4)} €</b><span class="num ${cls(p.dayPct)}">${sPct(p.dayPct)}</span></span></button>`).join('')}</div>
      <div class="group-h">Tus acciones</div>
      <div class="list">${S.stocks.map((p) => stockRow(p)).join('')}</div>
      <p class="note pad">Fondos: dato oficial de BlackRock, se publica con un día de retraso. Acciones e índices: Yahoo Finance, con hasta 15 min de retraso${live ? ' (consultado a las ' + esc(timeHM(live)) + ')' : ''}. Los índices MSCI se siguen a través de sus ETF (IWDA y EMIM).</p>`;
  }

  function stockRow(p) {
    const q = p.quote || {};
    const nat = p.asset.moneda === 'USD' && q.native ? ` · ${fmtNum(q.native, 2)} $` : '';
    return `<div class="row">${badge(p.asset.id, 'b-stk', p.asset.corto.slice(0, 3).toUpperCase())}
      <span class="mid"><span class="t">${esc(p.asset.nombre)}</span><span class="st">${fmtNum(p.price, 2)} €${nat} · hoy <span class="${cls(p.dayPct)}">${sPct(p.dayPct, 1)}</span></span></span>
      <span class="end"><b class="num">${eur(p.value)}</b><span class="num ${cls(p.gain)}">${sEur(p.gain)}</span></span></div>`;
  }

  // ---------- Operaciones
  function renderOps(S) {
    const A = Object.fromEntries(st.data.assets.map((a) => [a.id, a]));
    const ev = [];
    st.data.lots.forEach((l) => ev.push({ d: l.desde, k: 'lot', l }));
    st.data.cash.filter((c) => c.tipo !== 'compra').forEach((c) => ev.push({ d: c.fecha, k: 'cash', c }));
    (S.tr ? S.tr.payouts.filter((p) => p.estimado) : []).forEach((p) => ev.push({ d: p.fecha, k: 'est', p }));
    ev.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
    const groups = {};
    ev.forEach((e) => { const m = e.d.slice(0, 7); (groups[m] = groups[m] || []).push(e); });
    const label = { deposito: 'Ingreso', retirada: 'Retirada', bono: 'Bono', interes: 'Intereses cobrados', ajuste: 'Ajuste de saldo' };
    const rows = Object.keys(groups).map((m) => `<div class="group-h">${MESES[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}</div><div class="list">` + groups[m].map((e) => {
      if (e.k === 'lot') {
        const a = A[e.l.activo] || { corto: e.l.activo, clase: '' };
        const isFund = a.tipo === 'fondo';
        const tras = Number(e.l.aporta) === 0 && isFund;
        const t = isFund ? (tras ? 'Traspaso a ' : 'Aportación · ') + a.corto : 'Compra · ' + a.corto;
        return `<div class="row">${badge(e.l.activo, a.clase === 'world' ? 'b-world' : a.clase === 'em' ? 'b-em' : 'b-stk', a.clase === 'world' ? 'MW' : a.clase === 'em' ? 'EM' : String(a.corto).slice(0, 3).toUpperCase())}
          <span class="mid"><span class="t">${esc(t)}</span><span class="st">${dShort(e.d)} · ${fmtNum(e.l.participaciones, isFund ? 2 : 6)} ${isFund ? 'part.' : 'acc.'}${e.l.hasta ? ' · traspasado el ' + dShort(C.addDays(e.l.hasta, 1)) : ''}</span></span>
          <span class="end"><b class="num">${eur(e.l.coste)}</b>${e.l.hasta ? '<span class="muted">cerrado</span>' : ''}</span></div>`;
      }
      if (e.k === 'est') return `<div class="row">${badge('TR', 'b-tr', 'TR')}<span class="mid"><span class="t">Intereses ${esc(e.p.periodo)} (estimado)</span><span class="st">${dShort(e.d)} · pendiente de confirmar</span></span><span class="end"><b class="num pos">${sEur(e.p.importe)}</b></span></div>`;
      const c = e.c;
      return `<div class="row">${badge(c.cuenta, c.cuenta === 'TR' ? 'b-tr' : 'b-ing', c.cuenta)}
        <span class="mid"><span class="t">${esc(label[c.tipo] || c.tipo)}${c.nota ? ' · ' + esc(c.nota) : ''}</span><span class="st">${dShort(c.fecha)}</span></span>
        <span class="end"><b class="num ${cls(Number(c.importe))}">${sEur(Number(c.importe))}</b></span></div>`;
    }).join('') + '</div>').join('');
    return `<div class="page-h"><h1>Operaciones</h1><button class="fab" data-act="add" aria-label="Añadir operación">${ICON.plus}</button></div>
      ${statusBanner()}${rows || '<div class="empty">Sin operaciones</div>'}`;
  }

  // ---------- Ajustes
  function renderSettings(S) {
    const c = st.data.config || {};
    const lu = st.data.lastUpdate;
    return `<div class="page-h"><h1>Ajustes</h1></div>
      <div class="group-h">Objetivo de reparto</div>
      <form class="form pad" data-form="target">
        <label>Peso objetivo del World (%)<input name="targetWorld" type="number" inputmode="decimal" min="0" max="100" step="1" value="${Math.round((c.targetWorld || 0.8) * 100)}"></label>
        <button class="btn ghost" type="submit">Guardar objetivo</button>
      </form>
      <div class="group-h">Trade Republic</div>
      <form class="form pad" data-form="tr">
        <div class="two"><label>Interés hasta el límite (%)<input name="trRate" type="number" inputmode="decimal" step="0.01" value="${fmtIn((c.trRate || 0.03) * 100)}"></label>
        <label>Límite (€)<input name="trThreshold" type="number" inputmode="decimal" step="1" value="${c.trThreshold || 50000}"></label></div>
        <div class="two"><label>Interés por encima (%)<input name="trRateHigh" type="number" inputmode="decimal" step="0.01" value="${fmtIn((c.trRateHigh || 0.0253) * 100)}"></label>
        <label>Retención IRPF (%)<input name="trTax" type="number" inputmode="decimal" step="0.1" value="${fmtIn((c.trTax || 0.19) * 100)}"></label></div>
        <button class="btn ghost" type="submit">Guardar condiciones</button>
      </form>
      <div class="group-h">Datos</div>
      <div class="pad"><dl class="kv">
        <dt>Última descarga de precios</dt><dd>${lu ? esc(dShort(lu.slice(0, 10)) + ' ' + timeHM(lu)) : '—'}</dd>
        <dt>Último VL de fondos</dt><dd>${dLong(S.navDate)}</dd>
        <dt>Datos en la app</dt><dd>${st.at ? esc(timeHM(st.at)) : '—'}</dd>
      </dl>
      <div class="form"><button class="btn ghost" data-act="force">Descargar precios ahora</button>
      <button class="btn danger" data-act="disconnect">Desconectar este móvil</button></div>
      <p class="note">Tus datos están en tu hoja de Google; esta app solo los muestra. Fondos: BlackRock (oficial). Acciones, índices y EUR/USD: Yahoo Finance. Intereses de TR: calculados (saldo × tipo / 365) y mostrados en neto; se cuadran con cada cobro real.</p></div>`;
  }
  const fmtIn = (x) => String(Math.round(x * 1000) / 1000);

  // ---------------------------------------------------------------- hojas de detalle
  const sheet = document.getElementById('sheet'), sheetBody = document.getElementById('sheet-body');
  const panel = sheet.querySelector('.sheet-panel'), backdrop = sheet.querySelector('.sheet-backdrop');
  function openSheet(html) {
    const wasOpen = !sheet.hidden;
    sheetBody.innerHTML = html; sheet.hidden = false; document.body.style.overflow = 'hidden';
    panel.scrollTop = 0; panel.style.transform = ''; backdrop.style.opacity = '';
    // Una entrada en el historial: el botón "atrás" de Android cierra la hoja en vez de salir de la app
    if (!wasOpen) history.pushState({ sheet: 1 }, '');
  }
  function hideSheet() { sheet.hidden = true; sheetBody.innerHTML = ''; document.body.style.overflow = ''; panel.style.transform = ''; backdrop.style.opacity = ''; }
  function closeSheet() { if (sheet.hidden) return; if (history.state && history.state.sheet) history.back(); else hideSheet(); }
  window.addEventListener('popstate', () => { if (!sheet.hidden) hideSheet(); });

  // Deslizar hacia abajo para cerrar: desde la barra superior, o desde cualquier punto si el contenido está arriba del todo
  (function swipe() {
    let y0 = 0, t0 = 0, dy = 0, active = false, fromTop = false;
    const start = (y, target) => {
      fromTop = !!target.closest('#sheet-top');
      if (!fromTop && panel.scrollTop > 0) return;
      if (target.closest('input, select, textarea')) return;
      active = true; y0 = y; t0 = Date.now(); dy = 0; panel.classList.remove('snap');
    };
    const move = (y, ev) => {
      if (!active) return;
      dy = y - y0;
      if (dy <= 0) { if (!fromTop) { active = false; } panel.style.transform = ''; return; }
      if (!fromTop && panel.scrollTop > 0) { active = false; return; }
      if (ev.cancelable) ev.preventDefault();
      panel.style.transform = `translateY(${dy}px)`;
      backdrop.style.opacity = String(Math.max(0.15, 1 - dy / 500));
    };
    const end = () => {
      if (!active) return;
      active = false;
      const v = dy / Math.max(1, Date.now() - t0);
      panel.classList.add('snap');
      if (dy > 110 || (dy > 30 && v > 0.6)) {
        panel.style.transform = 'translateY(100%)';
        setTimeout(() => { panel.classList.remove('snap'); closeSheet(); }, 180);
      } else { panel.style.transform = ''; backdrop.style.opacity = ''; }
    };
    panel.addEventListener('touchstart', (e) => start(e.touches[0].clientY, e.target), { passive: true });
    panel.addEventListener('touchmove', (e) => move(e.touches[0].clientY, e), { passive: false });
    panel.addEventListener('touchend', end); panel.addEventListener('touchcancel', end);
    // Ratón (ordenador): solo desde la barra superior
    const top = document.getElementById('sheet-top');
    top.addEventListener('mousedown', (e) => { start(e.clientY, e.target); const mm = (ev) => move(ev.clientY, ev); const mu = () => { end(); removeEventListener('mousemove', mm); removeEventListener('mouseup', mu); }; addEventListener('mousemove', mm); addEventListener('mouseup', mu); });
  })();

  function sheetAsset(id) {
    const S = C.summary(st.data, todayISO());
    const p = S.positions.find((x) => x.asset.id === id);
    if (!p) return;
    const a = p.asset;
    const tot = p.lots.reduce((acc, l) => ({ n: acc.n + Number(l.participaciones), c: acc.c + Number(l.coste), v: acc.v + l.valor }), { n: 0, c: 0, v: 0 });
    openSheet(`<h3 id="sheet-title">${esc(a.nombre)}</h3>
      <div class="sub">${esc(a.isin)} · TER ${fmtNum(a.ter, 2)} % · VL ${fmtNum(p.quote && p.quote.nav ? p.quote.nav : p.price, 6)} € (${dLong(p.quote && p.quote.date)})</div>
      <dl class="kv">
        <dt>Valor</dt><dd class="num">${eur(p.value)}</dd>
        <dt>Coste fiscal (FIFO)</dt><dd class="num">${eur(p.cost)}</dd>
        <dt>Resultado fiscal</dt><dd class="num ${cls(p.gain)}">${sEur(p.gain)} · ${sPct(p.gainPct)}</dd>
        <dt>Último día</dt><dd class="num ${cls(p.day)}">${sEur(p.day)} · ${sPct(p.dayPct)}</dd>
        <dt>Peso en fondos</dt><dd class="num">${pct(p.value / S.fundsValue, 1)}</dd>
      </dl>
      <table class="t"><thead><tr><th>Fecha fiscal</th><th>Part.</th><th>Coste</th><th>Valor</th><th>Result.</th></tr></thead>
      <tbody>${p.lots.map((l) => `<tr><td>${dShort(l.fecha_fiscal)}/${l.fecha_fiscal.slice(2, 4)}</td><td class="num">${fmtNum(+l.participaciones, 2)}</td><td class="num">${fmtNum(+l.coste)}</td><td class="num">${fmtNum(l.valor)}</td><td class="num ${cls(l.resultado)}">${fmtNum(l.resultado)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td><td class="num">${fmtNum(tot.n, 2)}</td><td class="num">${fmtNum(tot.c)}</td><td class="num">${fmtNum(tot.v)}</td><td class="num ${cls(tot.v - tot.c)}">${fmtNum(tot.v - tot.c)}</td></tr></tfoot></table>
      <p class="note">Lotes en orden FIFO: si vendes, Hacienda toma primero los más antiguos. Los traspasos entre fondos no tributan y conservan la fecha y el coste originales.</p>`);
  }

  function sheetStocks() {
    const S = C.summary(st.data, todayISO());
    const g = S.stocksValue - S.stocksAporta;
    openSheet(`<h3 id="sheet-title">Acciones · Trade Republic</h3>
      <div class="sub">${S.stocks.length} posiciones</div>
      <dl class="kv">
        <dt>Valor</dt><dd class="num">${eur(S.stocksValue)}</dd>
        <dt>Dinero propio invertido</dt><dd class="num">${eur(S.stocksAporta)}</dd>
        <dt>Ganancia sobre tu dinero</dt><dd class="num ${cls(g)}">${sEur(g)} · ${sPct(S.stocksAporta ? g / S.stocksAporta : 0, 1)}</dd>
        <dt>Coste fiscal (con comisiones)</dt><dd class="num">${eur(S.stocksCost)}</dd>
      </dl>
      <div class="list" style="padding:0;margin-top:8px">${S.stocks.map((p) => stockRow(p)).join('')}</div>
      <p class="note">El resultado de cada acción se calcula sobre su coste con comisión. Las compras pagadas con un bono no cuentan como dinero tuyo, pero sí tienen coste fiscal.</p>`);
  }

  function sheetTR() {
    const S = C.summary(st.data, todayISO());
    const tr = S.tr;
    openSheet(`<h3 id="sheet-title">Trade Republic · cuenta remunerada</h3>
      <div class="sub">${pct(tr.rate)} anual · retención ${pct(tr.tax, 0)} · pago mensual</div>
      <dl class="kv">
        <dt>Saldo</dt><dd class="num">${eur(S.trBalance)}</dd>
        <dt>Devengado este mes (${tr.daysAccrued} días)</dt><dd class="num">${eur(tr.monthGross)} bruto · <span class="pos">${eur(tr.monthNet)} neto</span></dd>
        <dt>Por día</dt><dd class="num">${eur(tr.perDayGross, 3)} bruto · ${eur(tr.perDayNet, 3)} neto</dd>
        <dt>Previsión del cobro (${dShort(tr.nextPay)})</dt><dd class="num pos">≈ ${eur(tr.projNet)} neto</dd>
        <dt>Intereses cobrados en total</dt><dd class="num">${eur(tr.totalPaidNet)}</dd>
      </dl>
      ${tr.payouts.length ? `<table class="t"><thead><tr><th>Mes</th><th>Fecha</th><th>Neto</th></tr></thead><tbody>${tr.payouts.map((p) => `<tr><td>${esc(p.periodo || '')}${p.estimado ? ' (estimado)' : ''}</td><td>${dShort(p.fecha)}</td><td class="num">${fmtNum(p.importe)}</td></tr>`).join('')}</tbody></table>` : ''}
      <p class="note">Cálculo: saldo al final de cada día × tipo / 365 (hasta ${eur(cfgN('trThreshold', 50000), 0)}; por encima, ${pct(cfgN('trRateHigh', 0.0253))}). Si un mes no se registra el cobro real, la app lo estima el día 1 y lo suma al saldo. Mándame la captura de cada cobro y lo cuadro.</p>`);
  }
  const cfgN = (k, d) => (st.data.config && st.data.config[k] !== undefined && st.data.config[k] !== '' ? Number(st.data.config[k]) : d);

  function sheetING() {
    const S = C.summary(st.data, todayISO());
    openSheet(`<h3 id="sheet-title">ING Nómina</h3><div class="sub">Saldo actual ${eur(S.ingBalance)}</div>
      <form class="form" data-form="ing">
        <label>Nuevo saldo (€)<input name="saldo" type="number" inputmode="decimal" step="0.01" required value="${S.ingBalance.toFixed(2)}"></label>
        <button class="btn" type="submit">Actualizar saldo</button>
      </form>`);
  }

  // ---------- Añadir operación
  function sheetAdd() {
    openSheet(`<h3 id="sheet-title">Añadir operación</h3><div class="sub">También puedes mandarle la captura a Claude y lo registra por ti.</div>
      <div class="choice">
        <button data-add="fondo"><b>Aportación a un fondo</b><span>MyInvestor · World S o Emergentes S</span></button>
        <button data-add="accion"><b>Compra de acciones</b><span>Trade Republic · descuenta el importe del efectivo</span></button>
        <button data-add="efectivo"><b>Movimiento de efectivo</b><span>Ingreso, retirada o cobro de intereses en TR o ING</span></button>
      </div>`);
  }
  function formFor(kind) {
    const today = todayISO();
    const funds = st.data.assets.filter((a) => a.tipo === 'fondo');
    const stocks = st.data.assets.filter((a) => a.tipo === 'accion');
    const opts = (arr) => arr.map((a) => `<option value="${esc(a.id)}">${esc(a.corto)}</option>`).join('');
    if (kind === 'fondo') return `<h3 id="sheet-title">Aportación a un fondo</h3><form class="form" data-form="add-fondo">
      <label>Fondo<select name="activo">${opts(funds)}</select></label>
      <div class="two"><label>Fecha<input name="fecha" type="date" required value="${today}"></label><label>Importe (€)<input name="importe" type="number" inputmode="decimal" step="0.01" min="0.01" required></label></div>
      <label>Participaciones (si aún no las sabes, déjalo vacío y se estiman con el último VL)<input name="part" type="number" inputmode="decimal" step="0.000001" min="0"></label>
      <button class="btn" type="submit">Guardar aportación</button></form>`;
    if (kind === 'accion') return `<h3 id="sheet-title">Compra de acciones</h3><form class="form" data-form="add-accion">
      <label>Acción<select name="activo">${opts(stocks)}</select></label>
      <div class="two"><label>Fecha<input name="fecha" type="date" required value="${today}"></label><label>Importe total con comisión (€)<input name="importe" type="number" inputmode="decimal" step="0.01" min="0.01" required></label></div>
      <label>Unidades<input name="part" type="number" inputmode="decimal" step="0.000001" min="0.000001" required></label>
      <button class="btn" type="submit">Guardar compra</button></form>`;
    return `<h3 id="sheet-title">Movimiento de efectivo</h3><form class="form" data-form="add-efectivo">
      <div class="two"><label>Cuenta<select name="cuenta"><option value="TR">Trade Republic</option><option value="ING">ING Nómina</option></select></label>
      <label>Tipo<select name="tipo"><option value="deposito">Ingreso</option><option value="retirada">Retirada</option><option value="interes">Intereses cobrados (neto)</option></select></label></div>
      <div class="two"><label>Fecha<input name="fecha" type="date" required value="${today}"></label><label>Importe (€)<input name="importe" type="number" inputmode="decimal" step="0.01" min="0.01" required></label></div>
      <label>Nota (opcional)<input name="nota" type="text" maxlength="80"></label>
      <button class="btn" type="submit">Guardar movimiento</button></form>`;
  }

  // ---------------------------------------------------------------- eventos
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, [data-close]');
    if (!t) return;
    if (t.hasAttribute('data-close')) return closeSheet();
    if (t.dataset.tab) { st.tab = t.dataset.tab; window.scrollTo(0, 0); render(); return; }
    if (t.dataset.period) { st.ui.period = t.dataset.period; save(LS.ui, st.ui); render(); return; }
    if (t.dataset.reparto) { st.ui.reparto = t.dataset.reparto; save(LS.ui, st.ui); render(); return; }
    if (t.dataset.open === 'asset') return sheetAsset(t.dataset.id);
    if (t.dataset.open === 'stocks') return sheetStocks();
    if (t.dataset.open === 'tr') return sheetTR();
    if (t.dataset.open === 'ing') return sheetING();
    if (t.dataset.add) { sheetBody.innerHTML = formFor(t.dataset.add); return; }
    const act = t.dataset.act;
    if (act === 'refresh') return refresh(false);
    if (act === 'force') { toast('Descargando precios…'); return refresh(true); }
    if (act === 'add') return sheetAdd();
    if (act === 'install' && installEvt) { installEvt.prompt(); installEvt.userChoice.finally(() => { installEvt = null; render(); }); return; }
    if (act === 'disconnect') {
      if (!confirmInline(t, '¿Seguro? Pulsa otra vez para desconectar')) return;
      st.conn = null; st.data = null; localStorage.removeItem(LS.conn); localStorage.removeItem(LS.cache); render();
    }
  });

  function confirmInline(btn, msg) {
    if (btn.dataset.armed) return true;
    btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = msg;
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = old; } }, 4000);
    return false;
  }

  const numIn = (v) => parseFloat(String(v).replace(',', '.'));
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('form[data-form]');
    if (!f) return;
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(f).entries());
    const btn = f.querySelector('[type=submit]'); if (btn) btn.disabled = true;
    const done = () => { if (btn) btn.disabled = false; };
    const kind = f.dataset.form;
    try {
      if (kind === 'conn') {
        st.conn = { url: fd.url.trim(), key: fd.key.trim() }; save(LS.conn, st.conn); render(); await refresh(false);
        if (st.error) toast('No conecta: ' + st.error);
        return;
      }
      if (kind === 'target') {
        const v = numIn(fd.targetWorld); if (!(v > 0 && v < 100)) return toast('Pon un valor entre 1 y 99');
        await write({ action: 'setConfig', values: { targetWorld: v / 100 } }, 'Objetivo guardado'); return;
      }
      if (kind === 'tr') {
        await write({ action: 'setConfig', values: { trRate: numIn(fd.trRate) / 100, trRateHigh: numIn(fd.trRateHigh) / 100, trThreshold: numIn(fd.trThreshold), trTax: numIn(fd.trTax) / 100 } }, 'Condiciones guardadas'); return;
      }
      if (kind === 'ing') {
        const S = C.summary(st.data, todayISO());
        const delta = Math.round((numIn(fd.saldo) - S.ingBalance) * 100) / 100;
        if (!delta) { closeSheet(); return; }
        await write({ action: 'upsert', table: 'Efectivo', rows: [{ cuenta: 'ING', fecha: todayISO(), importe: delta, tipo: 'ajuste', nota: 'Saldo actualizado a ' + fmtNum(numIn(fd.saldo)) + ' €' }] }, 'Saldo actualizado'); return;
      }
      if (kind === 'add-fondo') {
        const imp = numIn(fd.importe);
        let part = numIn(fd.part), nota = 'Aportación';
        if (!(part > 0)) {
          const a = st.data.assets.find((x) => x.id === fd.activo);
          const q = a && C.quote(st.data, a);
          if (!q) return toast('No hay VL para estimar: indica las participaciones');
          part = Math.round((imp / q.price) * 100) / 100; nota = 'Participaciones estimadas con VL ' + dShort(q.date) + ' (pendiente de confirmar)';
        }
        await write({ action: 'upsert', table: 'Lotes', rows: [{ activo: fd.activo, fecha_fiscal: fd.fecha, desde: fd.fecha, participaciones: part, coste: imp, aporta: imp, nota }] }, 'Aportación guardada'); return;
      }
      if (kind === 'add-accion') {
        const imp = numIn(fd.importe), part = numIn(fd.part);
        const ok = await write({ action: 'upsert', table: 'Lotes', rows: [{ activo: fd.activo, fecha_fiscal: fd.fecha, desde: fd.fecha, participaciones: part, coste: imp, aporta: imp, nota: 'Trade Republic' }] }, 'Compra guardada');
        if (ok) await api('POST', { action: 'upsert', table: 'Efectivo', rows: [{ cuenta: 'TR', fecha: fd.fecha, importe: -imp, tipo: 'compra', nota: 'Compra ' + fd.activo }] }).then(() => refresh(false)).catch((er) => toast('Ojo: falta descontar el efectivo (' + er.message + ')'));
        return;
      }
      if (kind === 'add-efectivo') {
        let imp = Math.abs(numIn(fd.importe));
        if (fd.tipo === 'retirada') imp = -imp;
        const row = { cuenta: fd.cuenta, fecha: fd.fecha, importe: imp, tipo: fd.tipo, nota: fd.nota || '' };
        if (fd.tipo === 'interes') { const d = new Date(fd.fecha + 'T12:00:00Z'); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); row.periodo = d.toISOString().slice(0, 7); }
        await write({ action: 'upsert', table: 'Efectivo', rows: [row] }, 'Movimiento guardado'); return;
      }
    } finally { done(); }
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });

  let toastT;
  function toast(msg) { const el = document.getElementById('toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 3200); }

  // ---------------------------------------------------------------- arranque
  render();
  if (st.conn) refresh(false);
  setInterval(() => { if (document.visibilityState === 'visible') refresh(false); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && st.at && Date.now() - new Date(st.at).getTime() > 60000) refresh(false);
  });
  window.addEventListener('resize', () => { if (st.tab === 'inicio' && st.data) mountChart(C.summary(st.data, todayISO()), todayISO()); });
  if ('serviceWorker' in navigator) {
    // Si llega una versión nueva de la app, se recarga una vez para no mezclar archivos viejos y nuevos
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js').then((r) => r.update()).catch(() => {});
  }

  // Para pruebas automáticas
  window.__mc = { st, render, fmtNum };
})();
