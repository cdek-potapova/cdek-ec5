// ==UserScript==
// @name         EC5 База проходящего трафика (сбор по ПВЗ)
// @namespace    cdek.maria.traffic
// @version      0.9.8
// @description  Собирает за день клиентов ПВЗ из EC5 (физики-отправители = лиды + выдача), авто-определяя офис аккаунта. Богатые колонки для фильтрации в таблице. Запуск из меню Tampermonkey.
// @match        https://orderec5ng.cdek.ru/*
// @match        https://ek5.cdek.ru/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      gateway.cdek.ru
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      5.42.124.252
// @connect      superset.cdek.ru
// @downloadURL  https://raw.githubusercontent.com/cdek-potapova/cdek-ec5/main/ec5-collector.user.js
// @updateURL    https://raw.githubusercontent.com/cdek-potapova/cdek-ec5/main/ec5-collector.user.js
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
    // Наш приёмник — основной: данные ложатся в базу на сервере и уже оттуда
    // публикуются в таблицу. Google остаётся вторым адресатом.
    OURS_URL: 'http://5.42.124.252/ec5-traffic',
    PAGE_LIMIT: 100,
    MAX_PER_SIDE: 50000,     // практически без потолка
    CONCURRENCY: 10,         // параллельных getByNumber
    LIST_THROTTLE_MS: 120,
    ENRICH_JITTER_MS: 40,
    NA: '—',
  };

  // коды офисов -> человеческие имена листов (если код неизвестен — берём имя офиса из EC5)
  const PVZ_NAMES = { KAM32: 'Фуд-Сити', MSK548: 'Садовод-1', MSK2432: 'Садовод-2', MSK456: 'ТЯК' };

  // ---- Анкета точки: удалённо видно, что живо. installId общий на установку (GM-хранилище
  //      шарится между всеми origin-инстансами одного скрипта). Страница: 5.42.124.252/status ----
  const STATUS = { officeName: null, account: null, trafficOkTs: null };
  const STATUS_URL = 'http://5.42.124.252/ec5-status';
  function installId() {
    let id = '';
    try { id = (GM_getValue && GM_getValue('ec5_installId', '')) || ''; } catch (e) {}
    if (!id) {
      id = (self.crypto && crypto.randomUUID) ? crypto.randomUUID()
           : 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      try { GM_setValue && GM_setValue('ec5_installId', id); } catch (e) {}
    }
    return id;
  }

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

  // Тело ответа возвращаем всегда (обрезанное): без него причину падения отправки
  // не видно — а именно она нужна, чтобы понять, почему точка молчит.
  const cut = (s) => String(s == null ? '' : s).slice(0, 200).replace(/\s+/g, ' ').trim();
  function http(method, url, body) {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Auth-Token': token(), 'X-User-Locale': 'ru' };
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method, url, headers, data: body ? JSON.stringify(body) : undefined, timeout: 120000,
          onload: (r) => {
            let json = null;
            try { json = JSON.parse(r.responseText); } catch (e) { /* не JSON — отдадим текстом */ }
            resolve({ status: r.status, json, text: cut(r.responseText) });
          },
          onerror: (e) => reject(new Error('сеть: ' + (cut(e && (e.error || e.statusText)) || 'запрос отклонён'))),
          ontimeout: () => reject(new Error('таймаут (120с)')),
        });
      });
    }
    return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
      .then(async (r) => {
        const text = await r.text().catch(() => '');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* не JSON */ }
        return { status: r.status, json, text: cut(text) };
      });
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

  // Возвращает { rows, raw, dropped }: raw — сколько заказов было в журнале за дату,
  // dropped — сколько выброшено из-за скрытого телефона (признак «это не наш офис»).
  async function collectSide(label, role, listFields, pvz, seen, log, date) {
    const recs = (await listSide(listFields, date, date, label, log)).filter((it) => !seen.has(it.orderNumber));
    log(`${label}: новых ${recs.length}`);
    if (!recs.length) return { rows: [], raw: 0, dropped: 0 };
    let done = 0;
    const out = await pool(recs, async (it) => {
      const row = await enrichRow(it, role, pvz); seen.add(it.orderNumber);
      if (++done % 200 === 0) log(`${label}: ${done}/${recs.length}`);
      return row;
    }, CONFIG.CONCURRENCY);
    // оставляем строки с реальным телефоном клиента (= свой офис)
    const got = out.filter(Boolean);
    const rows = got.filter((r) => realPhone(r.phone));
    const dropped = got.length - rows.length;
    if (dropped) log(`${label}: отброшено ${dropped} (телефон скрыт — чужой офис)`);
    return { rows, raw: recs.length, dropped };
  }

  // Сбор и отправка за ОДНУ дату (dd.MM.yyyy) для уже определённого офиса.
  // ignoreSeen — начать день с чистого листа. Нужно для добора: в потерянные дни
  // кэш уже забит номерами заказов (старая версия помечала их ДО отправки), и без
  // сброса добор вернул бы 0 ровно за те дни, которые и надо вернуть.
  // Повторной отправки бояться не нужно: приёмник дедуплицирует по номеру заказа.
  async function runForDate(date, office, pvz, log, ignoreSeen) {
    const t0 = Date.now();
    const seen = ignoreSeen ? new Set() : loadSeen(date);
    let all = [], raw = 0, dropped = 0;

    // 1) ОТПРАВИТЕЛИ (физики-лиды) — оформлено нашим ПВЗ
    try {
      const s = await collectSide('Отправители (оформление)', 'отправитель',
        { field: 'orderFromMyOfficeFlag', value: true, values: null }, pvz, seen, log, date);
      all = all.concat(s.rows); raw += s.raw; dropped += s.dropped;
    } catch (e) { log('Отправители: ошибка ' + (e && e.message)); }
    // 2) ПОЛУЧАТЕЛИ (выдача, в т.ч. договорники) — receiverOffice = наш офис
    try {
      const s = await collectSide('Получатели (выдача)', 'получатель',
        { field: 'receiverOffice', value: null, values: [office.code] }, pvz, seen, log, date);
      all = all.concat(s.rows); raw += s.raw; dropped += s.dropped;
    } catch (e) { log('Получатели: ошибка ' + (e && e.message)); }
    // seen НЕ сохраняем здесь: если отправка не пройдёт, день должен собраться заново

    const leads = all.filter((r) => r.orderType === 'Доставка' && r.dogovor === 'нет').length;
    const secs = Math.round((Date.now() - t0) / 1000);
    log(`${date}: к отправке ${all.length} из ${raw} за ${secs}с (лидов ${leads})`);

    if (!all.length) {
      // Отправлять нечего — терять тоже нечего, кэш сохраняем (иначе повторное
      // нажатие заново перекачает все карточки за день).
      saveSeen(date, seen);
      // Заказы были, но все выброшены по скрытому телефону — это НЕ «всё собрано»,
      // это чужой офис. Разводим два случая, иначе оператор видит зелёную галку
      // и не знает, что данные не идут.
      if (raw > 0 && dropped === raw) {
        log(`⚠️ Все ${raw} заказов отброшены: телефоны скрыты. Похоже, аккаунт привязан не к ${pvz}.`);
        return { ok: true, count: 0, date, raw, dropped, reason: 'foreign-office' };
      }
      return { ok: true, count: 0, date, raw, dropped };
    }

    const payload = { source: 'ec5-traffic-userscript', version: '0.9.2', date, pvz, records: all };

    // 1) НАШ СЕРВЕР — главный адресат. Пока пакет здесь, данные не потеряются.
    let savedOurs = false;
    try {
      const r0 = await http('POST', CONFIG.OURS_URL, payload);
      savedOurs = r0.status >= 200 && r0.status < 300 && (!r0.json || r0.json.ok !== false);
      if (savedOurs) STATUS.trafficOkTs = new Date().toISOString();
      log(savedOurs ? `✅ Сохранено на сервере: ${all.length}`
                    : `⚠️ Сервер не принял: HTTP ${r0.status}`);
    } catch (e) {
      log('⚠️ Не достучался до сервера: ' + ((e && e.message) || 'неизвестно'));
    }

    // 2) Google-таблица — вторым заходом.
    let sent = false, why = '';
    try {
      const res = await http('POST', CONFIG.INGEST_URL, payload);
      const ok2xx = res.status >= 200 && res.status < 300;
      // 2xx мало: приёмник на ошибке тоже отвечает 200 с {ok:false}
      const okBody = !res.json || res.json.ok !== false;
      sent = ok2xx && okBody;
      if (sent) log(`✅ Отправлено в таблицу: ${all.length}`);
      else { why = `HTTP ${res.status}${res.json && res.json.error ? ' / ' + res.json.error : ''} ${res.text || ''}`.trim(); log('⚠️ Таблица не приняла: ' + why); }
    } catch (e) { why = (e && e.message) || 'неизвестно'; log('⚠️ Не достучался до таблицы: ' + why); }

    // помечаем заказы обработанными ТОЛЬКО когда их принял КАЖДЫЙ адресат — и наш
    // сервер, и таблица. Иначе при лежащем сервере (а Google жив) день ушёл бы в
    // таблицу, пометился обработанным и в нашу базу уже НИКОГДА не попал бы обычным
    // сбором. Если хоть один не принял — не помечаем, следующий прогон дошлёт;
    // повтор безопасен, дубли обе стороны отсекают по номеру заказа.
    if (savedOurs && sent) saveSeen(date, seen);
    else log(`⚠️ ${date}: принято не всеми (сервер:${savedOurs?'ок':'нет'} таблица:${sent?'ок':'нет'}) — дошлём при следующем сборе.`);
    return { ok: true, count: all.length, leads, sent, why, date, raw, dropped };
  }

  // Определяет офис аккаунта; общая часть обычного сбора и добора за период.
  async function prepare(log) {
    if (!token()) { log('❌ Не вижу вход в EC5. Откройте/обновите EC5.'); return { reason: 'no-login' }; }
    const office = await detectOffice(log);
    if (!office) { log('❌ Не удалось определить офис аккаунта'); return { reason: 'no-office' }; }
    const pvz = PVZ_NAMES[office.code] || office.name || office.code;
    STATUS.officeName = pvz; STATUS.account = (office && office.name) || '';
    log(`Офис аккаунта: ${pvz} (${office.code})`);
    return { office, pvz };
  }

  async function run(log) {
    const p = await prepare(log);
    if (p.reason) return { ok: false, reason: p.reason };
    const r = await runForDate(todayDDMMYYYY(), p.office, p.pvz, log);
    r.pvz = p.pvz;
    return r;
  }

  // ---------- Добор за прошлые дни ----------
  const parseDDMMYYYY = (s) => {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(s || '').trim());
    if (!m) return null;
    const d = new Date(+m[3], +m[2] - 1, +m[1]);
    return (d.getDate() === +m[1] && d.getMonth() === +m[2] - 1) ? d : null;
  };
  const fmt = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`; };
  function daysBetween(from, to) {
    const out = [];
    for (const d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) out.push(fmt(d));
    return out;
  }

  async function runRange(fromStr, toStr, log) {
    const from = parseDDMMYYYY(fromStr), to = parseDDMMYYYY(toStr);
    if (!from || !to) { log('❌ Даты в формате ДД.ММ.ГГГГ'); return { ok: false, reason: 'bad-date' }; }
    if (from > to) { log('❌ Начало периода позже конца'); return { ok: false, reason: 'bad-date' }; }
    const dates = daysBetween(from, to);
    if (dates.length > 62) { log(`❌ Слишком длинный период (${dates.length} дн.), берите месяцами`); return { ok: false, reason: 'bad-date' }; }

    const p = await prepare(log);
    if (p.reason) return { ok: false, reason: p.reason };

    let total = 0, failed = [];
    for (const date of dates) {
      // День за днём отдельными посылками: маленький пакет доезжает надёжнее,
      // и один неудачный день не тянет за собой остальные. Кэш дня игнорируем —
      // иначе потерянные дни вернут 0, см. комментарий в runForDate.
      const r = await runForDate(date, p.office, p.pvz, log, true);
      if (r.count && !r.sent) failed.push(date); else total += r.count || 0;
    }
    log(failed.length ? `⚠️ Не отправились дни: ${failed.join(', ')}` : '✅ Период добран целиком');
    return { ok: true, count: total, range: true, failed, pvz: p.pvz, dates: dates.length };
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
  async function activate(worker, title) {
    if (running) return; running = true;
    const p = toastBox(); p.innerHTML = '';
    const head = document.createElement('div'); head.style.cssText = 'font-weight:600;margin-bottom:6px';
    head.textContent = title || '📥 Сбор базы за сегодня…';
    const body = document.createElement('div'); body.style.cssText = 'font:12px/1.5 monospace';
    p.appendChild(head); p.appendChild(body);
    const log = (m) => { body.insertAdjacentHTML('afterbegin', `<div>${m}</div>`); };
    let res; try { res = await (worker || run)(log); } catch (e) { res = { ok: false, msg: String(e && e.message || e) }; }
    running = false;

    let good = false;
    if (res && res.ok && res.range) {
      if (res.failed && res.failed.length) head.textContent = `⚠️ Добрано ${res.count}, не ушли дни: ${res.failed.join(', ')}`;
      else { head.textContent = `✅ Добрано ${res.count} за ${res.dates} дн. — ${res.pvz || ''}`; good = true; }
    } else if (res && res.ok && res.count > 0 && res.sent === false) {
      head.textContent = `⚠️ Собрано ${res.count}, НО В ТАБЛИЦУ НЕ УШЛО`;
    } else if (res && res.ok && res.count > 0) {
      head.textContent = `✅ Готово: ${res.count} — ${res.pvz || ''} (лидов ${res.leads || 0})`; good = true;
    } else if (res && res.reason === 'foreign-office') {
      head.textContent = `⚠️ Ни одной строки: аккаунт не привязан к ${res.pvz || 'этому ПВЗ'}`;
    } else if (res && res.ok && res.raw === 0) {
      head.textContent = '✅ Новых нет (уже выгружено)'; good = true;
    } else if (res && res.ok) {
      head.textContent = '⚠️ Собрано 0 строк — покажите этот экран Артёму';
    } else if (res && res.reason === 'no-login') {
      head.textContent = '⚠️ Войдите в EC5 и повторите';
    } else {
      head.textContent = '⚠️ Не получилось (детали ниже)';
    }
    head.style.color = good ? '#1aa37a' : '#d9822b';
    // Окно с ошибкой НЕ прячем: его надо успеть прочитать и сфотографировать.
    if (good) setTimeout(() => { p.style.display = 'none'; }, 12000);
    else {
      const close = document.createElement('div');
      close.style.cssText = 'margin-top:8px;cursor:pointer;color:#666;font:12px sans-serif';
      close.textContent = '✕ закрыть';
      close.onclick = () => { p.style.display = 'none'; };
      p.appendChild(close);
    }
  }

  // Добор за прошлые дни: спрашиваем период и идём по дням.
  function activateRange() {
    if (running) return;
    const from = prompt('Добор базы за период.\n\nНачало (ДД.ММ.ГГГГ):', '');
    if (!from) return;
    const to = prompt('Конец (ДД.ММ.ГГГГ):', from);
    if (!to) return;
    activate((log) => runRange(from, to, log), `📅 Добор за ${from} — ${to}…`);
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('📥 Собрать базу за сегодня', () => activate());
    GM_registerMenuCommand('📅 Добрать за прошлые дни', activateRange);
  }
  window.addEventListener('keydown', (e) => { if (e.ctrlKey && e.altKey && e.code === 'KeyE') { e.preventDefault(); activate(); } });
  window.__ec5traffic = { run: activate, runRange, CONFIG };

  // Разведчик формата кассы/сотрудников (патчил XMLHttpRequest на cashboxng/coworker)
  // СНЯТ 12.08: своё дело сделал — форматы get-filter-data и getEmployeeList сняты на
  // живых данных 11.08 (см. work-hub/ЭК5-API-находки.md), по своему же коммиту он был
  // временный. Заодно убраны @match на cashboxng/coworker-prime-ng: трафик-сбор живёт
  // на ek5/orderec5, на кассовых вкладках ему делать нечего. Итог: трафик XHR больше
  // НЕ патчит нигде. Кассовый скрипт (отдельный) ходит прямым fetch и XHR тоже не трогает.

  // ---------- Пульс-сердцебиение ----------
  // «Сборщик жив»: при автозапуске стучимся на сервер, чтобы в pulse.jsonl было
  // видно, что скрипт ЭТОЙ версии реально крутится на ПК точки — независимо от
  // того, собрались данные или нет. Fire-and-forget: сбор не трогает и не роняет.
  function pulse(event, pvz, rows) {
    try {
      GM_xmlhttpRequest({
        method: 'POST', url: 'http://5.42.124.252/ec5-pulse',
        data: JSON.stringify({ event: event || '', pvz: pvz || '', rows: rows || 0,
                               host: location.hostname || '', ver: '0.9.7', note: '' }),
        headers: { 'Content-Type': 'application/json' },
        onload: () => {}, onerror: () => {},
      });
    } catch (e) { /* пульс не должен мешать сбору */ }
  }

  // ---------- Автозапуск ----------
  // Сбор не должен зависеть от того, вспомнил человек нажать кнопку или нет.
  // Один запуск обходит все офисы, поэтому пропущенный клик = нет данных вообще.
  // Кнопка и горячие клавиши остаются — запустить вручную можно в любой момент.
  // ---------- Анкета: проба упаковки (Superset) + отправка на сервер ----------
  // Проверка доступа — честной попыткой получить данные (не по имени): GM_xhr шлёт куки
  // superset.cdek.ru; у директора сессия есть → 200, у оператора нет → откажет. Тихо.
  function probeUpack() {
    return new Promise((resolve) => {
      try {
        GM_xmlhttpRequest({ method: 'GET', url: 'https://superset.cdek.ru/api/v1/me/', timeout: 15000,
          onload: (r) => resolve(r.status >= 200 && r.status < 300
            ? { state: 'ok', lastOk: new Date().toISOString() }
            : { state: 'no_access', detail: 'нет доступа (HTTP ' + r.status + ')' }),
          onerror: () => resolve({ state: 'no_access', detail: 'нет сессии Superset' }),
          ontimeout: () => resolve({ state: 'error', detail: 'таймаут Superset' }) });
      } catch (e) { resolve({ state: 'error', detail: (e && e.message) || 'проба не запустилась' }); }
    });
  }

  let statusBusy = false;
  async function reportStatus() {
    if (statusBusy) return; statusBusy = true;
    try {
      const traffic = STATUS.trafficOkTs ? { state: 'ok', lastOk: STATUS.trafficOkTs }
        : (!token() ? { state: 'error', detail: 'нет входа в ЭК5' } : { state: 'off', detail: 'ещё не собирал' });
      const upack = await probeUpack();
      const payload = { installId: installId(), officeName: STATUS.officeName || '',
        account: STATUS.account || '', version: '0.9.8',
        blocks: { traffic,
          sleeping: { state: traffic.state === 'ok' ? 'ok' : 'off', detail: 'серверный отчёт' },
          kassa: { state: 'off', detail: 'отдельный скрипт кассы' },
          upack } };
      GM_xmlhttpRequest({ method: 'POST', url: STATUS_URL, data: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' }, onload: () => {}, onerror: () => {} });
    } catch (e) { /* анкета не должна мешать сбору */ }
    finally { statusBusy = false; }
  }

  let autoBusy = false;
  async function autorun() {
    if (autoBusy) return;
    autoBusy = true;
    pulse('autorun', '', 0);
    try { await activate(); }
    catch (e) { console.warn('[ec5] автозапуск не удался:', e && e.message); }
    finally { autoBusy = false; reportStatus(); }   // после сбора обновляем анкету
  }
  setTimeout(autorun, 90 * 1000);                  // через полторы минуты после открытия
  setInterval(autorun, 2 * 60 * 60 * 1000);        // сбор — раз в два часа
  setTimeout(reportStatus, 100 * 1000);            // первая анкета сразу после старта
  setInterval(reportStatus, 15 * 60 * 1000);       // анкета — каждые 15 минут (лёгкая)
})();
