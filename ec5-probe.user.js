// ==UserScript==
// @name         ЭК5: разведчик формата запросов
// @namespace    cdek.maria.probe
// @version      1.0.0
// @description  Временный скрипт. Снимает формат запросов кассы и сотрудников, чтобы сбор можно было повторить с сервера. Ставится на время, потом удаляется.
// @match        https://ek5.cdek.ru/*
// @match        https://cashboxng.cdek.ru/*
// @match        https://coworker-prime-ng.cdek.ru/*
// @match        https://orderec5ng.cdek.ru/*
// @grant        GM_xmlhttpRequest
// @connect      5.42.124.252
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/cdek-potapova/cdek-ec5/main/ec5-probe.user.js
// @updateURL    https://raw.githubusercontent.com/cdek-potapova/cdek-ec5/main/ec5-probe.user.js
// ==/UserScript==

/*
  ЗАЧЕМ ЭТО НУЖНО

  Разделы «Касса» и «Сотрудник» в ЭК5 живут в отдельных приложениях на своих
  поддоменах и открываются во фреймах. Из главного окна их запросы не видны:
  браузер не даёт заглянуть в чужой origin. Поэтому формат запроса, который
  нужен для автоматического сбора, обычным способом не снять.

  Tampermonkey умеет выполняться ВНУТРИ фрейма — этим и пользуемся.

  Скрипт только СМОТРИТ: перехватывает исходящие запросы к gateway.cdek.ru,
  записывает адрес и тело и отправляет их на наш сервер. Он ничего не меняет,
  ничего не отправляет в СДЭК и не трогает данные.

  КАК ПОЛЬЗОВАТЬСЯ
    1. Установить.
    2. Открыть в ЭК5 раздел «Касса», нажать «Найти».
    3. Открыть раздел «Сотрудник», нажать «Найти».
    4. Сказать Артёму — формат снят.
    5. УДАЛИТЬ скрипт: он временный и больше не нужен.

  ЧТО ИМЕННО УХОДИТ НА СЕРВЕР
  Только служебное: адрес метода, тело запроса (это фильтры — офис, даты,
  номера страниц) и первые полторы тысячи символов ответа, чтобы понять
  структуру. Ни ФИО клиентов, ни телефонов, ни сумм целиком.
*/

(function () {
  'use strict';

  const PROBE_URL = 'http://5.42.124.252/ec5-probe';
  const ИНТЕРЕСНЫЕ = ['cashbox', 'coworker', 'operations', 'employee'];
  const отправлено = new Set();

  function интересный(url) {
    const u = String(url || '');
    return u.includes('gateway.cdek.ru') && ИНТЕРЕСНЫЕ.some((k) => u.includes(k));
  }

  function отправить(method, url, body, resp) {
    // один и тот же метод шлём один раз — незачем засорять журнал
    const ключ = String(url).split('?')[0];
    if (отправлено.has(ключ)) return;
    отправлено.add(ключ);

    const пакет = JSON.stringify({
      method: method || '',
      url: String(url || ''),
      body: body ? String(body).slice(0, 6000) : '',
      resp: resp ? String(resp).slice(0, 1500) : '',
    });

    try {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST', url: PROBE_URL, data: пакет,
          headers: { 'Content-Type': 'application/json' },
          onload: () => console.log('[разведчик] снят формат:', ключ),
          onerror: () => {},
        });
      } else {
        fetch(PROBE_URL, {
          method: 'POST', body: пакет,
          headers: { 'Content-Type': 'application/json' },
        }).catch(() => {});
      }
    } catch (e) { /* разведка не должна мешать работе */ }
  }

  // --- перехват XHR (Angular ходит через него) ---
  const oOpen = XMLHttpRequest.prototype.open;
  const oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    this.__m = m; this.__u = u;
    return oOpen.call(this, m, u, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (интересный(this.__u)) {
      this.addEventListener('load', () => {
        let resp = '';
        try { resp = this.responseText || ''; } catch (e) {}
        отправить(this.__m, this.__u, body, resp);
      });
    }
    return oSend.call(this, body);
  };

  // --- перехват fetch на всякий случай ---
  const oFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
    const body = args[1] && args[1].body;
    const p = oFetch.apply(this, args);
    if (интересный(url)) {
      p.then((r) => {
        r.clone().text().then((t) => отправить('POST', url, body, t)).catch(() => {});
      }).catch(() => {});
    }
    return p;
  };

  console.log('[разведчик ЭК5] слежу за запросами кассы и сотрудников');
})();
