/*
 * Mi Cartera — motor de cálculo.
 * Funciones puras: reciben los datos tal como los sirve el backend y devuelven cifras.
 * Se usa en el navegador (window.Core) y en Node para las pruebas (module.exports).
 *
 * Convenciones:
 *  - Fechas: 'YYYY-MM-DD' (texto). Se comparan como texto.
 *  - Lote activo en la fecha d: desde <= d y (sin hasta o d <= hasta). "hasta" = último día que se tuvo.
 *  - coste  = coste fiscal del lote (FIFO, como MyInvestor). aporta = dinero propio nuevo que entró con ese lote
 *    (0 en lotes que vienen de un traspaso interno o de un bono).
 *  - Precios en moneda nativa del activo; los activos en USD se pasan a EUR con EUR/USD.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY = 86400000;
  const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

  function toDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
  function iso(dt) { return dt.toISOString().slice(0, 10); }
  function addDays(s, n) { return iso(new Date(toDate(s).getTime() + n * DAY)); }
  function daysBetween(a, b) { return Math.round((toDate(b) - toDate(a)) / DAY); }
  function firstOfNextMonth(s) { const d = toDate(s); return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))); }
  function monthOf(s) { return s.slice(0, 7); }
  function prevMonth(m) { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 2, 1)); return iso(d).slice(0, 7); }

  function num(x) { const n = typeof x === 'number' ? x : parseFloat(String(x).replace(',', '.')); return isFinite(n) ? n : 0; }

  // Último valor de una serie [[fecha, valor], ...] (ordenada) con fecha <= d.
  function valueAt(series, d) {
    if (!series || !series.length) return null;
    let lo = 0, hi = series.length - 1, ans = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid][0] <= d) { ans = series[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function salesUpTo(data, d) {
    return data.cash.filter((c) => c.tipo === 'venta' && c.fecha <= d).reduce((s, c) => s + num(c.importe), 0);
  }
  function isActive(lot, d) { return lot.desde <= d && (!lot.hasta || d <= lot.hasta); }

  function cfg(data, k, def) { const v = data.config && data.config[k]; return v === undefined || v === '' ? def : num(v); }

  // ---------- Precios ----------
  function fxNow(data) {
    const l = data.live && data.live.EURUSD;
    if (l && l.price) return { rate: l.price, prev: l.prev || l.price, date: l.date };
    const p = valueAt(data.fx, '9999-12-31');
    return p ? { rate: p[1], prev: p[1], date: p[0] } : { rate: null, prev: null, date: null };
  }
  function fxAt(data, d) { const p = valueAt(data.fx, d); if (p) return p[1]; return fxNow(data).rate; }

  // Precio actual y anterior de un activo, en EUR.
  function quote(data, asset) {
    const series = data.prices && data.prices[asset.id];
    const usd = asset.moneda === 'USD';
    if (asset.tipo === 'fondo') {
      if (!series || !series.length) return null;
      const last = series[series.length - 1], prev = series.length > 1 ? series[series.length - 2] : last;
      // MyInvestor valora con el VL redondeado a 3 decimales: se hace igual para que las cifras coincidan
      const dec = cfg(data, 'navDecimals', 3), k = Math.pow(10, dec);
      const r = (x) => Math.round(x * k) / k;
      return { price: r(last[1]), prev: r(prev[1]), date: last[0], prevDate: prev[0], live: false, nav: last[1] };
    }
    const live = data.live && data.live[asset.id];
    const fx = fxNow(data);
    if (live && live.price) {
      const k = usd ? 1 / (fx.rate || 1) : 1, kp = usd ? 1 / (fx.prev || fx.rate || 1) : 1;
      return { price: live.price * k, prev: (live.prev || live.price) * kp, date: live.date, live: true, native: live.price, nativePrev: live.prev };
    }
    if (series && series.length) {
      const last = series[series.length - 1], prev = series.length > 1 ? series[series.length - 2] : last;
      const k = usd ? 1 / (fxAt(data, last[0]) || 1) : 1, kp = usd ? 1 / (fxAt(data, prev[0]) || 1) : 1;
      return { price: last[1] * k, prev: prev[1] * kp, date: last[0], live: false, native: last[1], nativePrev: prev[1] };
    }
    return null;
  }

  function priceEURAt(data, asset, d) {
    const p = valueAt(data.prices && data.prices[asset.id], d);
    if (!p) return null;
    return asset.moneda === 'USD' ? p[1] / (fxAt(data, d) || 1) : p[1];
  }

  // ---------- Posiciones ----------
  function positions(data, today) {
    const out = [];
    for (const a of data.assets.filter((x) => x.tipo === 'fondo' || x.tipo === 'accion')) {
      const lots = data.lots.filter((l) => l.activo === a.id);
      if (!lots.length) continue;
      const act = lots.filter((l) => isActive(l, today));
      const shares = act.reduce((s, l) => s + num(l.participaciones), 0);
      if (shares <= 1e-9) continue;
      const cost = act.reduce((s, l) => s + num(l.coste), 0);
      const aporta = lots.filter((l) => l.desde <= today).reduce((s, l) => s + num(l.aporta), 0);
      const q = quote(data, a);
      // Si no hay precio, se valora al coste para no inventar ganancias.
      const price = q ? q.price : cost / shares;
      const value = shares * price;
      const day = q ? shares * (q.price - q.prev) : 0;
      const lotRows = act.map((l) => {
        const v = num(l.participaciones) * price;
        return { ...l, valor: v, resultado: v - num(l.coste) };
      }).sort((x, y) => (x.fecha_fiscal < y.fecha_fiscal ? -1 : 1));
      out.push({
        asset: a, shares, cost, aporta, price, value,
        gain: value - cost, gainPct: cost ? (value - cost) / cost : 0,
        day, dayPct: q && q.prev ? (q.price - q.prev) / q.prev : 0,
        quote: q, lots: lotRows,
      });
    }
    return out;
  }

  // ---------- Efectivo e intereses de Trade Republic ----------
  function cashBalance(data, cuenta, d) {
    return data.cash.filter((c) => c.cuenta === cuenta && c.fecha <= d).reduce((s, c) => s + num(c.importe), 0);
  }

  function trInterest(data, today) {
    const r1 = cfg(data, 'trRate', 0.03), r2 = cfg(data, 'trRateHigh', 0.0253);
    const thr = cfg(data, 'trThreshold', 50000), tax = cfg(data, 'trTax', 0.19);
    const movs = data.cash.filter((c) => c.cuenta === 'TR').slice().sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
    if (!movs.length) return null;
    const dailyGross = (b) => (Math.min(b, thr) * r1 + Math.max(b - thr, 0) * r2) / 365;
    const netOf = (g) => { const gross = round2(g); return round2(gross - round2(gross * tax)); };

    const paidReal = {};
    for (const m of movs) if (m.tipo === 'interes' && m.periodo) paidReal[m.periodo] = m;

    const synthetic = []; // cobros estimados (meses ya cerrados sin cobro registrado)
    const accrued = {};   // devengo bruto por mes
    let base = 0, i = 0;
    const start = movs[0].fecha;
    let synthSum = 0;
    for (let d = start; d < today; d = addDays(d, 1)) {
      const m = monthOf(d);
      if (d.endsWith('-01')) {
        const pm = prevMonth(m);
        if (accrued[pm] && !paidReal[pm]) {
          const net = netOf(accrued[pm]);
          synthetic.push({ periodo: pm, fecha: d, importe: net, bruto: round2(accrued[pm]), estimado: true });
          synthSum += net;
        }
      }
      while (i < movs.length && movs[i].fecha <= d) { base += num(movs[i].importe); i++; }
      const bal = base + synthSum;
      accrued[m] = (accrued[m] || 0) + dailyGross(bal);
    }
    // Saldo actual (incluye movimientos de hoy y cobros estimados)
    let balance = cashBalance(data, 'TR', today) + synthetic.reduce((s, x) => s + x.importe, 0);
    const curM = monthOf(today);
    if (today.endsWith('-01')) {
      const pm = prevMonth(curM);
      if (accrued[pm] && !paidReal[pm] && !synthetic.find((s) => s.periodo === pm)) {
        const net = netOf(accrued[pm]);
        synthetic.push({ periodo: pm, fecha: today, importe: net, bruto: round2(accrued[pm]), estimado: true });
        balance += net;
      }
    }
    const grossMonth = accrued[curM] || 0;
    const perDay = dailyGross(balance);
    const nextPay = firstOfNextMonth(today);
    const remaining = daysBetween(today, nextPay); // días que faltan por devengar, hoy incluido
    const projGross = grossMonth + perDay * remaining;
    const payouts = movs.filter((m) => m.tipo === 'interes').map((m) => ({ periodo: m.periodo, fecha: m.fecha, importe: num(m.importe), estimado: false }))
      .concat(synthetic).sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
    const firstMonthDay = start > curM + '-01' ? start : curM + '-01';
    return {
      balance, rate: r1, tax,
      monthGross: grossMonth, monthNet: grossMonth * (1 - tax),
      perDayGross: perDay, perDayNet: perDay * (1 - tax),
      nextPay, projGross, projNet: netOf(projGross),
      daysAccrued: Math.max(0, daysBetween(firstMonthDay, today)),
      payouts,
      totalPaidNet: payouts.reduce((s, p) => s + p.importe, 0),
    };
  }

  // ---------- Resumen ----------
  function summary(data, today) {
    const pos = positions(data, today);
    const funds = pos.filter((p) => p.asset.tipo === 'fondo');
    const stocks = pos.filter((p) => p.asset.tipo === 'accion');
    const sum = (arr, k) => arr.reduce((s, p) => s + p[k], 0);
    const tr = trInterest(data, today);
    const trBal = tr ? tr.balance : cashBalance(data, 'TR', today);
    const ing = cashBalance(data, 'ING', today);

    const fundsValue = sum(funds, 'value'), stocksValue = sum(stocks, 'value');
    const investValue = fundsValue + stocksValue;
    // Aportado: dinero propio que entró en inversiones (incluye lotes ya traspasados; los traspasos internos aportan 0).
    // Las ventas (Efectivo tipo "venta") devuelven dinero: restan de lo aportado, así que un resultado realizado queda dentro de la ganancia.
    const salesTotal = salesUpTo(data, today);
    const aportado = data.lots.filter((l) => l.desde <= today).reduce((s, l) => s + num(l.aporta), 0) - salesTotal;
    const assetById = Object.fromEntries(data.assets.map((a) => [a.id, a]));
    const soldStockAporta = data.lots.filter((l) => l.hasta && l.hasta <= today && assetById[l.activo] && assetById[l.activo].tipo === 'accion').reduce((s, l) => s + num(l.aporta), 0);
    const stocksRealized = salesTotal ? salesTotal - soldStockAporta : 0;
    const gain = investValue - aportado;
    const day = sum(pos, 'day') + (tr ? tr.perDayNet : 0);

    // Fecha del último VL de fondos
    const navDate = funds.map((p) => p.quote && p.quote.date).filter(Boolean).sort().pop() || null;

    const world = funds.find((p) => p.asset.clase === 'world');
    const em = funds.find((p) => p.asset.clase === 'em');
    const target = cfg(data, 'targetWorld', 0.8);
    let rebalance = null;
    if (world && em && fundsValue > 0) {
      const w = world.value / fundsValue;
      if (w < target) rebalance = { to: world.asset, amount: (target * fundsValue - world.value) / (1 - target) };
      else rebalance = { to: em.asset, amount: ((1 - target) * fundsValue - em.value) / target };
    }

    // XIRR solo con 12 meses de historial
    const firstDate = data.lots.map((l) => l.desde).sort()[0];
    let xirrVal = null;
    if (firstDate && daysBetween(firstDate, today) >= 365) {
      const flows = data.lots.filter((l) => num(l.aporta) !== 0 && l.desde <= today).map((l) => [l.desde, -num(l.aporta)]);
      data.cash.filter((c) => c.tipo === 'venta' && c.fecha <= today).forEach((c) => flows.push([c.fecha, num(c.importe)]));
      flows.push([today, investValue]);
      xirrVal = xirr(flows);
    }

    return {
      today, positions: pos, funds, stocks, world, em, tr,
      fundsValue, stocksValue, investValue, trBalance: trBal, ingBalance: ing,
      total: investValue + trBal + ing,
      aportado, gain, gainPct: aportado ? gain / aportado : 0,
      day, navDate, target, rebalance,
      worldWeight: world && fundsValue ? world.value / fundsValue : null,
      emWeight: em && fundsValue ? em.value / fundsValue : null,
      firstDate, xirr: xirrVal,
      stocksAporta: sum(stocks, 'aporta'), stocksCost: sum(stocks, 'cost'),
      salesTotal, stocksRealized, soldStockAporta,
    };
  }

  // ---------- Historial diario de inversiones ----------
  function history(data, today) {
    const lots = data.lots;
    if (!lots.length) return [];
    const assets = Object.fromEntries(data.assets.map((a) => [a.id, a]));
    const start = lots.map((l) => l.desde).sort()[0];
    const out = [];
    for (let d = start; d <= today; d = addDays(d, 1)) {
      let value = 0, aportado = 0, ok = true;
      for (const l of lots) {
        if (l.desde <= d) aportado += num(l.aporta);
        if (!isActive(l, d)) continue;
        const a = assets[l.activo];
        let p = a ? priceEURAt(data, a, d) : null;
        if (p == null) p = num(l.participaciones) ? num(l.coste) / num(l.participaciones) : 0; // sin precio aún: al coste
        value += num(l.participaciones) * p;
      }
      aportado -= salesUpTo(data, d);
      if (ok) out.push([d, value, aportado]);
    }
    // Último punto con precios actuales (incluye cotización en vivo de acciones)
    const s = summary(data, today);
    if (out.length) out[out.length - 1] = [today, s.investValue, s.aportado];
    return out;
  }

  // ---------- XIRR ----------
  function xirr(flows) {
    if (flows.length < 2) return null;
    const t0 = toDate(flows[0][0]);
    const f = (r) => flows.reduce((s, [d, v]) => s + v / Math.pow(1 + r, (toDate(d) - t0) / DAY / 365), 0);
    let lo = -0.99, hi = 10;
    if (f(lo) * f(hi) > 0) return null;
    for (let k = 0; k < 200; k++) {
      const mid = (lo + hi) / 2;
      if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  // ---------- Mercados ----------
  function markets(data) {
    const out = [];
    for (const a of data.assets.filter((x) => x.tipo === 'indice')) {
      const l = data.live && data.live[a.id];
      if (l && l.price) out.push({ asset: a, price: l.price, pct: l.prev ? (l.price - l.prev) / l.prev : null, date: l.date });
      else out.push({ asset: a, price: null, pct: null });
    }
    const fx = fxNow(data);
    out.push({ asset: { id: 'EURUSD', nombre: 'EUR/USD', corto: 'EUR/USD' }, price: fx.rate, pct: fx.prev ? (fx.rate - fx.prev) / fx.prev : null, date: fx.date, fx: true });
    return out;
  }

  // Reparte una aportación nueva entre World y EM para acercarse al objetivo sin vender nada.
  // Si la aportación no basta para llegar, va entera al fondo infraponderado. Importes a euros enteros.
  function splitContribution(worldValue, emValue, target, amount) {
    const total = worldValue + emValue + amount;
    let toWorld = Math.round(target * total - worldValue);
    toWorld = Math.min(Math.max(toWorld, 0), Math.round(amount * 100) / 100);
    const toEM = Math.round((amount - toWorld) * 100) / 100;
    const w = worldValue + toWorld, e = emValue + toEM;
    // Cuánto haría falta para llegar exactamente al objetivo (0 si ya se llega con esta aportación)
    const need = worldValue / (worldValue + emValue) < target
      ? Math.max(0, (target * (worldValue + emValue) - worldValue) / (1 - target))
      : Math.max(0, ((1 - target) * (worldValue + emValue) - emValue) / target);
    return { toWorld, toEM, weightAfter: w + e ? w / (w + e) : null, need, reaches: amount >= need - 0.5 };
  }

  function stockMovers(sum) {
    const st = sum.stocks.filter((p) => p.quote && p.quote.prev).map((p) => ({ asset: p.asset, pct: p.dayPct }));
    if (!st.length) return null;
    st.sort((a, b) => b.pct - a.pct);
    return { best: st[0], worst: st[st.length - 1] };
  }

  return { round2, addDays, daysBetween, valueAt, isActive, quote, positions, trInterest, summary, history, xirr, markets, stockMovers, splitContribution, cashBalance, firstOfNextMonth };
});
