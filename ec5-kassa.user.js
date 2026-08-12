// ==UserScript==
// @name         EC5 Касса — сверка выручки по операторам
// @namespace    cdek.maria.kassa
// @version      0.3.0
// @description  На закрытии смены снимает выручку по операторам (нал/безнал) из кассы ЭК5 и шлёт на наш сервер для сверки с ручным вводом в РНП. НЕ пишет в РНП. Только Садовод-1 (MSK548).
// @match        https://cashboxng.cdek.ru/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      gateway.cdek.ru
// @connect      5.42.124.252
// @downloadURL  https://raw.githubusercontent.com/cdek-potapova/cdek-ec5/main/ec5-kassa.user.js
// @updateURL    https://raw.githubusercontent.com/cdek-potapova/cdek-ec5/main/ec5-kassa.user.js
// @run-at       document-idle
// ==/UserScript==

/*
  РАЗВЯЗКА С ТРАФИК-СКРИПТОМ (work-hub/КАРТА-ПРОЕКТОВ.md): другой @name/@namespace,
  @match ТОЛЬКО cashboxng, свои ключи localStorage (ec5kassa*), XHR НЕ патчим — ходим
  прямым fetch/GM_xmlhttpRequest. Heartbeat и правило «помечать снятым только если
  сервер принял» — ТА ЖЕ механика, что в ec5-collector (одна на оба).

  ПРАВИЛА ВЫРУЧКИ (Мария, 12.08.2026; подтверждено кассовой сессией на живых данных):
   - выручка = УСЛУГИ + ТОВАР; нал/безнал по paymentType.code (CASH/CARD) в детали;
   - только приход клиента (paymentDocumentType.code = CASH_IN_ORDER);
   - CASH_OUT_ORDER = эквайринговое списание, НЕ возврат; инкассация — мимо;
   - касса у офиса ОДНА. cashUuid MSK548 = db7420b0-… «Касса ЦУЭА Садовод» (зафикс. дважды).
  КРИТЕРИЙ ДОВЕРИЯ: детерминированность + бит-в-бит там, где ручное чисто. Расхождение = сигнал.

  СНЯТИЕ (ответы кассовой сессии 12.08, проверены живьём):
   - Фильтра закрытой смены НЕТ: get-filter-data игнорирует date/shift и всегда отдаёт
     текущую/последнюю смену. Значит снимаем В МОМЕНТ ЗАКРЫТИЯ и без фильтра;
     ретроактивно за прошлые дни поднять НЕЛЬЗЯ.
   - Триггер закрытия: MutationObserver по шапке «Список операций» — переход
     «Кассовая смена открыта» → «…закрыта» (событийно, без вмешательства в fetch/XHR).
     Опциональный точный URL POST-а «закрыть смену» дадут вечером — можно навесить
     вторым триггером, но обсёрвер уже закрывает петлю.
   - Пагинация: в ответе foundCount = истинный итог; листаем offset по 100, пока собрано
     < foundCount. ЖЁСТКО: собрали меньше foundCount → payload.incomplete=true и СИГНАЛ,
     сервер такую смену НЕ сверяет (неполная выручка Марии хуже отсутствия сверки).
     Открытый риск: maxAvailableCount:50 — если это жёсткий потолок, смены >50 операций
     не долистаются; тогда incomplete=true и поймаем сигналом, а не тихо.
   - ВОЗВРАТ: структура операции возврата вживую не снята → hasReturn=true + returnOperators
     (ФИО авторов возвратов). Сверка откладывает ТОЧЕЧНО по этим операторам, а не глушит
     всю смену (иначе один возврат убивает сигнал по всем за день).
   - ПУСТАЯ СМЕНА (дырка, найдена кассовой сессией): если между закрытием и снимком успела
     открыться новая смена, get-filter-data отдаст её пустой → foundCount=0/collected=0/
     incomplete=false, формально «полно», а по факту не та смена. Ноль против заполненного
     РНП = гигантское ложное расхождение. Ловим флагом empty=true (сервер откладывает,
     день снятым НЕ помечаем — ручной повтор ещё может снять правильную). Плюс снимать
     надо на самом событии закрытия, до открытия новой (сетевой триггер, URL вечером).
*/

(function () {
  'use strict';

  const CONFIG = {
    KASSA_BASE: 'https://gateway.cdek.ru/cashbox-operating/web/v1/',
    OURS_URL: 'http://5.42.124.252/ec5-kassa',
    PULSE_URL: 'http://5.42.124.252/ec5-pulse',
    OFFICE_CODE: 'MSK548',
    PVZ_NAME: 'Садовод-1',
    CASH_UUIDS: ['db7420b0-e528-41e7-a81f-1585cfaed4e1'],  // касса MSK548, одна (подтв.)
    OPS_LIMIT: 100,
    PAGE_HARD_CAP: 200,     // защита от бесконечного листания (макс страниц = cap/limit)
    VER: '0.3.0',
  };

  const pwt = () => sessionStorage.getItem('pwt') || localStorage.getItem('pwt') || '';
  const norm = (a) => String(a).replace(/\s+\d+$/, '').trim();   // «ФИО 6295» -> «ФИО»
  const cut = (s) => String(s == null ? '' : s).slice(0, 200).replace(/\s+/g, ' ').trim();

  // ---------- HTTP: прямой fetch/GM (XHR НЕ патчим) ----------
  function http(method, url, body) {
    const headers = { 'Content-Type': 'application/json', 'X-Auth-Token': pwt() };
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method, url, headers, data: body ? JSON.stringify(body) : undefined, timeout: 120000,
          onload: (r) => { let j = null; try { j = JSON.parse(r.responseText); } catch (e) {} resolve({ status: r.status, json: j, text: cut(r.responseText) }); },
          onerror: (e) => reject(new Error('сеть: ' + (cut(e && (e.error || e.statusText)) || 'отклонён'))),
          ontimeout: () => reject(new Error('таймаут (120с)')),
        });
      });
    }
    return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
      .then(async (r) => { const t = await r.text().catch(() => ''); let j = null; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, json: j, text: cut(t) }; });
  }

  // ---------- Пульс-сердцебиение (та же механика, что в трафике) ----------
  function pulse(event, rows) {
    try {
      GM_xmlhttpRequest({
        method: 'POST', url: CONFIG.PULSE_URL,
        data: JSON.stringify({ event: event || '', pvz: CONFIG.PVZ_NAME, rows: rows || 0,
                               host: location.hostname || '', ver: CONFIG.VER, note: 'kassa' }),
        headers: { 'Content-Type': 'application/json' }, onload: () => {}, onerror: () => {},
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
  async function collectShift(log) {
    const agg = {};                 // ФИО -> {nal, beznal, ops}
    const diag = { vozvrat: [], cashOut: [], otherName: [], otherPayType: [] };
    const seen = new Set();
    let hasReturn = false, foundTotal = 0, collected = 0;

    for (const cu of CONFIG.CASH_UUIDS) {
      let offset = 0, found = null, pages = 0;
      do {
        const page = await opsPage(cu, offset);
        if (found === null) { found = page.foundCount; foundTotal += found; }
        if (!page.items.length) break;                 // страница пустая — дальше нет смысла
        for (const it of page.items) {
          if (seen.has(it.code)) continue; seen.add(it.code); collected++;
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
    return { perOperator: agg, diagnostics: diag, hasReturn, returnOperators, collected, foundCount: foundTotal, incomplete, empty };
  }

  const isoDay = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const sentKey = (day) => 'ec5kassa:sent:' + day;

  // ---------- Отправка: помечаем снятым ТОЛЬКО если сервер принял ----------
  async function sendShift(log) {
    pulse('kassa-run', 0);
    const day = isoDay();
    const shift = await collectShift(log);
    if (shift.incomplete) pulse('kassa-incomplete', shift.collected);
    if (shift.empty) pulse('kassa-empty', 0);
    const payload = { source: 'ec5-kassa-userscript', version: CONFIG.VER, date: day,
      pvz: CONFIG.PVZ_NAME, office: CONFIG.OFFICE_CODE,
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
    if (savedOurs && !shift.empty) { try { localStorage.setItem(sentKey(day), '1'); } catch (e) {} pulse('kassa-ok', shift.collected); }
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
    const day = isoDay();
    try { if (localStorage.getItem(sentKey(day)) === '1') return; } catch (e) {}
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
  } catch (e) { clog('обсёрвер не стартовал: ' + (e && e.message)); }

  pulse('kassa-loaded', 0);   // heartbeat: скрипт установлен и жив на этой точке
})();
