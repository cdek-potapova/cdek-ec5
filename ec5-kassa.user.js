// ==UserScript==
// @name         EC5 Касса — сверка выручки по операторам
// @namespace    cdek.maria.kassa
// @version      0.1.0
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
  сервер принял» — ТА ЖЕ механика, что в ec5-collector (одна на оба, не изобретать вторую).

  ПРАВИЛА ВЫРУЧКИ (Мария, 12.08.2026; подтверждено кассовой сессией):
   - выручка = УСЛУГИ + ТОВАР (товар входит);
   - нал/безнал по paymentType.code в детали операции: CASH = нал, CARD = безнал;
   - считаем ТОЛЬКО приход клиента (paymentDocumentType.code = CASH_IN_ORDER);
   - CASH_OUT_ORDER внутри обычной операции = эквайринговое списание (карта→счёт), НЕ возврат;
   - инкассация — мимо (внутреннее движение);
   - касса у офиса ОДНА (мультикассовой версии нет — подтверждено дважды).
  КРИТЕРИЙ ДОВЕРИЯ: детерминированность + бит-в-бит там, где ручное чисто (безнал
  Субботкиной 47622≈47621). «Совпасть у всех» недостижимо — расхождение и есть сигнал.

  ⚠️ ВОЗВРАТ — ХВОСТ, ОСТАВЛЕН СОЗНАТЕЛЬНО: структура операции возврата вживую ещё не
  снята (12.08 возвратов не было). Пока не подтверждена — смену, где встретился возврат/
  сторно/отмена, помечаем hasReturn=true, и сверка на сервере такую смену ОТКЛАДЫВАЕТ,
  а не выдаёт расхождение. Ложный сигнал Марии по деньгам дороже пропущенного.

  ❗ ДВА СЛОТА ЖДУТ СПЕКИ ОТ КАССОВОЙ СЕССИИ (НЕ РЕВЕРСИТЬ — по поручению диспетчера):
   [СЛОТ-1] SHIFT_CLOSE — как поймать момент «смена закрыта» на cashboxng (событие/DOM/
            редирект/эндпоинт). Сейчас автозапуск ВЫКЛЮЧЕН, работает только ручное меню.
   [СЛОТ-2] SHIFT_QUERY — фильтр, чтобы взять операции ИМЕННО закрытой смены. Сниппет-
            заготовка берёт операции ТЕКУЩЕЙ ОТКРЫТОЙ смены (get-filter-data без даты).
            Для сверки нужна закрытая — нужен date/shift фильтр в fields (формат не снят).
*/

(function () {
  'use strict';

  const CONFIG = {
    GATEWAY: 'https://gateway.cdek.ru',
    KASSA_BASE: 'https://gateway.cdek.ru/cashbox-operating/web/v1/',
    OURS_URL: 'http://5.42.124.252/ec5-kassa',
    PULSE_URL: 'http://5.42.124.252/ec5-pulse',
    OFFICE_CODE: 'MSK548',          // только Садовод-1
    PVZ_NAME: 'Садовод-1',
    // касса у офиса одна; uuid подтвердить у кассовой сессии, что это касса MSK548:
    CASH_UUIDS: ['db7420b0-e528-41e7-a81f-1585cfaed4e1'],  // «Касса ЦУЭА Садовод»
    OPS_LIMIT: 100,
    VER: '0.1.0',
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

  // ---------- Сбор операций смены и агрегация по операторам ----------
  // Порт логики из work-hub/tools/ek5-kassa/ek5_kassa_collector.js (спека кассовой сессии).
  async function opsForCash(cu, shiftFields) {
    const body = { sort: [{ field: 'creationDate', value: 'desc' }], offset: 0, limit: CONFIG.OPS_LIMIT,
      fields: [{ field: 'cashUuid', value: cu, values: null }].concat(shiftFields || []),
      columns: ['creationDate', 'code', 'name', 'author'] };
    const r = await http('POST', CONFIG.KASSA_BASE + 'operations/get-filter-data', body);
    return (r.json && r.json.items) || [];
    // ⚠️ [СЛОТ-2]: пагинации нет (только offset:0, limit:100). Оживлённая смена может
    //    превысить 100 операций — нужна пагинация ИЛИ подтверждение потолка у кассовой сессии.
  }

  async function collectShift(log, shiftFields) {
    const agg = {};                 // ФИО -> {nal, beznal, ops}
    const diag = { vozvrat: [], cashOut: [], otherName: [], otherPayType: [] };
    const seen = new Set();
    let hasReturn = false;
    for (const cu of CONFIG.CASH_UUIDS) {
      for (const it of await opsForCash(cu, shiftFields)) {
        if (seen.has(it.code)) continue; seen.add(it.code);
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
    }
    for (const v of Object.values(agg)) { v.nal = Math.round(v.nal * 100) / 100; v.beznal = Math.round(v.beznal * 100) / 100; }
    const ops = Object.values(agg).reduce((s, v) => s + v.ops, 0);
    log && log(`смена собрана: операторов ${Object.keys(agg).length}, операций ${ops}${hasReturn ? ', есть возврат → сверка отложится' : ''}`);
    return { perOperator: agg, diagnostics: diag, hasReturn, ops };
  }

  const isoDay = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const shiftKey = (day) => 'ec5kassa:sent:' + day;

  // ---------- Отправка на сервер: помечаем снятым ТОЛЬКО если сервер принял ----------
  async function sendShift(log) {
    pulse('kassa-run', 0);
    const day = isoDay();
    // [СЛОТ-2]: shiftFields пока пуст -> берётся ТЕКУЩАЯ открытая смена. Для закрытой
    // подставить сюда снятый у кассовой сессии date/shift-фильтр.
    const shiftFields = [];
    const shift = await collectShift(log, shiftFields);
    const payload = { source: 'ec5-kassa-userscript', version: CONFIG.VER, date: day,
      pvz: CONFIG.PVZ_NAME, office: CONFIG.OFFICE_CODE, hasReturn: shift.hasReturn,
      perOperator: shift.perOperator, diagnostics: shift.diagnostics };
    let savedOurs = false;
    try {
      const r = await http('POST', CONFIG.OURS_URL, payload);
      savedOurs = r.status >= 200 && r.status < 300 && (!r.json || r.json.ok !== false);
      log && log(savedOurs ? `✅ смена на сервере (операторов ${Object.keys(shift.perOperator).length})`
                           : `⚠️ сервер не принял: HTTP ${r.status}`);
    } catch (e) { log && log('⚠️ не достучался до сервера: ' + ((e && e.message) || '')); }
    // как в трафике: помечаем «снято за день» только при успехе сервера, иначе дошлём
    if (savedOurs) { try { localStorage.setItem(shiftKey(day), '1'); } catch (e) {} pulse('kassa-ok', shift.ops); }
    return savedOurs;
  }

  // ---------- Ручной запуск (меню + горячая клавиша) ----------
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('💰 Снять кассу за смену (сейчас)', () => sendShift((m) => console.log('[ec5-kassa]', m)));
  }
  window.__ec5kassa = { sendShift, collectShift, CONFIG };

  // ---------- [СЛОТ-1] Автозапуск на закрытие смены — ВЫКЛЮЧЕН до спеки ----------
  // Как только кассовая сессия отдаст сигнал «смена закрыта» на cashboxng — повесить
  // сюда обработчик, вызывающий sendShift() один раз на закрытие. Пока НЕ включать:
  // ставить автозапуск, льющий выручку в сверку при неснятом фильтре закрытой смены и
  // неподтверждённом возврате, нельзя (решение диспетчера 12.08).
  pulse('kassa-loaded', 0);   // heartbeat: скрипт установлен и жив на этой точке
})();
