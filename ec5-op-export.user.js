// ==UserScript==
// @name         EC5 Отдел продаж — ночные выгрузки (Superset, ОМП, договоры)
// @namespace    cdek.maria.opexport
// @version      0.2.3
// @description  Ставится на ноут аналитика ОП (работает 24/7, залогинен в ЭК5 и Superset). Ночью ~05:00 и по кнопке выполняет задания с сервера и шлёт результат; плюс пассивно записывает запросы разделов ЭК5/Superset, чтобы задания можно было собрать без ручного разбора API.
// @author       Артём
// @match        https://*.cdek.ru/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      gateway.cdek.ru
// @connect      superset.cdek.ru
// @connect      5.42.124.252
// @downloadURL  http://5.42.124.252/ec5-op-9t3kq.user.js
// @updateURL    http://5.42.124.252/ec5-op-9t3kq.user.js
// @run-at       document-idle
// ==/UserScript==

/* Архитектура (чтобы не переустанавливать скрипт каждый раз):
 *  1) РАЗВЕДКА — на любой странице *.cdek.ru слушаем собственные запросы приложения (fetch/XHR)
 *     к gateway.cdek.ru и superset.cdek.ru и шлём адрес+тело+начало ответа в /ec5-op-probe.
 *     Когда аналитик один раз нажмёт «Выгрузить в Excel» в ОМП/Договорах или откроет дашборд
 *     маржинальности, нужные запросы окажутся на сервере.
 *  2) ЗАДАНИЯ — список берём с сервера (/ec5-op-config): {id, kind: 'superset'|'gateway',
 *     method, url, body, resp: 'json'|'xlsx'}. Выполняем ночью в слот (по умолчанию 05:00
 *     по часам ноута) и по кнопке меню, результат — в /ec5-op. Новое задание = правка конфига
 *     на сервере, скрипт трогать не надо. gateway-запросы идут с токеном pwt из ЭК5, поэтому
 *     исполнитель живёт только на вкладке ek5.cdek.ru (держать открытой, как обычно).
 */
(function () {
  'use strict';
  const SRV = 'http://5.42.124.252';
  const KEY = '__OP_KEY__';                          // подставляет сервер при выдаче файла
  const VER = '0.2.3';
  const SLOTS = ['05:00'];                           // локальное время ноута; окно 90 минут
  const cut = (s, n) => String(s == null ? '' : s).slice(0, n);
  const iso = (d) => d.toISOString().slice(0, 10);
  const log = (...a) => console.log('[op-export]', ...a);
  const gget = (k, d) => { try { return GM_getValue(k, d); } catch (e) { return d; } };
  const gset = (k, v) => { try { GM_setValue(k, v); } catch (e) {} };
  const pwt = () => { try { return sessionStorage.getItem('pwt') || localStorage.getItem('pwt') || ''; } catch (e) { return ''; } };

  function gm(method, url, body, headers, responseType) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({ method, url, data: body || null, headers: headers || {}, timeout: 180000, responseType: responseType || 'text',
        onload: (r) => res(r), onerror: () => rej(new Error('net ' + url)), ontimeout: () => rej(new Error('timeout ' + url)) });
    });
  }
  const post = (path, obj) => gm('POST', SRV + path + '?k=' + KEY, JSON.stringify(obj), { 'Content-Type': 'application/json' });

  // ---------- 1. РАЗВЕДКА ----------
  const seen = new Set(); let sent = 0, day = new Date().toDateString();
  // заголовки, которые ЭК5 ставит сам (язык, локаль и т.п.), запоминаем по сервису gateway — выгрузка повторяет их
  const SKIP_H = /^(x-auth-token|authorization|cookie|content-length|content-type|accept)$/i;
  const svc = (u) => { const m = /gateway\.cdek\.ru\/([^/?#]+)/.exec(String(u || '')); return m ? m[1] : ''; };
  function rememberHeaders(url, h) {
    try {
      const s = svc(url); if (!s || !h) return; const keep = {};
      Object.keys(h).forEach((k) => { if (!SKIP_H.test(k)) keep[k] = String(h[k]); });
      if (Object.keys(keep).length) gset('op:hdr:' + s, keep);
    } catch (e) {}
  }
  function probe(method, url, body, resp, hdrs) {
    try {
      rememberHeaders(url, hdrs);
      if (new Date().toDateString() !== day) { day = new Date().toDateString(); sent = 0; seen.clear(); }
      const u = String(url || '');
      if (u.indexOf('gateway.cdek.ru') === -1 && u.indexOf('superset.cdek.ru') === -1 && u.indexOf('/api/v1/') === -1 && u.indexOf('/web/') === -1) return;
      if (/front-metrics|web-metrics|navmessages|feature-toggle|sendStats|usersettingsstorage|autocomplete|prompts|isAllowed|rating-products|5\.42\.124\.252/.test(u)) return;
      const key = u.split('?')[0] + '|' + cut(body, 300);
      if (seen.has(key) || sent >= 300) return; seen.add(key); sent++;
      const hs = {}; Object.keys(hdrs || {}).forEach((k) => { hs[k] = SKIP_H.test(k) ? '<скрыт>' : String(hdrs[k]); });
      post('/ec5-op-probe', { method, url: cut(u, 400), body: cut(body, 20000), resp: cut(resp, 20000), headers: hs, host: location.host, page: cut(location.href, 200) }).catch(() => {});
    } catch (e) {}
  }
  try {
    const of = window.fetch;
    if (typeof of === 'function' && !of.__op) {
      const wf = function (input, init) {
        let url = ''; try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) {}
        const method = (init && init.method) || 'GET', body = (init && typeof init.body === 'string') ? init.body : '';
        const hd = {}; try { const h = (init && init.headers) || (input && input.headers); if (h) { if (typeof h.forEach === 'function') h.forEach((v, k) => { hd[k] = v; }); else Object.assign(hd, h); } } catch (e) {}
        const p = of.apply(this, arguments);
        try { p.then((r) => { try { const ct = r.headers.get('content-type') || ''; if (/json|text/.test(ct)) r.clone().text().then((t) => probe(method, url, body, t, hd)).catch(() => {}); else probe(method, url, body, '[' + ct + ']', hd); } catch (e) {} }).catch(() => {}); } catch (e) {}
        return p;
      };
      wf.__op = true; window.fetch = wf;
    }
  } catch (e) {}
  try {
    const XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XP && !XP.__op) {
      const oOpen = XP.open, oSend = XP.send, oSet = XP.setRequestHeader;
      XP.open = function (m, u) { try { this.__opm = m; this.__opu = u; this.__oph = {}; } catch (e) {} return oOpen.apply(this, arguments); };
      XP.setRequestHeader = function (k, v) { try { (this.__oph = this.__oph || {})[k] = v; } catch (e) {} return oSet.apply(this, arguments); };
      XP.send = function (body) {
        try { const u = this.__opu || '', m = this.__opm || 'GET', b = (typeof body === 'string') ? body : '';
          this.addEventListener('load', function () { try { const t = (this.responseType === '' || this.responseType === 'text') ? this.responseText : '[' + this.responseType + ']'; probe(m, u, b, t, this.__oph); } catch (e) {} }); } catch (e) {}
        return oSend.apply(this, arguments);
      };
      XP.__op = true;
    }
  } catch (e) {}

  // ---------- 2. ЗАДАНИЯ (только на ek5.cdek.ru) ----------
  if (location.host !== 'ek5.cdek.ru') return;
  async function loadJobs() {
    const r = await gm('GET', SRV + '/ec5-op-config?k=' + KEY);
    if (r.status !== 200) throw new Error('конфиг HTTP ' + r.status);
    return JSON.parse(r.responseText);
  }
  function b64(buf) { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
  async function runJob(job, slot) {
    let last;
    for (let a = 0; a < 3; a++) {
      try { return await runJobOnce(job, slot); }
      catch (e) { last = e; if (!/HTTP 40[13]/.test(String(e && e.message))) throw e; await new Promise((r) => setTimeout(r, 30000)); }
    }
    throw last;
  }
  async function runJobOnce(job, slot) {
    const t0 = Date.now();
    // база + заголовки, которые сам ЭК5 ставил этому сервису (язык и т.п.) + явные из задания
    const headers = Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' },
      job.kind === 'gateway' ? Object.assign({ 'X-User-Lang': 'rus', 'X-User-Locale': 'ru_RU' }, gget('op:hdr:' + svc(job.url), {}) || {}) : {},
      job.headers || {});
    if (job.kind === 'gateway') { if (!pwt()) throw new Error('нет токена pwt — ЭК5 не залогинен'); headers['X-Auth-Token'] = pwt(); }
    if (job.kind === 'superset') { headers['Origin'] = 'https://superset.cdek.ru'; headers['Referer'] = 'https://superset.cdek.ru/'; }
    let url = job.url, body = job.body;
    const now = new Date(), y = new Date(now.getTime() - 86400000);
    const mon0 = iso(new Date(now.getFullYear(), now.getMonth(), 1)), nxt0 = iso(new Date(now.getFullYear(), now.getMonth() + 1, 1));
    const sub = (s) => String(s).replace(/\{today\}/g, iso(now)).replace(/\{yesterday\}/g, iso(y)).replace(/\{month_start\}/g, mon0).replace(/\{next_month_start\}/g, nxt0)
      .replace(/\{today_ru\}/g, now.toLocaleDateString('ru-RU')).replace(/\{month_start_ru\}/g, new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString('ru-RU'))
      .replace(/\{pwt\}/g, pwt()); // некоторые сервисы (ОМП) ждут токен ещё и в теле запроса
    url = sub(url); if (body && typeof body !== 'string') body = JSON.stringify(body); if (body) body = sub(body);
    const payload = { job: job.id, kind: job.kind, slot, ver: VER, status: 0 };
    if (job.paginate) {
      // список страницами: offset += limit, пока страница не короче limit (или до maxRows)
      const pg = job.paginate, all = []; const base = JSON.parse(body || '{}'); const lim = pg.pageSize || 100;
      for (let off = 0; off < (pg.maxRows || 50000); off += lim) {
        base[pg.offsetField || 'offset'] = off; base[pg.limitField || 'limit'] = lim;
        const r = await gm(job.method || 'POST', url, JSON.stringify(base), headers, 'text');
        if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status + ' ' + cut(r.responseText, 200));
        const items = (JSON.parse(r.responseText || '{}')[pg.itemsKey || 'items']) || [];
        all.push.apply(all, items); payload.status = r.status;
        if (items.length < lim) break;
      }
      payload.text = JSON.stringify({ items: all });
    } else {
      const r = await gm(job.method || 'POST', url, body, headers, job.resp === 'json' ? 'text' : 'arraybuffer');
      payload.status = r.status;
      if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status + ' ' + (job.resp === 'json' ? cut(r.responseText, 200) : ''));
      if (job.resp === 'json') payload.text = String(r.responseText || '');
      else { payload.file_b64 = b64(r.response); payload.content_type = (/content-type:\s*([^\r\n;]+)/i.exec(r.responseHeaders || '') || [])[1] || ''; }
    }
    payload.took_ms = Date.now() - t0;
    const pr = await post('/ec5-op', payload);
    if (pr.status !== 200) throw new Error('сервер не принял: HTTP ' + pr.status + ' ' + cut(pr.responseText, 200));
    return JSON.parse(pr.responseText || '{}');
  }
  let busy = false;
  async function runAll(slot, manual) {
    if (busy) return; busy = true;
    const report = [];
    try {
      const cfg = await loadJobs();
      const today = iso(new Date());
      // авто-прогон делает только то, что сегодня ещё не выгрузилось (новое задание с сервера догоняется в тот же день)
      const jobs = (cfg.jobs || []).filter((j) => j.enabled !== false && (manual || gget('op:ok:' + j.id, '') !== today));
      if (!jobs.length) { if (!manual) gset('op:done', slot); log('заданий нет'); if (manual) alert('Выгрузки: заданий на сервере пока нет'); return; }
      for (const j of jobs) {
        try { const res = await runJob(j, slot); gset('op:ok:' + j.id, today); report.push('✅ ' + j.id + ': ' + (res.rows != null ? res.rows + ' строк' : 'ок')); log('ok', j.id, res); }
        catch (e) { report.push('❌ ' + j.id + ': ' + (e && e.message)); log('fail', j.id, e && e.message);
          post('/ec5-op', { job: j.id, kind: j.kind, slot, ver: VER, error: cut(e && e.message, 500) }).catch(() => {}); }
      }
      if (!manual) {
        const bad = report.some((x) => x.indexOf('❌') === 0);
        const tries = (gget('op:tries:' + slot, 0) || 0) + 1; gset('op:tries:' + slot, tries);
        if (!bad || tries >= 6) gset('op:done', slot);
      }
      if (manual) alert('Выгрузки:\n' + report.join('\n'));
    } catch (e) { log('не удалось:', e && e.message); if (manual) alert('Выгрузки: ' + (e && e.message)); }
    finally { busy = false; }
  }
  function slotId() {
    const d = new Date(), hm = d.getHours() * 60 + d.getMinutes();
    for (const s of SLOTS) { const t = s.split(':').map(Number), m = t[0] * 60 + t[1]; if (hm >= m && hm < m + 90) return iso(d) + '@' + s; }
    return null;
  }
  // Слот 05:00; если ноут спал/ЭК5 был закрыт — догоняем при первом открытии ЭК5 в тот же день (после 05:00).
  function tick() {
    const d = new Date(), id = slotId() || ((d.getHours() * 60 + d.getMinutes()) >= 5 * 60 ? iso(d) + '@05:00' : null);
    if (!id) return;
    if (gget('op:done', '') !== id) { runAll(id, false); return; }
    // раз в 30 мин сверяемся с сервером: появилось новое задание или какое-то сегодня не прошло — догоняем (до 6 попыток в день)
    if (Date.now() - (gget('op:cfgAt', 0) || 0) < 30 * 60 * 1000 || (gget('op:tries:' + id, 0) || 0) >= 6) return;
    gset('op:cfgAt', Date.now());
    loadJobs().then((cfg) => {
      const t = iso(new Date());
      if ((cfg.jobs || []).some((j) => j.enabled !== false && gget('op:ok:' + j.id, '') !== t)) runAll(id, false);
    }).catch(() => {});
  }
  // Меню ЭК5 целиком (адреса всех разделов) — раз в день на сервер, чтобы давать прямые ссылки на разделы
  setTimeout(async () => {
    try {
      if (gget('op:navDay2', '') === iso(new Date()) || !pwt()) return;
      const r = await gm('GET', 'https://gateway.cdek.ru/strapi-bff/web/collection/nav', null, { 'X-Auth-Token': pwt(), 'Accept': 'application/json' });
      if (r.status === 200) { await post('/ec5-op-probe', { method: 'NAV', url: 'nav-full', body: '', resp: String(r.responseText || ''), host: location.host, page: '' }); gset('op:navDay2', iso(new Date())); }
    } catch (e) {}
  }, 30 * 1000);
  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('📤 Выгрузить сейчас (ОП)', () => runAll('manual@' + new Date().toISOString().slice(0, 16), true));
  setTimeout(() => { post('/ec5-op', { job: '_heartbeat', ver: VER, slot: 'load', text: '' }).catch(() => {}); }, 15000);
  setInterval(() => { post('/ec5-op', { job: '_heartbeat', ver: VER, slot: 'tick' + (pwt() ? '' : '-nopwt'), text: '' }).catch(() => {}); }, 10 * 60 * 1000);
  setTimeout(tick, 60 * 1000); setInterval(tick, 5 * 60 * 1000);
})();
