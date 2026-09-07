/*
 * CGV 좌석 자동 확보 스크립트 (페이지 내부에서 실행)
 *
 * 예매 페이지(/cnm/selectVisitorCnt)의 콘솔이나 CDP eval로 주입한다.
 * 조건에 맞는 좌석이 열리면 즉시 잡고 결제수단 선택 페이지까지 진입한 뒤 멈춘다.
 * 최종 결제는 절대 누르지 않는다.
 *
 * 동작 원리와 CGV 쪽 함정은 docs/FINDINGS.md 참고.
 */
(() => {
  // ─────────────────────────── 설정 ───────────────────────────
  var CFG = window.__CGV_CFG || {
    // 좌석 API는 기본적으로 자동 탐지한다(새로고침 요청을 가로챈다).
    // 직접 지정하려면 api에 쿼리 파라미터를 넣는다.
    api: null,
    personType: '일반',   // '일반' | '청소년'
    personCount: 1,       // 1~4
    targetRows: null,     // 예: ['I','J','K','L','M','N','O','P'] / null이면 전체
    rowRank: null,        // 예: {K:0,L:0,M:0,J:1,N:1,I:2,O:2,P:3} / 낮을수록 선호
    preferAdjacent: true, // 2매 이상일 때 연석 우선
    refreshMs: 1000,      // 좌석 API 갱신 주기 (35KB/회)
    scanMs: 100,          // DOM 스캔 주기 (MutationObserver가 주 경로, 이건 백업)
    autoPay: true         // 확보 후 결제수단 페이지까지 진입할지
  };


  if (window.__hunt) stopHunter(window.__hunt);

  var H = window.__hunt = {
    state: 'starting', scans: 0, refreshes: 0, personFixes: 0, attempts: 0, closerTicks: 0,
    log: [], picked: null, seatChip: null, rowMap: null, midLeft: 0,
    lastFree: null, lastTargetFree: null, personOk: null,
    tSeatClick: null, tPayClick: null, latencyMs: null, sheetMs: null,
    payHref: null, finalUrl: null, payBtnText: null, err: null, pending: []
  };
  function push(m) { H.log.push(new Date().toTimeString().slice(0, 8) + ' ' + m); if (H.log.length > 60) H.log.shift(); }
  function stopHunter(h) {
    try {
      clearInterval(h.scanTimer); clearInterval(h.refTimer);
      if (h.mo) h.mo.disconnect();
      (h.pending || []).forEach(clearTimeout);
    } catch (e) {}
  }

  // ───────────────── DOM 접근 (전부 textContent 사용: innerText는 리플로 유발) ─────────────────
  var _gen = null, _pnum = null, _ref = null;
  function alive(e) { return e && e.isConnected; }

  function personWrap() {
    if (alive(_gen)) return _gen;
    var w = document.querySelectorAll('.numberChoice_NumberWrap__JKTv1');
    for (var i = 0; i < w.length; i++) {
      if (new RegExp('^\\s*' + CFG.personType).test(w[i].textContent || '')) { _gen = w[i]; _pnum = null; return _gen; }
    }
    return null;
  }
  function personBtn() {
    if (alive(_pnum)) return _pnum;
    var g = personWrap(); if (!g) return null;
    var bs = g.querySelectorAll('button.btn-num');
    for (var j = 0; j < bs.length; j++) {
      if ((bs[j].textContent || '').trim() === String(CFG.personCount)) { _pnum = bs[j]; return _pnum; }
    }
    return null;
  }
  // 좌석 선택 이후에는 인원을 절대 다시 누르지 않는다 (좌석 선택이 초기화된다)
  function ensurePerson() {
    if (H.state !== 'running' && H.state !== 'starting') return H.personOk;
    var b = personBtn(); if (!b) { H.personOk = false; return false; }
    if (b.getAttribute('aria-pressed') === 'true') { H.personOk = true; return true; }
    b.click(); H.personFixes++; H.personOk = false; return false;
  }
  function refreshBtn() {
    if (alive(_ref)) return _ref;
    _ref = document.querySelector('[class*=cnms01520_titleWrap] button.btn-icon');
    return _ref;
  }
  // 확인 시트가 열리면 '결제하기' 버튼이 2개가 된다. 반드시 마지막(최상단) 것을 쓴다.
  function payButtons() {
    var all = document.querySelectorAll('button'), out = [];
    for (var i = 0; i < all.length; i++) if (/결제하기/.test(all[i].textContent || '')) out.push(all[i]);
    return out;
  }
  function payBtn() { var b = payButtons(); return b.length ? b[b.length - 1] : null; }
  function doneBtn() {
    var all = document.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) if ((all[i].textContent || '').trim() === '선택완료') return all[i];
    return null;
  }

  // 좌석표 모달이 닫혀 있으면 좌석이 일부만 렌더링되어 놓칠 수 있다.
  // 렌더된 좌석 수가 전체보다 눈에 띄게 적으면 '선택/변경'을 눌러 좌석표를 연다.
  function ensureSeatMap() {
    if (!H.rowMapSize) return;
    var rendered = countRendered();
    if (rendered >= H.rowMapSize * 0.95) return;
    var b = document.querySelector('[class*=cnms01520_seatSelectWrap] button.btn.btn-sm');
    if (b) { b.click(); H.seatMapOpens = (H.seatMapOpens || 0) + 1; push('좌석표 재오픈 (렌더 ' + rendered + '/' + H.rowMapSize + ')'); }
  }
  function countRendered() {
    var els = document.querySelectorAll('[data-seatlocno]'), seen = {}, n = 0;
    for (var i = 0; i < els.length; i++) {
      var loc = els[i].getAttribute('data-seatlocno');
      if (!seen[loc]) { seen[loc] = 1; n++; }
    }
    return n;
  }

  // ───────────────────────── 좌석 스캔 ─────────────────────────
  // 좌석 버튼은 메인 좌석표 + 미니맵으로 2벌 존재한다. style.width가 큰 쪽만 남긴다.
  function freeSeats() {
    var els = document.querySelectorAll('[data-seatlocno]:not([class*="seatDisabled"])');
    var best = {};
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (/seatPreferential/.test(e.className)) continue;   // 장애인석 제외
      var loc = e.getAttribute('data-seatlocno');
      var w = parseInt(e.style.width) || 0;
      if (!best[loc] || w > best[loc].w) best[loc] = { el: e, w: w };
    }
    var out = [], total = 0;
    for (var k in best) {
      total++;
      var info = H.rowMap[k];
      if (!info) continue;
      if (CFG.targetRows && CFG.targetRows.indexOf(info.row) === -1) continue;
      out.push({ el: best[k].el, loc: k, row: info.row, col: parseInt(info.col, 10), left: parseInt(best[k].el.style.left) });
    }
    out.totalFree = total;              // 미니맵 중복을 제거한 실제 빈 좌석 수(장애인석 제외)
    return out;
  }

  function rankOf(row) {
    if (CFG.rowRank && CFG.rowRank[row] != null) return CFG.rowRank[row];
    return 0;
  }
  // 원하는 매수만큼 좌석을 고른다. 연석 우선, 없으면 선호도순 낱개.
  function choose(cands) {
    var n = CFG.personCount;
    if (cands.length < n) return null;
    var byPref = cands.slice().sort(function (a, b) {
      var d = rankOf(a.row) - rankOf(b.row);
      return d ? d : (Math.abs(a.left - H.midLeft) - Math.abs(b.left - H.midLeft));
    });
    if (n === 1) return [byPref[0]];

    if (CFG.preferAdjacent) {
      var rows = {};
      cands.forEach(function (c) { (rows[c.row] = rows[c.row] || []).push(c); });
      var runs = [];
      Object.keys(rows).forEach(function (r) {
        var list = rows[r].sort(function (a, b) { return a.col - b.col; });
        for (var i = 0; i + n <= list.length; i++) {
          var ok = true;
          for (var j = 1; j < n; j++) if (list[i + j].col !== list[i + j - 1].col + 1) { ok = false; break; }
          if (ok) runs.push(list.slice(i, i + n));
        }
      });
      if (runs.length) {
        runs.sort(function (a, b) {
          var d = rankOf(a[0].row) - rankOf(b[0].row);
          if (d) return d;
          function ctr(g) { return Math.abs((g[0].left + g[g.length - 1].left) / 2 - H.midLeft); }
          return ctr(a) - ctr(b);
        });
        return runs[0];
      }
    }
    return byPref.slice(0, n);
  }

  function scan() {
    if (H.state !== 'running') return;
    H.scans++;
    var personWasOk = ensurePerson();
    var cands = freeSeats();
    H.lastFree = cands.totalFree;
    H.lastTargetFree = cands.length;
    var pick = choose(cands);
    if (!pick) return;
    // 인원 선택 직후면 React 반영을 한 틱 기다린다
    if (!personWasOk) { push('인원 재선택 직후 - 다음 틱 (후보=' + cands.length + ')'); return; }

    H.state = 'clicking'; H.attempts++;
    H.picked = pick.map(function (p) { return p.row + p.col; }).join(',');
    // 좌석을 잡는 즉시 새로고침·예약된 인원클릭을 전부 차단한다.
    // 전환 도중 인원 버튼이 눌리면 좌석 선택이 초기화되어 결제가 0원으로 깨진다.
    clearInterval(H.refTimer); clearInterval(H.scanTimer);
    H.pending.forEach(clearTimeout); H.pending = [];

    H.tSeatClick = performance.now();
    H.closerDeadline = H.tSeatClick + 5000; H.closerTicks = 0; H.payClicked = false;
    pick.forEach(function (p) { p.el.click(); });
    closerTick();                       // 대기 0ms
    push('SEAT-CLICKED ' + H.picked + ' (후보=' + cands.length + ')');
  }

  // ─────────────── 확보 후: 결제 버튼 활성화 즉시 클릭 ───────────────
  function closerTick() {
    if (H.payClicked || H.state !== 'clicking') return;
    H.closerTicks++;
    var d = doneBtn(); if (d && !d.disabled) d.click();
    var pay = payBtn();
    if (pay && !pay.disabled) {
      H.payClicked = true;
      H.payHref = location.href;
      H.tPayClick = performance.now();
      H.latencyMs = Math.round((H.tPayClick - H.tSeatClick) * 10) / 10;
      H.payBtnText = (pay.textContent || '').replace(/\s+/g, ' ').trim();
      mark();
      if (!CFG.autoPay) { H.state = 'held'; teardown(); push('좌석 확보 (autoPay=false) ' + H.picked); return; }
      pay.click();                      // 1단계: 확인 시트 열기
      H.state = 'paying'; teardown();
      push('결제하기 클릭 ' + H.picked + ' (좌석→결제 ' + H.latencyMs + 'ms, ' + H.closerTicks + '틱)');
      confirmSheet();
      return;
    }
    if (performance.now() > H.closerDeadline) {
      push('MISS ' + H.picked + ' 결제버튼 미활성 (' + H.closerTicks + '틱) - 재탐색');
      H.picked = null; H.state = 'running'; restart();
      return;
    }
    setTimeout(closerTick, 8);          // 비활성 탭에서 rAF는 33ms로 제한되므로 setTimeout 사용
  }

  // 2단계: "결제 전 확인해 주세요" 시트 안의 결제하기를 누른다. 연타 금지.
  function confirmSheet() {
    var t0 = performance.now();
    (function wait() {
      if (location.href !== H.payHref) return navOk();
      var b = payButtons();
      if (b.length >= 2 && !b[b.length - 1].disabled) {
        H.sheetMs = Math.round(performance.now() - t0);
        b[b.length - 1].click();
        push('확인시트 결제하기 클릭 (시트대기 ' + H.sheetMs + 'ms)');
        setTimeout(function () { verify(0); }, 400);
        return;
      }
      if (performance.now() - t0 > 4000) {
        push('WARN 확인시트 미출현 - 1단계 재시도');
        var p = payBtn(); if (p && !p.disabled) p.click();
        t0 = performance.now();
      }
      setTimeout(wait, 40);
    })();
  }
  function verify(n) {
    if (location.href !== H.payHref) return navOk();
    if (n >= 5) { H.state = 'stuck'; push('WARN 결제페이지 이동 실패 - 수동 확인 필요'); return; }
    setTimeout(function () {            // 1초 이상 간격. 연타하면 진행 중 처리가 리셋된다.
      if (location.href !== H.payHref) return navOk();
      var b = payButtons();
      if (b.length) { b[b.length - 1].click(); push('시트 재클릭 #' + (n + 1)); }
      verify(n + 1);
    }, 1200);
  }
  function navOk() {
    H.state = 'paid'; H.finalUrl = location.href;
    mark();
    push('결제페이지 이동 확인: ' + location.href);
  }

  function mark() {
    try {
      localStorage.setItem('__cgvSecured', JSON.stringify({
        seat: H.picked, pay: H.payBtnText, latencyMs: H.latencyMs, at: Date.now()
      }));
    } catch (e) {}
  }
  function teardown() {
    clearInterval(H.scanTimer); clearInterval(H.refTimer);
    if (H.mo) try { H.mo.disconnect(); } catch (e) {}
    H.pending.forEach(clearTimeout); H.pending = [];
  }
  function restart() {
    H.scanTimer = setInterval(scan, CFG.scanMs);
    H.refTimer = setInterval(tick, CFG.refreshMs);
    observe();
  }
  function tick() {
    if (H.state !== 'running') return;
    var b = refreshBtn(); if (b) { b.click(); H.refreshes++; }
    // 새로고침은 관람인원을 매번 초기화하므로 직후에 다시 선택한다
    H.pending.push(setTimeout(ensurePerson, 250), setTimeout(ensurePerson, 600),
                   setTimeout(ensureSeatMap, 900));
  }
  function observe() {
    if (H.mo) try { H.mo.disconnect(); } catch (e) {}   // 재시작 시 옵저버 중복 방지
    var queued = false;
    H.mo = new MutationObserver(function () {
      if (H.state === 'clicking') { closerTick(); return; }   // 동기 처리가 가장 빠르다
      if (queued) return; queued = true;
      requestAnimationFrame(function () { queued = false; if (H.state === 'running') scan(); });
    });
    H.mo.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'disabled', 'aria-pressed']
    });
  }

  // ─────────────────────────── 부팅 ───────────────────────────
  // 좌석 API URL 확보: 설정에 있으면 그걸 쓰고, 없으면 앱이 보내는 요청을 가로채 알아낸다.
  function resolveApi() {
    if (CFG.api) {
      var q = Object.keys(CFG.api).map(function (k) {
        return k + '=' + encodeURIComponent(CFG.api[k]);
      }).join('&');
      return Promise.resolve('/api/v1/booking/searchIfSeatData?' + q);
    }
    return new Promise(function (resolve, reject) {
      var found = null;
      var of = window.fetch;
      window.fetch = function () {
        var u = (arguments[0] && arguments[0].url) ? arguments[0].url : String(arguments[0]);
        if (!found && u.indexOf('searchIfSeatData') > -1) found = u;
        return of.apply(this, arguments);
      };
      var oo = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u) {
        if (!found && String(u).indexOf('searchIfSeatData') > -1) found = String(u);
        return oo.apply(this, arguments);
      };
      function restore() { window.fetch = of; XMLHttpRequest.prototype.open = oo; }

      var b = refreshBtn();
      if (!b) { restore(); return reject(new Error('새로고침 버튼을 찾지 못했다. 예매 페이지가 맞는지 확인하라.')); }
      b.click();
      var t0 = Date.now();
      (function wait() {
        if (found) { restore(); push('좌석 API 자동 탐지 성공'); return resolve(found); }
        if (Date.now() - t0 > 6000) { restore(); return reject(new Error('좌석 API 요청을 잡지 못했다.')); }
        setTimeout(wait, 50);
      })();
    });
  }

  resolveApi()
    .then(function (api) {
      H.api = api;
      return fetch(api, { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); });
    })
    .then(function (j) {
      if (!j || !j.data || !j.data.items || !j.data.items[0]) throw new Error('좌석 API 응답이 예상과 다르다: ' + JSON.stringify(j).slice(0, 160));
      // 열/번호는 DOM 텍스트가 아니라 API 매핑으로 판정한다 (새로고침 후 텍스트가 비는 경우가 있음)
      var seats = j.data.items[0].seats, map = {};
      for (var i = 0; i < seats.length; i++) {
        map[seats[i].seatLocNo] = { row: seats[i].seatRowNm, col: seats[i].seatNo };
      }
      H.rowMap = map; H.rowMapSize = seats.length;

      var all = document.querySelectorAll('[data-seatlocno]'), mn = 1e9, mx = -1e9;
      for (var k = 0; k < all.length; k++) {
        var L = parseInt(all[k].style.left);
        if (!isNaN(L)) { if (L < mn) mn = L; if (L > mx) mx = L; }
      }
      H.midLeft = (mn + mx) / 2;        // 좌석표 중앙 좌표는 고정이므로 1회만 계산

      H.state = 'running';
      push('rowMap ' + seats.length + '석 / 새로고침 ' + CFG.refreshMs + 'ms / 스캔 ' + CFG.scanMs + 'ms');
      restart();
      ensurePerson();
      ensureSeatMap();
      tick();
    })
    .catch(function (e) { H.state = 'error'; H.err = String(e); push('ERROR 부팅 실패: ' + e); });

  return 'hunter installed';
})();
