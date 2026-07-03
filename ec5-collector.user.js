// ==UserScript==
// @name         EC5 База проходящего трафика (сбор по ПВЗ)
// @namespace    cdek.maria.traffic
// @version      0.8.0
// @description  Собирает за день клиентов ПВЗ из EC5 (физики-отправители = лиды + выдача), авто-определяя офис аккаунта. Богатые колонки для фильтрации в таблице. Запуск из меню Tampermonkey.
// @match        https://orderec5ng.cdek.ru/*
// @match        https://ek5.cdek.ru/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      gateway.cdek.ru
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @downloadURL  https://raw.githubusercontent.com/Newcom12/cdek-ec5/main/ec5-collector.user.js
// @updateURL    https://raw.githubusercontent.com/Newcom12/cdek-ec5/main/ec5-collector.user.js
// @run-at       document-idle
// ==/UserScript==

/*
  МОДЕЛЬ ДАННЫХ EC5 (разведано 26-28.06.2026):
  - Журнал сетевой (ФИО видны по любому офису), но ТЕЛЕФОН в getByNumber открыт ТОЛЬКО для офиса
    ТЕКУЩЕГО аккаунта; у чужих офисов "***". Поэтому офис определяем по аккаунту, не по хардкоду.
  - Офис аккаунта = sender.office.code последнего заказа, "оформленного моим ПВЗ"
    (фильтр orderFromMyOfficeFlag=true). Авто-подстройка под любой кабинет/ИП.
  - ДВЕ стороны трафика:
      ОТПРАВИТЕЛИ (клиент пришёл ОФОРМИТЬ/отправить) = фильтр orderFromMyOfficeFlag=true.
        Это в основном физики (Тип заказа "Доставка"); без договора = ЛИДЫ (предложить договор).
      ПОЛУЧАТЕЛИ (клиент пришёл ЗАБРАТЬ) = фильтр receiverOffice=<код офиса>.
        Тут видны и интернет-магазины (договорники).
  - Карточка: order/getByNumber {orderNumber} -> j.order: sender/receiver {contragent.contragentName,
      phones[0].number, city.cityName, office}, main.payerType. Тип заказа и № договора берём из списка.
  - Авторизация: заголовок X-Auth-Token = sessionStorage.pwt. Дата: orderDateFrom/orderDateTo (dd.MM.yyyy).
*/

(function () {
  'use strict';

  const CONFIG = {
    GATEWAY: 'https://gateway.cdek.ru',
    INGEST_URL: 'https://script.google.com/macros/s/AKfycbwjkZZyWqF1Xt9TrpgF29bGE8klRrAhxQPzONPTh2AcGnG7ztYObcvYLVNphXreqXwwLw/exec',
    PAGE_LIMIT: 100,
    MAX_PER_SIDE: 50000,     // практически без потолка
    CONCURRENCY: 10,         // параллельных getByNumber
    LIST_THROTTLE_MS: 120,
    ENRICH_JITTER_MS: 40,
    NA: '—',
  };

  // коды офисов -> человеческие имена листов (если код неизвестен — берём имя офиса из EC5)
  const PVZ_NAMES = { KAM32: 'Фуд-Сити', MSK548: 'Садовод-1', MSK2432: 'Садовод-2', MSK456: 'ТЯК' };

  const todayDDMMYYYY = () => {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const token = () => sessionStorage.getItem('pwt') || localStorage.getItem('pwt') || '';
  const realPhone = (p) => !!p && p !== CONFIG.NA && !String(p).includes('*');

  // пул параллельных задач
  async function pool(items, worker, c) {
    const ret = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(c, items.length) }, async () => {
      while (i < items.length) { const k = i++; try { ret[k] = await worker(items[k]); } catch (e) { ret[k] = null; } }
    }));
    return ret;
  }

  // кэш обработанных за день (повторные запуски берут только новых)
  const seenKey = (d) => 'ec5seen3:' + d;
  const loadSeen = (d) => { try { return new Set(JSON.parse(localStorage.getItem(seenKey(d)) || '[]')); } catch (e) { return new Set(); } };
  const saveSeen = (d, s) => { try { localStorage.setItem(seenKey(d), JSON.stringify([...s])); } catch (e) {} };

  function http(method, url, body) {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Auth-Token': token(), 'X-User-Locale': 'ru' };
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method, url, headers, data: body ? JSON.stringify(body) : undefined,
          onload: (r) => { try { resolve({ status: r.status, json: JSON.parse(r.responseText) }); } catch (e) { resolve({ status: r.status, json: null }); } },
          onerror: (e) => reject(new Error('net ' + (e && e.error))),
        });
      });
    }
    return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  }
  const LIST = () => CONFIG.GATEWAY + '/order/web/journal/getFilterData';
  const CARD = () => CONFIG.GATEWAY + '/order/web/order/getByNumber';

  // офис текущего аккаунта — надёжно (2 способа + ретраи)
  async function officeFromOrder(orderNumber) {
    for (let a = 0; a < 3; a++) {
      try {
        const d = await http('POST', CARD(), { orderNumber });
        const o = (d.json || {}).order;
        if (o) {
          const snd = o.sender || {}, rec = o.receiver || {};
          const sp = snd.phones && snd.phones[0] && snd.phones[0].number;
          const rp = rec.phones && rec.phones[0] && rec.phones[0].number;
          // офис = та сторона, где телефон НЕ замаскирован (= наш офис на этом аккаунте)
          if (realPhone(sp) && snd.office && snd.office.code) return { code: snd.office.code, name: snd.office.name };
          if (realPhone(rp) && rec.office && rec.office.code) return { code: rec.office.code, name: rec.office.name };
          return { _order: o };  // карта есть, но телефоны скрыты — вернём для запасной логики
        }
      } catch (e) { /* ретрай */ }
      await sleep(400);
    }
    return null;
  }

  async function detectOffice(log) {
    // способ 1: последний "оформлен моим ПВЗ" -> его офис-отправитель
    try {
      const r = await http('POST', LIST(), {
        sort: [{ field: 'orderDate', value: 'desc' }], offset: 0, limit: 1,
        fields: [{ field: 'orderFromMyOfficeFlag', value: true, values: null }], columns: ['orderNumber'],
      });
      const it = r.json && (r.json.items || [])[0];
      if (it) {
        const d = await http('POST', CARD(), { orderNumber: it.orderNumber });
        const off = (((d.json || {}).order || {}).sender || {}).office || {};
        if (off.code) return { code: off.code, name: off.name };
      }
    } catch (e) { /* к способу 2 */ }

    // способ 2 (запасной): перебираем известные коды ПВЗ; где телефон открыт — тот офис наш
    log('Определяю офис перебором (запасной способ)…');
    for (const code of Object.keys(PVZ_NAMES)) {
      try {
        const r = await http('POST', LIST(), {
          sort: [{ field: 'orderDate', value: 'desc' }], offset: 0, limit: 1,
          fields: [{ field: 'receiverOffice', value: null, values: [code] }], columns: ['orderNumber'],
        });
        const it = r.json && (r.json.items || [])[0];
        if (!it) continue;
        const res = await officeFromOrder(it.orderNumber);
        if (res && res.code) return { code: res.code, name: res.name };
      } catch (e) { /* следующий код */ }
    }
    return null;
  }

  // полный список по фильтру за дату
  async function listSide(extraField, dateFrom, dateTo, label, log) {
    const recs = []; let offset = 0;
    while (true) {
      const r = await http('POST', LIST(), {
        sort: [{ field: 'orderDate', value: 'desc' }], offset, limit: CONFIG.PAGE_LIMIT,
        fields: [extraField, { field: 'orderDateFrom', value: dateFrom, values: null }, { field: 'orderDateTo', value: dateTo, values: null }],
        columns: ['orderNumber', 'orderDate', 'orderStatus', 'orderType', 'contractNumber'],
      });
      if (r.status !== 200 || !r.json) { log(`${label}: список HTTP ${r.status}`); break; }
      const items = r.json.items || [];
      recs.push(...items);
      offset += items.length;
      if (items.length < CONFIG.PAGE_LIMIT || recs.length >= CONFIG.MAX_PER_SIDE) break;
      await sleep(CONFIG.LIST_THROTTLE_MS);
    }
    return recs;
  }

  // карточка -> строка; client = сторона, где клиент пришёл (отправитель/получатель)
  async function enrichRow(it, role, pvz) {
    if (CONFIG.ENRICH_JITTER_MS) await sleep(Math.random() * CONFIG.ENRICH_JITTER_MS);
    let fio = null, phone = CONFIG.NA, from = '', to = '';
    try {
      const d = await http('POST', CARD(), { orderNumber: it.orderNumber });
      const o = (d.json && d.json.order) || {};
      const snd = o.sender || {}, rec = o.receiver || {};
      const me = role === 'отправитель' ? snd : rec;
      fio = (me.contragent && me.contragent.contragentName) || me.contactName || null;
      const ph = me.phones && me.phones[0] && me.phones[0].number;
      if (ph) phone = ph;
      from = (snd.city && snd.city.cityName) || '';
      to = (rec.city && rec.city.cityName) || '';
    } catch (e) { /* заглушки */ }
    return {
      pvz, date: it.orderDate, role,
      fioClient: fio || CONFIG.NA, phone,
      orderType: it.orderType || '',
      dogovor: it.contractNumber ? 'да' : 'нет',
      contract: it.contractNumber || '',
      status: it.orderStatus || '',
      from, to,
      orderNumber: it.orderNumber,
    };
  }

  async function collectSide(label, role, listFields, pvz, seen, log) {
    const recs = (await listSide(listFields, todayDDMMYYYY(), todayDDMMYYYY(), label, log)).filter((it) => !seen.has(it.orderNumber));
    log(`${label}: новых ${recs.length}`);
    if (!recs.length) return [];
    let done = 0;
    const rows = await pool(recs, async (it) => {
      const row = await enrichRow(it, role, pvz); seen.add(it.orderNumber);
      if (++done % 200 === 0) log(`${label}: ${done}/${recs.length}`);
      return row;
    }, CONFIG.CONCURRENCY);
    // оставляем строки с реальным телефоном клиента (= свой офис)
    return rows.filter(Boolean).filter((r) => realPhone(r.phone));
  }

  async function run(log) {
    if (!token()) { log('❌ Не вижу вход в EC5. Откройте/обновите EC5.'); return { ok: false, reason: 'no-login' }; }
    const t0 = Date.now();
    const date = todayDDMMYYYY();
    const seen = loadSeen(date);

    const office = await detectOffice(log);
    if (!office) { log('❌ Не удалось определить офис аккаунта'); return { ok: false, reason: 'no-office' }; }
    const pvz = PVZ_NAMES[office.code] || office.name || office.code;
    log(`Офис аккаунта: ${pvz} (${office.code})`);

    let all = [];
    // 1) ОТПРАВИТЕЛИ (физики-лиды) — оформлено нашим ПВЗ
    try {
      all = all.concat(await collectSide('Отправители (оформление)', 'отправитель',
        { field: 'orderFromMyOfficeFlag', value: true, values: null }, pvz, seen, log));
      saveSeen(date, seen);
    } catch (e) { log('Отправители: ошибка ' + (e && e.message)); }
    // 2) ПОЛУЧАТЕЛИ (выдача, в т.ч. договорники) — receiverOffice = наш офис
    try {
      all = all.concat(await collectSide('Получатели (выдача)', 'получатель',
        { field: 'receiverOffice', value: null, values: [office.code] }, pvz, seen, log));
      saveSeen(date, seen);
    } catch (e) { log('Получатели: ошибка ' + (e && e.message)); }

    const leads = all.filter((r) => r.orderType === 'Доставка' && r.dogovor === 'нет').length;
    const secs = Math.round((Date.now() - t0) / 1000);
    log(`Итого новых: ${all.length} за ${secs}с. Из них физиков без договора (лиды): ${leads}.`);
    if (!all.length) return { ok: true, count: 0 };

    const payload = { source: 'ec5-traffic-userscript', version: '0.8.0', date, pvz, records: all };
    let sent = false;
    try {
      const res = await http('POST', CONFIG.INGEST_URL, payload);
      sent = res.status >= 200 && res.status < 300;
      log(sent ? `✅ Отправлено в таблицу: ${all.length}` : `⚠️ Таблица ответила ${res.status}`);
    } catch (e) { log('⚠️ Не достучался до таблицы: ' + (e && e.message)); }
    return { ok: true, count: all.length, leads, sent };
  }

  // ---------- Активация: меню Tampermonkey / Ctrl+Alt+E ----------
  let running = false;
  function toastBox() {
    let p = document.getElementById('ec5-traffic-toast');
    if (!p) {
      p = document.createElement('div'); p.id = 'ec5-traffic-toast';
      Object.assign(p.style, { position: 'fixed', right: '18px', bottom: '18px', zIndex: 2147483647, width: '340px',
        maxHeight: '46vh', overflow: 'auto', background: '#fff', color: '#222', border: '1px solid #ccc',
        borderRadius: '10px', padding: '10px 12px', font: '13px/1.5 sans-serif', boxShadow: '0 6px 18px rgba(0,0,0,.28)' });
      document.body.appendChild(p);
    }
    p.style.display = 'block'; return p;
  }
  async function activate() {
    if (running) return; running = true;
    const p = toastBox(); p.innerHTML = '';
    const head = document.createElement('div'); head.style.cssText = 'font-weight:600;margin-bottom:6px';
    head.textContent = '📥 Сбор базы за сегодня…';
    const body = document.createElement('div'); body.style.cssText = 'font:12px/1.5 monospace';
    p.appendChild(head); p.appendChild(body);
    const log = (m) => { body.insertAdjacentHTML('afterbegin', `<div>${m}</div>`); };
    let res; try { res = await run(log); } catch (e) { res = { ok: false, msg: String(e && e.message || e) }; }
    running = false;
    if (res && res.ok && res.count > 0) { head.textContent = `✅ Готово: ${res.count} (лидов ${res.leads || 0})`; head.style.color = '#1aa37a'; }
    else if (res && res.ok) { head.textContent = '✅ Новых нет (уже выгружено)'; head.style.color = '#1aa37a'; }
    else if (res && res.reason === 'no-login') { head.textContent = '⚠️ Войдите в EC5 и повторите'; head.style.color = '#d9822b'; }
    else { head.textContent = '⚠️ Не получилось (детали ниже)'; head.style.color = '#d9822b'; }
    setTimeout(() => { p.style.display = 'none'; }, 12000);
  }

  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('📥 Собрать базу за сегодня', activate);
  window.addEventListener('keydown', (e) => { if (e.ctrlKey && e.altKey && e.code === 'KeyE') { e.preventDefault(); activate(); } });
  window.__ec5traffic = { run: activate, CONFIG };
})();
