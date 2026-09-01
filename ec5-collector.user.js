// ==UserScript==
// @name         EC5 База проходящего трафика (сбор по ПВЗ)
// @namespace    cdek.maria.traffic
// @version      0.9.20
// @description  Собирает за день клиентов ПВЗ из EC5 (физики-отправители = лиды + выдача), авто-определяя офис аккаунта. Богатые колонки для фильтрации в таблице. Запуск из меню Tampermonkey.
// @match        https://orderec5ng.cdek.ru/*
// @match        https://ek5.cdek.ru/*
// @match        https://cashboxng.cdek.ru/*
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

/* ---- Токен нашего приёмника (закрыто 18.08.2026) ------------------------
   Раньше POST /ec5-* принимал что угодно от кого угодно. Теперь сервер ждёт
   заголовок X-Token. В ИСХОДНИКЕ здесь плейсхолдер, а не секрет: файл лежит
   в публичном репозитории cdek-potapova/cdek-ec5, туда секрет класть нельзя.
   Реальный токен подставляет сервер при отдаче файла по ключу в адресе
   (см. serve.py). Если скрипт поставлен без ключа, здесь останется
   плейсхолдер — сбор всё равно идёт, потому что IP точки в белом списке. */
const EC5_POINT_TOKEN = '__EC5_POINT_TOKEN__';
const EC5_OURS = '5.42.124.252';
function ec5Headers(url, headers) {
  const h = Object.assign({}, headers || {});
  if (typeof url === 'string' && url.indexOf(EC5_OURS) !== -1) h['X-Token'] = EC5_POINT_TOKEN;
  return h;
}

(function () {
  'use strict';
  // На cashboxng работает ТОЛЬКО кассовый блок (ниже) — трафик/упаковка/сотрудники тут не нужны.
  if (location.host.indexOf('cashboxng') !== -1) return;

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
          method, url, headers: ec5Headers(url, headers), data: body ? JSON.stringify(body) : undefined, timeout: 120000,
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
    return fetch(url, { method, headers: ec5Headers(url, headers), body: body ? JSON.stringify(body) : undefined })
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

    const payload = { source: 'ec5-traffic-userscript', version: '0.9.18', date, pvz, records: all };

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
        headers: ec5Headers('http://5.42.124.252/ec5-pulse', { 'Content-Type': 'application/json' }),
        onload: () => {}, onerror: () => {},
      });
    } catch (e) { /* пульс не должен мешать сбору */ }
  }

  // ---------- Автозапуск ----------
  // Сбор не должен зависеть от того, вспомнил человек нажать кнопку или нет.
  // Один запуск обходит все офисы, поэтому пропущенный клик = нет данных вообще.
  // Кнопка и горячие клавиши остаются — запустить вручную можно в любой момент.
  // ---------- Анкета: проба упаковки (Superset) + АВТО-ПОДЪЁМ сессии ----------
  // Superset пускает по тому же keycloak, что и вход в ЭК5 (кнопка «Sign In with keycloak»
  // → /login/keycloak). X-Frame-Options/CSP у Superset пустые (проверено 12.08) → его можно
  // грузить скрытым фреймом. Поэтому при 401 (сессии нет) СНАЧАЛА пробуем тихо её поднять:
  // невидимый iframe на /login/keycloak проходит SSO-цепочку, пока жив keycloak оператора
  // (а он жив всю смену), и cookie ставится сам — БЕЗ пароля и без ручного захода в Big Data.
  // Best-effort: не вышло (keycloak протух / реально нет прав) — тихо остаётся «не для этой
  // точки» (норма, серым), ничего не ломаем и никого не тревожим.

  const supGet = (url) => new Promise((resolve) => {
    GM_xmlhttpRequest({ method: 'GET', url, timeout: 15000,
      onload: (r) => resolve(r.status), onerror: () => resolve(0), ontimeout: () => resolve(-1) });
  });

  let supWarmedAt = 0;                                  // троттлинг: не чаще раза в 20 мин
  function warmupSuperset() {
    return new Promise((resolve) => {
      if (Date.now() - supWarmedAt < 20 * 60 * 1000) { resolve(false); return; }
      supWarmedAt = Date.now();
      let done = false;
      let ifr;
      try {
        ifr = document.createElement('iframe');
        ifr.style.cssText = 'position:absolute;left:-9999px;width:0;height:0;border:0;visibility:hidden';
        ifr.src = 'https://superset.cdek.ru/login/keycloak';
        document.documentElement.appendChild(ifr);
      } catch (e) { resolve(false); return; }
      setTimeout(() => {                                // ждём цепочку редиректов SSO, снимаем фрейм
        if (done) return; done = true;
        try { ifr.remove(); } catch (e) {}
        resolve(true);
      }, 6000);
    });
  }

  async function probeUpack() {
    try {
      let st = await supGet('https://superset.cdek.ru/api/v1/me/');
      if (st === 401 && (await warmupSuperset()))       // сессии нет — поднимаем тихо и пробуем снова
        st = await supGet('https://superset.cdek.ru/api/v1/me/');
      if (st >= 200 && st < 300) return { state: 'ok', lastOk: new Date().toISOString() };
      if (st === -1) return { state: 'error', detail: 'таймаут Superset' };
      // НЕ ОШИБКА: у большинства точек Superset-доступа нет и не должно быть (собирается
      // с директорского аккаунта). Для точки это норма — спокойный серый no_access.
      return { state: 'no_access', detail: 'упаковка не для этой точки (норма)' };
    } catch (e) { return { state: 'error', detail: (e && e.message) || 'проба не запустилась' }; }
  }

  let statusBusy = false;
  async function reportStatus() {
    if (statusBusy) return; statusBusy = true;
    try {
      const traffic = STATUS.trafficOkTs ? { state: 'ok', lastOk: STATUS.trafficOkTs }
        : (!token() ? { state: 'error', detail: 'нет входа в ЭК5' } : { state: 'off', detail: 'ещё не собирал' });
      await probeUpack();  // греет сессию Superset (iframe SSO); результат для статуса НЕ используем
      let upack;
      const ur = (typeof GM_getValue === 'function') ? GM_getValue('upack:lastResult', '') : '';
      if (!ur) upack = { state: 'off', detail: 'ещё не собирал' };
      else { const pp = ur.split('|'); const stg = pp[1];
             upack = (stg === 'ok') ? { state: 'ok', lastOk: pp[0], detail: 'собрано' }
               : (stg === 'no_session' || stg === 'no_rights')
                 ? { state: 'off', detail: (pp.slice(2).join('|') || stg).slice(0, 80) }
                 : { state: 'error', detail: (pp.slice(2).join('|') || stg).slice(0, 80) }; }
      const payload = { installId: installId(), officeName: STATUS.officeName || '',
        account: STATUS.account || '', version: (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0.9.17',
        blocks: { traffic,
          sleeping: { state: traffic.state === 'ok' ? 'ok' : 'off', detail: 'серверный отчёт' },
          kassa: { state: 'off', detail: 'отдельный скрипт кассы' },
          upack } };
      GM_xmlhttpRequest({ method: 'POST', url: STATUS_URL, data: JSON.stringify(payload),
        headers: ec5Headers(STATUS_URL, { 'Content-Type': 'application/json' }), onload: () => {}, onerror: () => {} });
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
  // Мгновенный сигнал при загрузке: без него скрипт молчит первые 100 секунд, и
  // если вкладку закрыли раньше — на сервере полная тишина, неотличимая от «не
  // установлен». Именно из-за этого 23-25.08 не могли понять, стоит ли скрипт на
  // точке Рената. Лёгкий, ничего не собирает.
  try { pulse('loaded', '', 0); } catch (e) {}
  setTimeout(reportStatus, 3 * 1000);              // анкета сразу, чтобы точка была видна

  setTimeout(autorun, 90 * 1000);                  // через полторы минуты после открытия
  setInterval(autorun, 2 * 60 * 60 * 1000);        // сбор — раз в два часа
  setTimeout(reportStatus, 100 * 1000);            // первая анкета сразу после старта
  setInterval(reportStatus, 15 * 60 * 1000);       // анкета — каждые 15 минут (лёгкая)
})();

// ===================== БЛОК КАССЫ (влит из ec5-kassa 0.3.0; @match cashboxng) =====================
(function () {
  'use strict';
  // Кассовый блок работает ТОЛЬКО на cashboxng.
  if (location.host.indexOf('cashboxng') === -1) return;

  const CONFIG = {
    KASSA_BASE: 'https://gateway.cdek.ru/cashbox-operating/web/v1/',
    OURS_URL: 'http://5.42.124.252/ec5-kassa',
    PULSE_URL: 'http://5.42.124.252/ec5-pulse',
    // ⚠️ Ниже — ФОЛЛБЭК-значения (Садовод-1). С 0.4.0 касса и офис определяются
    // ДИНАМИЧЕСКИ (см. resolveIdentity). Хардкод остаётся страховкой: если
    // самоопределение не сработало на Садовод-1 — точка НЕ должна деградировать.
    OFFICE_CODE: 'MSK548',
    PVZ_NAME: 'Садовод-1',
    CASH_UUIDS: ['db7420b0-e528-41e7-a81f-1585cfaed4e1'],  // касса MSK548, одна (подтв.)
    OPS_LIMIT: 100,
    PAGE_HARD_CAP: 200,     // защита от бесконечного листания (макс страниц = cap/limit)
    VER: '0.4.0',
  };

  const pwt = () => sessionStorage.getItem('pwt') || localStorage.getItem('pwt') || '';

  // ============ САМООПРЕДЕЛЕНИЕ КАССЫ/ОФИСА (0.4.0) ============
  // Три источника, от надёжного к запасному; всё в try/catch, любой сбой → хардкод.
  //  1) SNIFF  — пассивно слушаем СОБСТВЕННЫЕ запросы приложения cashboxng
  //     (fetch/XHR к cashbox-operating). Из тела get-filter-data берём cashUuid,
  //     который приложение реально использует = касса ЭТОЙ точки. Плюс офис из
  //     любых полей office*. Самый достоверный сигнал (значения самого приложения).
  //     Минус: @run-at document-idle → стартовые запросы загрузки могли пройти ДО нас;
  //     ловим повторные (навигация оператора, наши же обращения этот хук НЕ видит —
  //     мы ходим через GM_xmlhttpRequest, а он мимо window.fetch/XHR).
  //  2) PROBE  — активно спрашиваем gateway список касс оператора тем же токеном pwt
  //     (кандидаты эндпоинтов cash-registers/*). Не зависит от действий оператора.
  //  3) CONFIG — хардкод Садовод-1 (страховка).
  const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);
  const detect = { sniff: { uuids: new Set(), code: null, name: null }, probe: null, probed: false };

  // — рекурсивный сборщик: cashUuid'ы и офис из произвольного JSON —
  //   target — куда складывать {uuids:Set, code, name}. allowUuidName — принимать ли
  //   пару uuid+name как кассу (ДА для выделенного списка касс из PROBE; НЕТ для
  //   общего трафика cashbox-operating из SNIFF, где uuid+name может быть НЕ кассой:
  //   автор операции, документ и т.п. → берём только явный ключ cashUuid).
  function harvest(node, depth, target, allowUuidName) {
    if (node == null || depth > 6) return;
    if (Array.isArray(node)) { for (const v of node) harvest(v, depth + 1, target, allowUuidName); return; }
    if (typeof node !== 'object') return;
    // Фильтр-шейп get-filter-data: {field:'cashUuid', value:'<uuid>', values:[...]} —
    // именно так приложение (и мы) шлём фильтр по кассе. uuid лежит в value/values,
    // а НЕ в ключе с именем cashUuid. Это самый достоверный сигнал.
    try {
      const fn = node.field && String(node.field).toLowerCase();
      if (fn === 'cashuuid' || fn === 'cashboxuuid') {
        if (isUuid(node.value)) target.uuids.add(node.value);
        if (Array.isArray(node.values)) for (const x of node.values) if (isUuid(x)) target.uuids.add(x);
      }
    } catch (e) {}
    for (const k in node) {
      let v;
      try { v = node[k]; } catch (e) { continue; }
      const lk = k.toLowerCase();
      if ((lk === 'cashuuid' || lk === 'cashboxuuid') && isUuid(v)) target.uuids.add(v);
      if (allowUuidName && lk === 'uuid' && isUuid(v) && (node.name || node.cashName || node.title)) target.uuids.add(v);
      if ((lk === 'officecode' || lk === 'office_code') && typeof v === 'string' && v.length <= 16 && !target.code) target.code = v;
      if ((lk === 'officename' || lk === 'office_name') && typeof v === 'string' && !target.name) target.name = v;
      if (lk === 'office' && v && typeof v === 'object') {
        if (!target.code && typeof v.code === 'string' && v.code.length <= 16) target.code = v.code;
        if (!target.name && typeof v.name === 'string') target.name = v.name;
      }
      if (v && typeof v === 'object') harvest(v, depth + 1, target, allowUuidName);
    }
  }
  function sniffText(url, txt) {
    try {
      if (!url || String(url).indexOf('cashbox-operating') === -1 || !txt) return;
      harvest(JSON.parse(txt), 0, detect.sniff, false);
    } catch (e) {}
  }
  // Установка хуков как можно раньше. Пассивно: только читаем, поведение не меняем.
  try {
    const of = window.fetch;
    if (typeof of === 'function' && !of.__ec5k) {
      const wf = function (input, init) {
        let url = ''; try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) {}
        try { if (url.indexOf('cashbox-operating') !== -1 && init && init.body && typeof init.body === 'string') sniffText(url, init.body); } catch (e) {}
        const p = of.apply(this, arguments);
        try {
          if (url.indexOf('cashbox-operating') !== -1) p.then((r) => { try { r.clone().text().then((t) => sniffText(url, t)).catch(() => {}); } catch (e) {} }).catch(() => {});
        } catch (e) {}
        return p;
      };
      wf.__ec5k = true; window.fetch = wf;
    }
  } catch (e) {}
  try {
    const XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XP && !XP.__ec5k) {
      const oOpen = XP.open, oSend = XP.send;
      XP.open = function (m, u) { try { this.__ec5url = u; } catch (e) {} return oOpen.apply(this, arguments); };
      XP.send = function (body) {
        try {
          const u = this.__ec5url || '';
          if (String(u).indexOf('cashbox-operating') !== -1) {
            if (typeof body === 'string') sniffText(u, body);
            this.addEventListener('load', function () { try { sniffText(u, this.responseText); } catch (e) {} });
          }
        } catch (e) {}
        return oSend.apply(this, arguments);
      };
      XP.__ec5k = true;
    }
  } catch (e) {}

  // — активный опрос списка касс оператора (кандидаты эндпоинтов) —
  async function runProbe() {
    const bodies = [
      { sort: [], offset: 0, limit: 50, fields: [], columns: ['uuid', 'name', 'officeCode', 'officeName'] },
      { sort: [], offset: 0, limit: 50, fields: [] },
      { offset: 0, limit: 50 },
    ];
    const posts = ['cash-registers/get-filter-data', 'cash-register/get-filter-data', 'cashboxes/get-filter-data'];
    const gets = ['cash-registers', 'cash-register', 'cashboxes'];
    const tmp = { uuids: new Set(), code: null, name: null };
    for (const ep of posts) {
      for (const b of bodies) {
        try {
          const r = await http('POST', CONFIG.KASSA_BASE + ep, b);
          if (r.status >= 200 && r.status < 300 && r.json) { harvest(r.json, 0, tmp, true); if (tmp.uuids.size) return { uuids: [...tmp.uuids], code: tmp.code, name: tmp.name, ep }; }
        } catch (e) {}
      }
    }
    for (const ep of gets) {
      try {
        const r = await http('GET', CONFIG.KASSA_BASE + ep);
        if (r.status >= 200 && r.status < 300 && r.json) { harvest(r.json, 0, tmp, true); if (tmp.uuids.size) return { uuids: [...tmp.uuids], code: tmp.code, name: tmp.name, ep }; }
      } catch (e) {}
    }
    return null;
  }

  const uuid8 = (u) => String(u || '').slice(0, 8);
  // Собирает итог: {cashUuids, officeCode, pvz, source}. Офис всегда РАЗНЫЙ у разных
  // касс (fallback 'CASH-<uuid8>'), чтобы точки не перетирали друг друга в БД
  // (ключ kassa_shifts = office+date, ON CONFLICT REPLACE).
  async function resolveIdentity() {
    try {
      if (detect.sniff.uuids.size) {
        const uu = [...detect.sniff.uuids];
        return { cashUuids: uu, officeCode: detect.sniff.code || ('CASH-' + uuid8(uu[0])), pvz: detect.sniff.name || detect.sniff.code || ('касса ' + uuid8(uu[0])), source: 'sniff' };
      }
      if (!detect.probed) { detect.probed = true; try { detect.probe = await runProbe(); } catch (e) { detect.probe = null; } }
      if (detect.probe && detect.probe.uuids && detect.probe.uuids.length) {
        const uu = detect.probe.uuids;
        return { cashUuids: uu, officeCode: detect.probe.code || ('CASH-' + uuid8(uu[0])), pvz: detect.probe.name || detect.probe.code || ('касса ' + uuid8(uu[0])), source: 'probe' };
      }
    } catch (e) {}
    return { cashUuids: CONFIG.CASH_UUIDS, officeCode: CONFIG.OFFICE_CODE, pvz: CONFIG.PVZ_NAME, source: 'config' };
  }
  const norm = (a) => String(a).replace(/\s+\d+$/, '').trim();   // «ФИО 6295» -> «ФИО»
  const cut = (s) => String(s == null ? '' : s).slice(0, 200).replace(/\s+/g, ' ').trim();

  // ---------- HTTP: прямой fetch/GM (XHR НЕ патчим) ----------
  function http(method, url, body) {
    const headers = { 'Content-Type': 'application/json', 'X-Auth-Token': pwt() };
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method, url, headers: ec5Headers(url, headers), data: body ? JSON.stringify(body) : undefined, timeout: 120000,
          onload: (r) => { let j = null; try { j = JSON.parse(r.responseText); } catch (e) {} resolve({ status: r.status, json: j, text: cut(r.responseText) }); },
          onerror: (e) => reject(new Error('сеть: ' + (cut(e && (e.error || e.statusText)) || 'отклонён'))),
          ontimeout: () => reject(new Error('таймаут (120с)')),
        });
      });
    }
    return fetch(url, { method, headers: ec5Headers(url, headers), body: body ? JSON.stringify(body) : undefined })
      .then(async (r) => { const t = await r.text().catch(() => ''); let j = null; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, json: j, text: cut(t) }; });
  }

  // ---------- Пульс-сердцебиение (та же механика, что в трафике) ----------
  function pulse(event, rows, detail) {
    try {
      const body = { event: event || '', pvz: (detail && detail.pvz) || CONFIG.PVZ_NAME, rows: rows || 0,
                     host: location.hostname || '', ver: CONFIG.VER, note: 'kassa' };
      if (detail) {
        if (detail.source) body.source = detail.source;
        const off = detail.office || detail.officeCode; if (off) body.office = off;
        const uu = detail.uuids || detail.cashUuids; if (uu) body.uuids = uu;
      }
      GM_xmlhttpRequest({
        method: 'POST', url: CONFIG.PULSE_URL, data: JSON.stringify(body),
        headers: ec5Headers(CONFIG.PULSE_URL, { 'Content-Type': 'application/json' }), onload: () => {}, onerror: () => {},
      });
    } catch (e) {}
  }

  // ---------- Одна страница операций кассы ----------
  async function opsPage(cu, offset) {
    const body = { sort: [{ field: 'creationDate', value: 'desc' }], offset, limit: CONFIG.OPS_LIMIT,
      fields: [{ field: 'cashUuid', value: cu, values: null }],
      columns: ['creationDate', 'code', 'name', 'author'] };
    const r = await http('POST', CONFIG.KASSA_BASE + 'operations/get-filter-data', body);
    const j = r.json || {};
    return { items: j.items || [], foundCount: Number(j.foundCount != null ? j.foundCount : (j.items || []).length) };
  }

  // ---------- Сбор всей смены с пагинацией + детект неполноты ----------
  // Порт логики из work-hub/tools/ek5-kassa/ek5_kassa_collector.js (спека кассовой сессии).
  async function collectShift(log, cashUuids) {
    const agg = {};                 // ФИО -> {nal, beznal, ops}
    const diag = { vozvrat: [], cashOut: [], otherName: [], otherPayType: [] };
    const seen = new Set();
    let hasReturn = false, foundTotal = 0, collected = 0, shiftDate = null;

    for (const cu of (cashUuids && cashUuids.length ? cashUuids : CONFIG.CASH_UUIDS)) {
      let offset = 0, found = null, pages = 0;
      do {
        const page = await opsPage(cu, offset);
        if (found === null) { found = page.foundCount; foundTotal += found; }
        if (!page.items.length) break;                 // страница пустая — дальше нет смысла
        for (const it of page.items) {
          if (seen.has(it.code)) continue; seen.add(it.code); collected++;
          if (!shiftDate && it.creationDate) shiftDate = it.creationDate;
          const detail = await http('GET', CONFIG.KASSA_BASE + 'operations/' + it.code);
          const op = (detail.json || {}).operation || {};
          const a = norm(it.author);
          agg[a] = agg[a] || { nal: 0, beznal: 0, ops: 0 };
          agg[a].ops++;
          const name = it.name || '';
          if (name.includes('Инкассац')) continue;                 // внутр. движение — мимо
          const isVozvrat = /возврат|сторно|отмена/i.test(name);
          const isRevenue = name.startsWith('Оплата за услуги') || name === 'Оплата за товар';
          if (isVozvrat) { hasReturn = true; diag.vozvrat.push({ code: it.code, author: a, name }); }
          if (!isRevenue && !isVozvrat) diag.otherName.push({ code: it.code, author: a, name });
          for (const pd of (op.paymentDocuments || [])) {
            const pt = pd.paymentType && pd.paymentType.code;         // CASH | CARD
            const dt = pd.paymentDocumentType && pd.paymentDocumentType.code;
            const amt = pd.amount || 0;
            if (dt === 'CASH_OUT_ORDER') { diag.cashOut.push({ code: it.code, author: a, name, pt, amt }); continue; }
            if (dt !== 'CASH_IN_ORDER') continue;
            if (pt === 'CASH') { if (isRevenue) agg[a].nal += amt; }
            else if (pt === 'CARD') { if (isRevenue) agg[a].beznal += amt; }
            else diag.otherPayType.push({ code: it.code, author: a, name, pt, amt });
          }
        }
        offset += CONFIG.OPS_LIMIT; pages++;
      } while (collected < found && pages * CONFIG.OPS_LIMIT < CONFIG.PAGE_HARD_CAP);
    }
    for (const v of Object.values(agg)) { v.nal = Math.round(v.nal * 100) / 100; v.beznal = Math.round(v.beznal * 100) / 100; }
    // ЖЁСТКО: собрали меньше, чем заявлено — смена неполная, сверять её нельзя
    const incomplete = collected < foundTotal;
    // авторы возвратов — чтобы сверка откладывала ТОЧЕЧНО по ним, а не глушила всю смену
    const returnOperators = [...new Set(diag.vozvrat.map((v) => v.author))];
    // ПУСТАЯ смена = сняли не ту (между закрытием и снимком открылась новая, пустая).
    // Ноль при заполненном РНП дал бы Марии гигантское ложное расхождение — не валидна.
    const empty = collected === 0 || Object.keys(agg).length === 0;
    if (log) {
      log(`смена: операторов ${Object.keys(agg).length}, операций собрано ${collected}/${foundTotal}` +
          (hasReturn ? `, возврат у: ${returnOperators.join(', ')}` : '') +
          (incomplete ? ' ⚠️ НЕПОЛНАЯ → сигнал' : '') + (empty ? ' ⚠️ ПУСТАЯ → вероятно не та смена' : ''));
    }
    return { perOperator: agg, diagnostics: diag, hasReturn, returnOperators, collected, foundCount: foundTotal, incomplete, empty, date: shiftDate };
  }

  const isoDay = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const sentKey = (day) => 'ec5kassa:sent:' + day;
  const isoFromDDMM = (x) => { const p = String(x || '').split('.'); return (p.length === 3) ? (p[2] + '-' + p[1].padStart(2, '0') + '-' + p[0].padStart(2, '0')) : null; };

  // Ждём токен: касса читала rows:0, когда автоснятие срабатывало ДО того, как
  // приложение положило pwt в sessionStorage (пустой X-Auth-Token → сервер не отдаёт
  // операции). Даём токену появиться (до ~30с), иначе снимать нечем.
  async function waitPwt(tries) {
    for (let i = 0; i < (tries || 15); i++) { if (pwt()) return true; await new Promise((r) => setTimeout(r, 2000)); }
    return !!pwt();
  }

  // ---------- Отправка: помечаем снятым ТОЛЬКО если сервер принял ----------
  async function sendShift(log) {
    pulse('kassa-run', 0);
    if (!(await waitPwt(15))) { log && log('⚠️ нет токена pwt — смена не снята, повтор позже'); pulse('kassa-notoken', 0); return false; }
    const ident = await resolveIdentity();
    log && log(`касса точки: source=${ident.source}, office=${ident.officeCode}, касс=${ident.cashUuids.length}`);
    const shift = await collectShift(log, ident.cashUuids);
    const day = isoFromDDMM(shift.date) || isoDay();   // дата СМЕНЫ (по операциям), не «сегодня»
    // ключ дедупа привязан к офису — чтобы разные точки не гасили снятие друг у друга
    const key = sentKey(ident.officeCode + ':' + day);
    try { if (localStorage.getItem(key) === '1') return true; } catch (e) {}
    if (shift.incomplete) pulse('kassa-incomplete', shift.collected, ident);
    if (shift.empty) pulse('kassa-empty', 0, ident);
    // ЗАЩИТА ОТ ПЕРЕТИРАНИЯ ЧУЖОЙ ТОЧКИ: сервер держит одну строку на (office,date)
    // с ON CONFLICT REPLACE. Если самоопределение не сработало (source=config) и смена
    // пустая — это, скорее всего, НЕ Садовод-1 (чужой токен к нашей кассе даёт пусто).
    // Тогда НЕ шлём: иначе пустышка перетрёт настоящую строку Садовода-1 в БД.
    if (ident.source === 'config' && shift.empty) {
      log && log('⚠️ хардкод-фоллбэк + пустая смена — не шлю (защита строки Садовод-1)');
      pulse('kassa-unidentified', 0, ident);
      return false;
    }
    const payload = { source: 'ec5-kassa-userscript', version: CONFIG.VER, date: day,
      pvz: ident.pvz, office: ident.officeCode, detectSource: ident.source, cashUuids: ident.cashUuids,
      hasReturn: shift.hasReturn, returnOperators: shift.returnOperators,
      incomplete: shift.incomplete, empty: shift.empty,
      collected: shift.collected, foundCount: shift.foundCount,
      perOperator: shift.perOperator, diagnostics: shift.diagnostics };
    let savedOurs = false;
    try {
      const r = await http('POST', CONFIG.OURS_URL, payload);
      savedOurs = r.status >= 200 && r.status < 300 && (!r.json || r.json.ok !== false);
      log && log(savedOurs ? `✅ смена на сервере (операторов ${Object.keys(shift.perOperator).length}${shift.empty ? ', ПУСТАЯ — помечена' : ''})`
                           : `⚠️ сервер не принял: HTTP ${r.status}`);
    } catch (e) { log && log('⚠️ не достучался до сервера: ' + ((e && e.message) || '')); }
    // помечаем день снятым только при валидной смене: пустую/сомнительную НЕ фиксируем,
    // чтобы ручной повтор мог снять правильную, пока она ещё «последняя».
    if (savedOurs && !shift.empty) { try { localStorage.setItem(key, '1'); } catch (e) {} pulse('kassa-ok', shift.collected, ident); }
    return savedOurs;
  }

  // ---------- Ручной запуск (меню) ----------
  const clog = (m) => console.log('[ec5-kassa]', m);
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('💰 Снять кассу за смену (сейчас)', () => sendShift(clog));
  }
  window.__ec5kassa = { sendShift, collectShift, CONFIG };

  // ---------- Автозапуск: MutationObserver на закрытие смены ----------
  // Ловим переход шапки «Кассовая смена открыта» → «…закрыта». Снимаем ОДИН раз на
  // закрытие. Если при загрузке смена уже закрыта — не стреляем (нет перехода): это
  // прошлая смена, её уже сняли/не наша забота. Дедуп по дню в localStorage.
  let shiftState = null;            // 'open' | 'closed' | null
  let firing = false, lastCheck = 0;
  function readState() {
    const t = (document.body && document.body.textContent) || '';
    if (/Кассовая смена\s+закрыт/i.test(t)) return 'closed';
    if (/Кассовая смена\s+открыт/i.test(t)) return 'open';
    return null;
  }
  async function onClose() {
    if (firing) return;
    firing = true;
    try { await sendShift(clog); } catch (e) { clog('автоснятие не удалось: ' + (e && e.message)); }
    finally { firing = false; }
  }
  function check() {
    const now = Date.now();
    if (now - lastCheck < 800) return;    // троттлинг
    lastCheck = now;
    const s = readState();
    if (!s) return;
    if (shiftState && shiftState !== 'closed' && s === 'closed') onClose();  // переход open→closed
    shiftState = s;
  }
  try {
    const mo = new MutationObserver(check);
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    check();                              // инициализация состояния
    // Смена уже закрыта на момент загрузки (оператор открыл cashboxng ПОСЛЕ закрытия) —
    // снимаем сразу. Дата берётся из операций, дедуп по дате смены: вчерашнюю не примем
    // за сегодня, сегодняшнюю не заблокируем. Пустую сервер отложит.
    if (readState() === 'closed') onClose();
  } catch (e) { clog('обсёрвер не стартовал: ' + (e && e.message)); }

  pulse('kassa-loaded', 0);   // heartbeat: скрипт установлен и жив на этой точке

  // Диагностика самоопределения в pulse.jsonl: даём приложению прогреться и токену
  // появиться, затем публикуем, ЧТО определили (source/office/кол-во касс). На
  // следующих прогонах Садовод-1 в pulse.jsonl должно быть событие kassa-detect с
  // rows>0 (нашли касс) и source=sniff|probe (в идеале) либо config (фоллбэк).
  setTimeout(async () => {
    try {
      await waitPwt(20);
      const ident = await resolveIdentity();
      pulse('kassa-detect', (ident.cashUuids || []).length, ident);
    } catch (e) {}
  }, 40 * 1000);
})();

// ===================== БЛОК УПАКОВКИ (влит из vault ec5-upack 0.1.0; сбор Superset -> /ec5-upack) =====================
(function () {
  "use strict";
  if (location.host.indexOf('cashboxng') !== -1) return;  // упаковка — на ek5
  // --- развязка с трафиком/кассой: свой namespace, свои ключи upack:* ---
  const SRV = "http://5.42.124.252/ec5-upack";
  const SUP = "https://superset.cdek.ru";
  const CODES = ["MSK548", "MSK456", "KAM32", "MSK2432"];
  const OFF_2701 = "dictGet('bi.dct_company_structure', 'office_name', from_office_uuid)";
  const OFF_2446 = "dictGet('bi.dct_company_structure', 'office_name', proceed_office_uuid)";
  const MONTHS = ["", "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль",
                  "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  const get = (k) => GM_getValue("upack:" + k, "");
  const set = (k, v) => GM_setValue("upack:" + k, v);
  const iso = (d) => d.toISOString().slice(0, 10);
  const log = (...a) => console.log("[upack]", ...a);

  // Пульс в /ec5-pulse — чтобы в pulse.jsonl было видно, что сбор упаковки живой
  // и с какой выручкой (наблюдаемость для сервера/хартбита). Fire-and-forget.
  function upackPulse(qty, rub, ok) {
    try {
      GM_xmlhttpRequest({
        method: "POST", url: "http://5.42.124.252/ec5-pulse",
        data: JSON.stringify({ event: "upack", rows: qty || 0, ver: "0.9.20",
          host: location.hostname || "", note: (ok ? "ok " : "postfail ") + "rub=" + (rub || 0) }),
        headers: ec5Headers("http://5.42.124.252/ec5-pulse", { "Content-Type": "application/json" }),
        onload: () => {}, onerror: () => {},
      });
    } catch (e) {}
  }

  function gm(method, url, body, headers) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method, url, data: body || null,
        headers: ec5Headers(url, headers),
        onload: (r) => res(r),
        onerror: () => rej(new Error("net " + url)),
        ontimeout: () => rej(new Error("timeout " + url)),
        timeout: 60000,
      });
    });
  }

  async function supQuery(datasetId, columns, metrics, where, timeRange, csrf) {
    const body = JSON.stringify({
      datasource: { id: datasetId, type: "table" },
      result_format: "json", result_type: "full",
      queries: [{
        columns, metrics, filters: [], extras: { where },
        granularity: "date_value", time_range: timeRange, row_limit: 200, orderby: [],
      }],
    });
    const r = await gm("POST", SUP + "/api/v1/chart/data", body,
      { "Content-Type": "application/json", "X-CSRFToken": csrf, "Referer": SUP + "/" });
    if (r.status !== 200) throw new Error("chart/data " + r.status + " " + r.responseText.slice(0, 200));
    return JSON.parse(r.responseText).result[0].data;
  }

  async function collect(period, monthKey, timeRange) {
    log("сбор", period, timeRange);
    // сессия Superset жива? (тянем csrf; при 401 — не собираем, попробуем в след. заход)
    const cr = await gm("GET", SUP + "/api/v1/security/csrf_token/", null, { "Referer": SUP + "/" });
    if (cr.status !== 200) {
      const me = await gm("GET", SUP + "/api/v1/me/", null, { "Referer": SUP + "/" });
      const stg = (cr.status === 403) ? "no_rights" : "no_session";
      const why = (cr.status === 403) ? ("аккаунт без прав к Superset (me=" + me.status + ")")
                : (cr.status === 401) ? "нет сессии Superset"
                : ("Superset csrf " + cr.status);
      log("Superset csrf", cr.status, "me", me.status, cr.responseText.slice(0, 120));
      set("lastResult", new Date().toISOString() + "|" + stg + "|" + why + " / " + cr.responseText.slice(0, 70).replace(/\|/g, "-"));
      return false;
    }
    const csrf = JSON.parse(cr.responseText).result;

    const w2701 = "(" + CODES.map((c) => `${OFF_2701} LIKE '${c}%'`).join(" OR ") + ")";
    const w2446 = "(" + CODES.map((c) => `${OFF_2446} LIKE '${c}%'`).join(" OR ") + ")";

    const byPvz = await supQuery(2701,
      [{ expressionType: "SQL", sqlExpression: OFF_2701, label: "office" }],
      ["Выручка за упаковку", { expressionType: "SQL", sqlExpression: "SUM(cnt_package)", label: "qty" }],
      w2701, timeRange, csrf);
    const salesByPvz = {};
    for (const row of byPvz) {
      const code = (row.office || "").split(",")[0].trim();
      if (CODES.includes(code)) salesByPvz[code] = { rub: Math.round(row["Выручка за упаковку"] || 0), qty: row.qty || 0 };
    }

    // Разбивка по типам (наценка) — датасет 2446. НЕ верифицирован так же надёжно,
    // как 2701 (продажи по ПВЗ — главное для Марии). Поэтому best-effort: если 2446
    // упадёт (нет колонки date_value / сменилось имя метрики / права), НЕ роняем весь
    // сбор, а шлём хотя бы sales_by_pvz. Наценочная таблица просто будет пустой.
    let salesByType = [];
    try {
      const byType = await supQuery(2446, ["ADD_SERVICE_NAME"],
        ["Выручка, руб", "Кол-во заказов"], w2446, timeRange, csrf);
      salesByType = byType.map((r) => ({
        type: r.ADD_SERVICE_NAME, rub: Math.round(r["Выручка, руб"] || 0), orders: r["Кол-во заказов"] || 0,
      })).filter((x) => x.type && x.orders > 0);
    } catch (e) { log("2446 (типы) не собрался, шлём только ПВЗ:", (e && e.message) || e); }

    const payload = { period, month_key: monthKey, sales_by_pvz: salesByPvz, sales_by_type: salesByType };
    let tq = 0, tr = 0;
    for (const c of CODES) { const d = salesByPvz[c]; if (d) { tq += d.qty || 0; tr += d.rub || 0; } }

    const pr = await gm("POST", SRV, JSON.stringify(payload), { "Content-Type": "application/json" });
    let ok = false; try { ok = pr.status === 200 && JSON.parse(pr.responseText).ok; } catch (e) {}
    log("приёмник:", pr.status, pr.responseText.slice(0, 160));
    upackPulse(tq, tr, ok);
    set("lastResult", new Date().toISOString() + "|" + (ok ? "ok" : "post" + pr.status) + "|" + (ok ? period : pr.responseText.slice(0, 60)));
    return ok;   // помечаем снятым ТОЛЬКО при ok (сервер реально опубликовал)
  }

  async function run() {
    const now = new Date();
    const today = iso(now);
    // --- месячный: после 5-го числа, за прошлый месяц, один раз ---
    const py = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const pm = now.getMonth() === 0 ? 12 : now.getMonth(); // 1..12, прошлый месяц
    const prevKey = `${py}-${String(pm).padStart(2, "0")}`;
    if (now.getDate() >= 5 && get("lastMonthly") !== prevKey) {
      const start = `${py}-${String(pm).padStart(2, "0")}-01`;
      const end = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      try {
        if (await collect(`${MONTHS[pm]} ${py}`, prevKey, `${start} : ${end}`)) set("lastMonthly", prevKey);
      } catch (e) { log("месячный сбой:", e.message); set("lastResult", new Date().toISOString() + "|error|мес: " + (e.message || "").slice(0, 60)); }
    }
    // --- недельный: не чаще раза в 7 дней, текущий месяц по сегодня ---
    const last = get("lastWeekly");
    const days = last ? (now - new Date(last)) / 86400000 : 999;
    if (days >= 7) {
      const y = now.getFullYear(), m = now.getMonth() + 1;
      const start = `${y}-${String(m).padStart(2, "0")}-01`;
      const end = iso(new Date(now.getTime() + 86400000)); // включая сегодня
      try {
        if (await collect(`${MONTHS[m]} ${y}`, `${y}-${String(m).padStart(2, "0")}`, `${start} : ${end}`)) set("lastWeekly", today);
      } catch (e) { log("недельный сбой:", e.message); set("lastResult", new Date().toISOString() + "|error|нед: " + (e.message || "").slice(0, 60)); }
    }
  }

  // заход в ЭК5 = попытка; сессия Superset подхватывается, т.к. вход в неё идёт из ЭК5
  setTimeout(run, 130000);
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('📦 Снять упаковку (сейчас)', async () => {
      const now = new Date(), y = now.getFullYear(), m = now.getMonth() + 1;
      const mk = y + '-' + String(m).padStart(2, '0');
      try { await collect(MONTHS[m] + ' ' + y, mk, mk + '-01 : ' + iso(new Date(now.getTime() + 86400000))); }
      catch (e) { set('lastResult', new Date().toISOString() + '|error|ручной: ' + (e.message || '').slice(0, 60)); }
    });
  }
})();

// ===================== БЛОК СОТРУДНИКОВ (getEmployeeList -> /ec5-employees, раз в сутки) =====================
(function () {
  'use strict';
  if (location.host.indexOf('cashboxng') !== -1) return;   // сотрудники — на ek5/orderec5
  const SRV = 'http://5.42.124.252/ec5-employees';
  const U = 'https://gateway.cdek.ru/coworker/web/coworker/v1/employee/getEmployeeList';
  const DAYKEY = 'ec5emp:lastrun';
  const OFFKEY = 'ec5emp:office';   // выученный офис точки (uuid+code), переживает перезагрузки
  const pwt = () => sessionStorage.getItem('pwt') || localStorage.getItem('pwt') || '';

  // Самоопределение офиса: хардкод — ФОЛЛБЭК (Садовод-1). Пассивно подслушиваем
  // СОБСТВЕННЫЙ запрос приложения getEmployeeList (оператор открыл раздел «Сотрудники»)
  // и запоминаем office-uuid ЭТОЙ точки. Пока не выучили — работаем на хардкоде, но
  // getEmployeeList с чужим uuid под другим аккаунтом вернёт пусто → run() просто не
  // отправит (не перетрёт чужую точку). Всё в try/catch, любой сбой → хардкод.
  const U_EMP_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const ID = { uuid: '931dcd8e-4397-4006-ba9c-2a96ae2ee15d', code: 'MSK548', source: 'config' };
  try {
    const saved = (typeof GM_getValue === 'function') ? GM_getValue(OFFKEY, '') : '';
    if (saved) { const o = JSON.parse(saved); if (o && U_EMP_RE.test(o.uuid || '')) { ID.uuid = o.uuid; ID.code = o.code || ID.code; ID.source = 'learned'; } }
  } catch (e) {}
  function learnOffice(body) {
    try {
      const j = (typeof body === 'string') ? JSON.parse(body) : body;
      const f = (j && j.fields) || [];
      for (const it of f) {
        if (it && String(it.field).toLowerCase() === 'office') {
          const u = (it.values && it.values[0]) || it.value;
          if (U_EMP_RE.test(u || '') && u !== ID.uuid) {
            ID.uuid = u; ID.code = 'OFF-' + String(u).slice(0, 8); ID.source = 'learned';
            try { GM_setValue && GM_setValue(OFFKEY, JSON.stringify({ uuid: ID.uuid, code: ID.code })); } catch (e) {}
          }
        }
      }
    } catch (e) {}
  }
  try {
    const XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XP && !XP.__ec5emp) {
      const oOpen = XP.open, oSend = XP.send;
      XP.open = function (m, u) { try { this.__eu = u; } catch (e) {} return oOpen.apply(this, arguments); };
      XP.send = function (b) { try { if (String(this.__eu || '').indexOf('getEmployeeList') !== -1 && typeof b === 'string') learnOffice(b); } catch (e) {} return oSend.apply(this, arguments); };
      XP.__ec5emp = true;
    }
    const of = window.fetch;
    if (typeof of === 'function' && !of.__ec5emp) {
      const wf = function (input, init) {
        try { let url = (typeof input === 'string') ? input : (input && input.url) || ''; if (url.indexOf('getEmployeeList') !== -1 && init && typeof init.body === 'string') learnOffice(init.body); } catch (e) {}
        return of.apply(this, arguments);
      };
      wf.__ec5emp = true; window.fetch = wf;
    }
  } catch (e) {}
  const gm = (method, url, data, headers) => new Promise((res) => {
    GM_xmlhttpRequest({ method, url, data, headers: ec5Headers(url, headers), timeout: 60000,
      onload: (r) => res({ status: r.status, text: r.responseText }),
      onerror: () => res({ status: 0, text: '' }), ontimeout: () => res({ status: -1, text: '' }) });
  });
  async function list(status) {
    const body = JSON.stringify({ sort: [], offset: 0, limit: 100,
      fields: [{ field: 'office', value: null, values: [ID.uuid] },
               { field: 'status', value: status, values: null }],
      columns: ['code','fullName','position','structureDepartment','dateIn','dateOut','status'] });
    const r = await gm('POST', U, body, { 'Content-Type': 'application/json', 'X-Auth-Token': pwt() });
    if (r.status !== 200) return null;
    try { return (JSON.parse(r.text).items) || []; } catch (e) { return null; }
  }
  async function run() {
    const today = new Date().toLocaleDateString('ru-RU');
    try { if (typeof GM_getValue === 'function' && GM_getValue(DAYKEY, '') === today) return; } catch (e) {}
    if (!pwt()) return;                          // нет сессии — завтра
    const works = await list('WORKS');
    if (works === null) return;                 // ошибка/нет сессии — не портим гейт
    const fired = (await list('FIRED')) || [];  // если значение статуса иное — просто без уволенных (дифф ловит по отсутствию)
    const emps = works.concat(fired).map((e) => ({
      office: ID.code, code: e.code, fio: e.fullName, dept: e.structureDepartment || '',
      pos: e.position || '', dateIn: e.dateIn || '', dateOut: e.dateOut || '', status: e.status || '' }));
    if (!emps.length) return;
    const pr = await gm('POST', SRV, JSON.stringify({ date: today, office: ID.code, source: 'EK5', employees: emps }),
      { 'Content-Type': 'application/json' });
    if (pr.status === 200) { try { GM_setValue && GM_setValue(DAYKEY, today); } catch (e) {} }  // гейт только при успехе
  }
  setTimeout(run, 120000);   // раз в сутки, через 2 мин после открытия
})();
