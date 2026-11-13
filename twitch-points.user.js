// ==UserScript==
// @name         實況牆・Twitch 點數助手
// @namespace    streamwall
// @version      1.0.0
// @description  在 twitch.tv 自動領取忠誠點數獎勵箱；搭配「實況牆」可讓一個分頁輪流停留在多個頻道
// @match        https://www.twitch.tv/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

/*
 * 這支腳本做兩件事：
 *
 * 1. 自動領獎勵箱：任何 twitch.tv 分頁上，聊天室下方出現「領取獎勵」按鈕時幫你按下去。
 *
 * 2. 點數輪播：從「實況牆」的點數面板開啟的分頁，網址後面會帶著
 *      #sw-points=頻道A,頻道B,頻道C&dwell=15&lowq=1
 *    這個分頁就會每隔 dwell 分鐘換到下一個頻道，離線的會跳過。
 *    Twitch 同一個帳號同時大約只有 2 台會計點，所以最多開 2 個這樣的分頁。
 *
 * 所有狀態都存在這個分頁自己的 sessionStorage，關掉分頁就結束，不會影響其他分頁。
 * Twitch 改版後如果失效，通常只需要更新下面 SELECTORS 裡的選擇器。
 */
(function () {
  'use strict';

  var SELECTORS = {
    // 獎勵箱按鈕（由上到下依序嘗試）
    claim: [
      '.claimable-bonus__icon',
      '[data-test-selector="community-points-summary"] button[aria-label*="Claim" i]',
      '.community-points-summary button[aria-label*="Claim" i]',
      '.community-points-summary button[aria-label*="領取"]'
    ],
    // 出現任何一個就代表正在實況
    live: [
      '[data-a-target="animated-channel-viewers-count"]',
      '.live-time'
    ],
    // 成人內容等提示畫面上的「開始觀看」按鈕（只在輪播分頁會自動按）
    gate: [
      '[data-a-target="content-classification-gate-overlay-start-watching-button"]',
      '[data-a-target="player-overlay-mature-accept"]'
    ],
    // 出現任何一個就代表頻道頁已經載入完成（用來區分「離線」和「還在載入」）
    loaded: [
      '[data-a-target="chat-input"]',
      '.channel-root',
      '.channel-info-content',
      '#offline-channel-main-content'
    ]
  };

  var RUN_KEY = 'sw.points.run';
  var NAME_RE = /^[a-z0-9_]{2,25}$/;
  var IS_TOP = (function () { try { return window.top === window.self; } catch (e) { return false; } })();
  var log = function () {
    var args = ['%c[點數助手]', 'color:#ffb020;font-weight:bold'].concat([].slice.call(arguments));
    console.log.apply(console, args);
  };

  /* ── 輪播狀態 ─────────────────────────────────────────────── */
  function loadRun() {
    try {
      var r = JSON.parse(sessionStorage.getItem(RUN_KEY));
      return r && Array.isArray(r.list) && r.list.length ? r : null;
    } catch (e) { return null; }
  }
  function saveRun() { try { run ? sessionStorage.setItem(RUN_KEY, JSON.stringify(run)) : sessionStorage.removeItem(RUN_KEY); } catch (e) {} }

  function readHash() {
    var m = /(?:^#|&)sw-points=([^&]*)/.exec(location.hash);
    if (!m) return null;
    var list = decodeURIComponent(m[1]).toLowerCase().split(',').filter(function (n, i, a) { return NAME_RE.test(n) && a.indexOf(n) === i; });
    if (!list.length) return null;
    var dwell = parseInt((/(?:^#|&)dwell=(\d+)/.exec(location.hash) || [])[1], 10);
    var lowq = (/(?:^#|&)lowq=(\d)/.exec(location.hash) || [])[1];
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    return {
      list: list, i: 0,
      dwell: Math.min(240, Math.max(5, dwell || 15)),
      lowq: lowq !== '0', skip: true,
      since: Date.now(), miss: 0, negatives: 0, sleepUntil: 0, awaySince: 0, claimed: 0
    };
  }

  var run = null;
  if (IS_TOP) {
    run = readHash() || loadRun();
    if (run) saveRun();
  }

  /* ── 點數分頁用最低畫質（只影響這個分頁） ─────────────────── */
  if (run && run.lowq) {
    try {
      var proto = Storage.prototype, getItem = proto.getItem, setItem = proto.setItem;
      proto.getItem = function (key) {
        if (key === 'video-quality' && this === window.localStorage) return '{"default":"160p30"}';
        return getItem.apply(this, arguments);
      };
      proto.setItem = function (key) {
        if (key === 'video-quality' && this === window.localStorage) return;   // 不把低畫質寫回你的偏好設定
        return setItem.apply(this, arguments);
      };
    } catch (e) { log('無法套用低畫質', e); }
  }

  /* ── 自動領獎勵箱 ─────────────────────────────────────────── */
  var claimCooldown = 0, sessionClaims = 0;
  function findClaimButton() {
    for (var i = 0; i < SELECTORS.claim.length; i++) {
      var node = document.querySelector(SELECTORS.claim[i]);
      if (node) return node.closest('button') || node;
    }
    return null;
  }
  function checkClaim() {
    if (Date.now() < claimCooldown) return;
    var btn = findClaimButton();
    if (!btn) return;
    claimCooldown = Date.now() + 10000;
    setTimeout(function () {
      try {
        btn.click();
        sessionClaims++;
        if (run) { run.claimed = (run.claimed || 0) + 1; saveRun(); }
        log('已領取獎勵箱（這個分頁累計 ' + (run ? run.claimed : sessionClaims) + ' 次）');
        renderPanel();
      } catch (e) { log('領取失敗', e); }
    }, 600 + Math.random() * 1800);
  }

  /* ── 是否正在實況 ─────────────────────────────────────────── */
  function any(list) { for (var i = 0; i < list.length; i++) if (document.querySelector(list[i])) return true; return false; }
  // true＝實況中，false＝離線，null＝還看不出來
  function liveState() {
    if (any(SELECTORS.live)) return true;
    var v = document.querySelector('video');
    // 直播串流的長度是無限大或一個極大的數字，重播與精華則是一般長度
    if (v && v.readyState >= 2 && (v.duration === Infinity || v.duration > 1e6)) return true;
    return any(SELECTORS.loaded) ? false : null;
  }

  /* ── 輪播 ─────────────────────────────────────────────────── */
  function currentPath() { return (location.pathname.split('/')[1] || '').toLowerCase(); }
  function goTo(index) {
    run.i = ((index % run.list.length) + run.list.length) % run.list.length;
    run.since = Date.now(); run.negatives = 0; run.awaySince = 0; run.sleepUntil = 0;
    saveRun();
    log('換到 ' + run.list[run.i]);
    location.assign('https://www.twitch.tv/' + run.list[run.i]);
  }
  function stopRun() {
    run = null; saveRun();
    if (panel) { panel.remove(); panel = null; }
    log('已停止輪播');
  }

  function passGate() {
    for (var i = 0; i < SELECTORS.gate.length; i++) {
      var b = document.querySelector(SELECTORS.gate[i]);
      if (b) { try { b.click(); log('已按下「開始觀看」'); } catch (e) {} return; }
    }
  }

  function tick() {
    checkClaim();
    if (!run) return;
    passGate();
    var now = Date.now(), here = currentPath(), want = run.list[run.i];

    if (run.sleepUntil) {                       // 整輪都離線，休息中
      if (now >= run.sleepUntil) return goTo(run.i + 1);
      return renderPanel();
    }
    if (here !== want) {                        // 被揪團帶走或手動換頁
      if (!run.awaySince) { run.awaySince = now; saveRun(); }
      if (now - run.awaySince > 25000) return goTo(run.i + (run.list.length > 1 ? 1 : 0));
      return renderPanel();
    }
    if (run.awaySince) { run.awaySince = 0; saveRun(); }

    var elapsed = now - run.since;
    if (run.skip && elapsed > 45000) {
      var live = liveState();
      if (live === true) { if (run.miss || run.negatives) { run.miss = 0; run.negatives = 0; saveRun(); } }
      else if (live === false) {
        run.negatives = (run.negatives || 0) + 1;
        if (run.negatives >= 3) {               // 連續三次都判定離線才跳過
          run.miss = (run.miss || 0) + 1;
          if (run.miss >= run.list.length) {    // 整輪都沒人開台：休息 5 分鐘再看
            run.miss = 0; run.negatives = 0; run.sleepUntil = now + 5 * 60000; saveRun();
            log('清單裡目前都沒有開台，5 分鐘後再檢查');
            return renderPanel();
          }
          saveRun();
          log(want + ' 目前離線，跳過');
          return goTo(run.i + 1);
        }
        saveRun();
      }
    }
    if (run.list.length > 1 && elapsed >= run.dwell * 60000) return goTo(run.i + 1);
    renderPanel();
  }

  /* ── 左下角的小面板（只有輪播分頁會出現） ─────────────────── */
  var panel = null, panelText = null, panelSub = null;
  function el(tag, style, text) {
    var n = document.createElement(tag);
    if (style) n.style.cssText = style;
    if (text) n.textContent = text;
    return n;
  }
  function buildPanel() {
    panel = el('div', 'position:fixed;left:12px;bottom:12px;z-index:2147483000;display:flex;align-items:center;gap:10px;' +
      'padding:8px 10px;background:#1A212B;color:#E9EEF4;border:1px solid #33404F;border-left:3px solid #FFB020;border-radius:8px;' +
      'font:500 13px/1.4 system-ui,"PingFang TC","Microsoft JhengHei",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45)');
    var info = el('div', 'min-width:150px');
    panelText = el('div', 'font-weight:600');
    panelSub = el('div', 'color:#93A2B5;font-size:12px');
    info.appendChild(panelText); info.appendChild(panelSub);
    var btnCss = 'height:26px;padding:0 9px;background:#242E3B;color:#E9EEF4;border:1px solid #33404F;border-radius:6px;font:inherit;cursor:pointer';
    var next = el('button', btnCss, '下一台');
    next.type = 'button';
    next.addEventListener('click', function () { if (run) goTo(run.i + 1); });
    var skip = el('button', btnCss);
    skip.type = 'button';
    skip.title = '判斷離線有誤時可以關掉';
    skip.addEventListener('click', function () { if (!run) return; run.skip = !run.skip; run.negatives = 0; run.miss = 0; saveRun(); renderPanel(); });
    panel._skip = skip;
    var stop = el('button', btnCss, '停止');
    stop.type = 'button';
    stop.addEventListener('click', stopRun);
    panel.appendChild(info); panel.appendChild(next); panel.appendChild(skip); panel.appendChild(stop);
  }
  function mmss(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function renderPanel() {
    if (!run || !document.body) return;
    if (!panel) buildPanel();
    if (!panel.isConnected) document.body.appendChild(panel);
    var now = Date.now();
    panelText.textContent = '點數輪播 ' + (run.i + 1) + '/' + run.list.length + '　' + run.list[run.i];
    var sub;
    if (run.sleepUntil) sub = '都沒開台，' + mmss(run.sleepUntil - now) + ' 後再檢查';
    else if (run.list.length > 1) sub = mmss(run.dwell * 60000 - (now - run.since)) + ' 後換台';
    else sub = '只有一台，持續停留';
    panelSub.textContent = sub + '　已領 ' + (run.claimed || 0) + ' 次';
    panel._skip.textContent = run.skip ? '略過離線：開' : '略過離線：關';
  }

  /* ── 啟動 ─────────────────────────────────────────────────── */
  function start() {
    if (run) log('輪播清單：' + run.list.join(' → ') + '，每台 ' + run.dwell + ' 分鐘');
    renderPanel();
    setInterval(tick, 5000);
    if (run) setInterval(renderPanel, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
