/**
 * Mi Cartera — backend en Google Apps Script.
 *
 * Va pegado en una hoja de Google (Extensiones → Apps Script). La hoja es la base de datos:
 *   Config · Activos · Lotes · Efectivo · Precios · Registro
 *
 * Funciones:
 *   setup()       → crea las pestañas, genera la clave secreta y programa la actualización automática.
 *   actualizar()  → descarga el valor liquidativo de los fondos (BlackRock) y los cierres de las cotizaciones.
 *   doGet / doPost → API JSON protegida con la clave (lectura para la app, escritura para la app y para Claude).
 *
 * Este archivo no contiene datos personales: los datos viven solo en la hoja.
 */

var TABLES = {
  Config:   ['clave', 'valor'],
  Activos:  ['id', 'tipo', 'nombre', 'corto', 'isin', 'simbolo', 'moneda', 'clase', 'ter', 'fuente', 'url', 'stooq'],
  Lotes:    ['id', 'activo', 'fecha_fiscal', 'desde', 'hasta', 'participaciones', 'coste', 'aporta', 'nota'],
  Efectivo: ['id', 'cuenta', 'fecha', 'importe', 'tipo', 'periodo', 'nota'],
  Precios:  ['fecha', 'activo', 'precio', 'fuente'],
  Registro: ['fecha', 'mensaje']
};
var NUMERIC = {
  Activos: ['ter'],
  Lotes: ['participaciones', 'coste', 'aporta'],
  Efectivo: ['importe'],
  Precios: ['precio']
};
var WRITABLE = ['Activos', 'Lotes', 'Efectivo', 'Precios'];
var CONFIG_DEFAULTS = {
  trRate: 0.03, trRateHigh: 0.0253, trThreshold: 50000, trTax: 0.19,
  targetWorld: 0.8, historyStart: '2026-06-01'
};
var LIVE_CACHE_SECONDS = 600;

// ---------------------------------------------------------------- instalación

function setup() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(TABLES).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var cols = TABLES[name];
    sh.getRange(1, 1, 1000, cols.length).setNumberFormat('@'); // todo como texto: fechas y números sin conversiones raras
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    sh.setFrozenRows(1);
  });
  var cfg = readConfig_();
  Object.keys(CONFIG_DEFAULTS).forEach(function (k) { if (cfg[k] === undefined) cfg[k] = CONFIG_DEFAULTS[k]; });
  if (!cfg.apiKey) cfg.apiKey = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  writeConfig_(cfg);
  PropertiesService.getScriptProperties().setProperty('apiKey', String(cfg.apiKey));

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'actualizar') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('actualizar').timeBased().everyHours(6).create();
  log_('Instalación completada');
  Logger.log('CLAVE SECRETA (está también en la pestaña Config): ' + cfg.apiKey);
}

// ---------------------------------------------------------------- API

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'ping') return json_({ ok: true, app: 'mi-cartera' });
    checkKey_(p.key);
    if (p.action === 'refresh') { actualizar(); CacheService.getScriptCache().remove('live'); }
    return json_(buildData_());
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkKey_(body.key);
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var res = handleWrite_(body);
      return json_(res);
    } finally { lock.releaseLock(); }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function handleWrite_(body) {
  var action = body.action;
  if (action === 'refresh') { actualizar(); CacheService.getScriptCache().remove('live'); return { ok: true }; }
  if (action === 'setConfig') {
    var cfg = readConfig_();
    Object.keys(body.values || {}).forEach(function (k) { if (k !== 'apiKey') cfg[k] = body.values[k]; });
    writeConfig_(cfg);
    log_('Config: ' + Object.keys(body.values || {}).join(', '));
    return { ok: true };
  }
  var table = body.table;
  if (WRITABLE.indexOf(table) < 0) throw new Error('Tabla no permitida: ' + table);
  var rows = readTable_(table);
  var keyOf = table === 'Precios' ? function (r) { return r.fecha + '|' + r.activo; } : function (r) { return String(r.id); };
  if (action === 'upsert' || action === 'replace') {
    var incoming = (body.rows || []).map(function (r) { return sanitize_(table, r); });
    if (action === 'replace') rows = [];
    var idx = {};
    rows.forEach(function (r, i) { idx[keyOf(r)] = i; });
    incoming.forEach(function (r) {
      if (table !== 'Precios' && !r.id) r.id = table.slice(0, 1) + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
      var k = keyOf(r);
      if (idx[k] !== undefined) rows[idx[k]] = r; else { idx[k] = rows.length; rows.push(r); }
    });
    writeTable_(table, rows);
    log_(action + ' ' + table + ': ' + incoming.length + ' fila(s)');
    return { ok: true, count: incoming.length, ids: incoming.map(keyOf) };
  }
  if (action === 'delete') {
    var del = {};
    (body.ids || []).forEach(function (id) { del[String(id)] = true; });
    var before = rows.length;
    rows = rows.filter(function (r) { return !del[keyOf(r)]; });
    writeTable_(table, rows);
    log_('delete ' + table + ': ' + (before - rows.length) + ' fila(s)');
    return { ok: true, count: before - rows.length };
  }
  throw new Error('Acción desconocida: ' + action);
}

function sanitize_(table, r) {
  var out = {};
  TABLES[table].forEach(function (c) {
    var v = r[c];
    if (v === undefined || v === null) v = '';
    out[c] = (NUMERIC[table] || []).indexOf(c) >= 0 && v !== '' ? Number(v) : String(v);
  });
  return out;
}

function buildData_() {
  var cfg = readConfig_();
  delete cfg.apiKey;
  var assets = readTable_('Activos');
  var prices = {}, fx = [];
  readTable_('Precios').forEach(function (r) {
    if (r.activo === 'EURUSD') fx.push([r.fecha, r.precio]);
    else (prices[r.activo] = prices[r.activo] || []).push([r.fecha, r.precio]);
  });
  var byDate = function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; };
  Object.keys(prices).forEach(function (k) { prices[k].sort(byDate); });
  fx.sort(byDate);
  return {
    ok: true,
    generated: new Date().toISOString(),
    config: cfg,
    assets: assets,
    lots: readTable_('Lotes'),
    cash: readTable_('Efectivo'),
    prices: prices,
    fx: fx,
    live: getLive_(assets),
    lastUpdate: PropertiesService.getScriptProperties().getProperty('lastUpdate') || null
  };
}

// ---------------------------------------------------------------- actualización de precios

function actualizar() {
  var assets = readTable_('Activos');
  var lots = readTable_('Lotes');
  var cfg = readConfig_();
  var from = String(cfg.historyStart || CONFIG_DEFAULTS.historyStart);
  var earliest = lots.map(function (l) { return l.desde; }).filter(String).sort()[0];
  if (earliest && earliest < from) from = earliest;
  var newRows = [], errors = [];

  assets.forEach(function (a) {
    try {
      if (a.fuente === 'blackrock' && a.url) {
        var res = UrlFetchApp.fetch(a.url, { muteHttpExceptions: true, followRedirects: true });
        if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
        parseBlackRock(res.getContentText()).forEach(function (row) {
          if (row[0] >= from) newRows.push({ fecha: row[0], activo: a.id, precio: row[1], fuente: 'blackrock' });
        });
      } else if (a.simbolo && (a.tipo === 'accion' || a.tipo === 'indice' || a.tipo === 'fx')) {
        var hist = yahooHistory_(a.simbolo, from);
        if (!hist.length && a.stooq) hist = stooqHistory_(a.stooq, from);
        hist.forEach(function (row) { newRows.push({ fecha: row[0], activo: a.id, precio: row[1], fuente: 'mercado' }); });
      }
    } catch (err) { errors.push(a.id + ': ' + err.message); }
  });

  if (newRows.length) {
    var rows = readTable_('Precios'), idx = {};
    rows.forEach(function (r, i) { idx[r.fecha + '|' + r.activo] = i; });
    newRows.forEach(function (r) {
      var k = r.fecha + '|' + r.activo;
      if (idx[k] !== undefined) rows[idx[k]] = r; else { idx[k] = rows.length; rows.push(r); }
    });
    rows.sort(function (a, b) { return a.activo < b.activo ? -1 : a.activo > b.activo ? 1 : a.fecha < b.fecha ? -1 : 1; });
    writeTable_('Precios', rows);
  }
  PropertiesService.getScriptProperties().setProperty('lastUpdate', new Date().toISOString());
  log_('Actualización: ' + newRows.length + ' precios' + (errors.length ? ' · errores: ' + errors.join(' | ') : ''));
  return { prices: newRows.length, errors: errors };
}

/** Lee la pestaña "Histórico" del Excel (XML 2003) de BlackRock → [[YYYY-MM-DD, VL], ...] */
function parseBlackRock(text) {
  var start = text.indexOf('ss:Name="Histórico"');
  if (start < 0) start = text.indexOf('ss:Name="Historical"');
  if (start < 0) throw new Error('Formato BlackRock: no encuentro la pestaña Histórico');
  var end = text.indexOf('</ss:Worksheet>', start);
  var sheet = text.slice(start, end < 0 ? undefined : end);
  var months = { ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dic: 12, dec: 12 };
  var out = [];
  var rowRe = /<ss:Row[^>]*>([\s\S]*?)<\/ss:Row>/g, m;
  while ((m = rowRe.exec(sheet))) {
    var cells = [], cm, cellRe = /<ss:Data[^>]*>([^<]*)<\/ss:Data>/g;
    while ((cm = cellRe.exec(m[1]))) cells.push(cm[1].trim());
    if (cells.length < 2) continue;
    var dm = /^(\d{1,2})[\s\-\/]+([A-Za-zé\.]+)[\s\-\/]+(\d{4})$/.exec(cells[0]);
    if (!dm) continue;
    var mon = months[dm[2].toLowerCase().replace('.', '')];
    var nav = parseFloat(cells[1].replace(',', '.'));
    if (!mon || !isFinite(nav)) continue;
    out.push([dm[3] + '-' + ('0' + mon).slice(-2) + '-' + ('0' + dm[1]).slice(-2), nav]);
  }
  out.sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
  return out;
}

function yahooFetch_(symbol, query) {
  var hosts = ['query1', 'query2'];
  for (var i = 0; i < hosts.length; i++) {
    var url = 'https://' + hosts[i] + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?' + query;
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.getResponseCode() === 200) {
      var j = JSON.parse(res.getContentText());
      if (j.chart && j.chart.result && j.chart.result[0]) return j.chart.result[0];
    }
  }
  return null;
}

/** Cierres diarios → [[YYYY-MM-DD, cierre], ...] (fecha en la zona horaria del mercado) */
function parseYahooDaily(r) {
  if (!r || !r.timestamp) return [];
  var off = (r.meta && r.meta.gmtoffset) || 0;
  var closes = r.indicators.quote[0].close, out = [];
  r.timestamp.forEach(function (t, i) {
    if (closes[i] == null) return;
    out.push([new Date((t + off) * 1000).toISOString().slice(0, 10), closes[i]]);
  });
  return out;
}

function yahooHistory_(symbol, from) {
  var p1 = Math.floor(new Date(from + 'T00:00:00Z').getTime() / 1000) - 7 * 86400;
  var r = yahooFetch_(symbol, 'interval=1d&period1=' + p1 + '&period2=' + Math.floor(Date.now() / 1000));
  return parseYahooDaily(r).filter(function (x) { return x[0] >= from; });
}

/** Precio actual y cierre anterior a partir de la respuesta de Yahoo */
function parseYahooLive(r) {
  if (!r || !r.meta || r.meta.regularMarketPrice == null) return null;
  var off = r.meta.gmtoffset || 0;
  var t = r.meta.regularMarketTime || 0;
  var day = new Date((t + off) * 1000).toISOString().slice(0, 10);
  var daily = parseYahooDaily(r).filter(function (x) { return x[0] < day; });
  var prev = daily.length ? daily[daily.length - 1][1] : (r.meta.chartPreviousClose || r.meta.regularMarketPrice);
  return { price: r.meta.regularMarketPrice, prev: prev, date: day, time: t, currency: r.meta.currency };
}

function stooqHistory_(sym, from) {
  var res = UrlFetchApp.fetch('https://stooq.com/q/d/l/?s=' + encodeURIComponent(sym) + '&i=d', { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return [];
  return res.getContentText().split('\n').slice(1).map(function (l) { return l.split(','); })
    .filter(function (c) { return c.length >= 5 && c[0] >= from && isFinite(parseFloat(c[4])); })
    .map(function (c) { return [c[0], parseFloat(c[4])]; });
}

function getLive_(assets) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('live');
  if (hit) return JSON.parse(hit);
  var live = {};
  assets.forEach(function (a) {
    if (!a.simbolo || ['accion', 'indice', 'fx'].indexOf(a.tipo) < 0) return;
    try {
      var q = parseYahooLive(yahooFetch_(a.simbolo, 'interval=1d&range=5d'));
      if (!q && a.stooq) {
        var h = stooqHistory_(a.stooq, '2000-01-01').slice(-2);
        if (h.length) q = { price: h[h.length - 1][1], prev: h[0][1], date: h[h.length - 1][0], source: 'stooq' };
      }
      if (q) live[a.id] = q;
    } catch (err) { /* sin cotización: la app usa el último cierre guardado */ }
  });
  live._fetched = new Date().toISOString();
  cache.put('live', JSON.stringify(live), LIVE_CACHE_SECONDS);
  return live;
}

// ---------------------------------------------------------------- utilidades de la hoja

function sheet_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Falta la pestaña ' + name + ' (ejecuta setup)');
  return sh;
}

function readTable_(name) {
  var values = sheet_(name).getDataRange().getValues();
  if (values.length < 2) return [];
  var head = values[0].map(String), nums = NUMERIC[name] || [];
  return values.slice(1).filter(function (r) { return r.join('') !== ''; }).map(function (r) {
    var o = {};
    head.forEach(function (h, i) {
      var v = r[i];
      if (v instanceof Date) v = Utilities.formatDate(v, 'Etc/GMT', 'yyyy-MM-dd');
      o[h] = nums.indexOf(h) >= 0 && v !== '' ? Number(String(v).replace(',', '.')) : String(v);
    });
    return o;
  });
}

function writeTable_(name, rows) {
  var sh = sheet_(name), cols = TABLES[name];
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, cols.length).clearContent();
  if (!rows.length) return;
  var need = rows.length + 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  var range = sh.getRange(2, 1, rows.length, cols.length);
  range.setNumberFormat('@');
  range.setValues(rows.map(function (r) { return cols.map(function (c) { var v = r[c]; return v === undefined || v === null ? '' : String(v); }); }));
}

function readConfig_() {
  var sh = SpreadsheetApp.getActive().getSheetByName('Config');
  var cfg = {};
  if (!sh) return cfg;
  sh.getDataRange().getValues().slice(1).forEach(function (r) {
    if (r[0] === '') return;
    var v = r[1], n = Number(String(v).replace(',', '.'));
    cfg[r[0]] = v !== '' && isFinite(n) && !/^0\d/.test(String(v)) && String(r[0]) !== 'apiKey' ? n : String(v);
  });
  return cfg;
}

function writeConfig_(cfg) {
  var sh = sheet_('Config');
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 2).clearContent();
  var rows = Object.keys(cfg).map(function (k) { return [k, String(cfg[k])]; });
  if (rows.length) { var rg = sh.getRange(2, 1, rows.length, 2); rg.setNumberFormat('@'); rg.setValues(rows); }
}

function checkKey_(key) {
  var props = PropertiesService.getScriptProperties();
  var real = props.getProperty('apiKey');
  if (!real) { real = String(readConfig_().apiKey || ''); if (real) props.setProperty('apiKey', real); }
  if (!real || !key || String(key) !== real) throw new Error('Clave incorrecta');
}

function log_(msg) {
  try {
    var sh = sheet_('Registro');
    sh.insertRowAfter(1);
    sh.getRange(2, 1, 1, 2).setValues([[new Date().toISOString(), String(msg).slice(0, 500)]]);
    var max = 300;
    if (sh.getLastRow() > max + 1) sh.deleteRows(max + 2, sh.getLastRow() - max - 1);
  } catch (e) { /* el registro nunca debe romper la API */ }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
