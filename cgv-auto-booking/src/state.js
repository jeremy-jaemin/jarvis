/* 핸터 상태를 한 줄 JSON으로 뽑는다. 외부 감시 스크립트가 주기적으로 실행한다. */
(() => {
  var url = location.href, mark = null;
  try { mark = localStorage.getItem('__cgvSecured'); } catch (e) {}
  var H = window.__hunt;
  if (!H) return JSON.stringify({ state: 'MISSING', url: url, mark: mark });
  return JSON.stringify({
    state: H.state, url: url, mark: mark, api: H.api,
    scans: H.scans, refreshes: H.refreshes, personFixes: H.personFixes,
    personOk: H.personOk, attempts: H.attempts, closerTicks: H.closerTicks,
    free: H.lastFree, targetFree: H.lastTargetFree,
    picked: H.picked, latencyMs: H.latencyMs, sheetMs: H.sheetMs,
    payBtnText: H.payBtnText, finalUrl: H.finalUrl, err: H.err,
    log: H.log
  });
})();
