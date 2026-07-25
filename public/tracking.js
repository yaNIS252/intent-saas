(function () {
  'use strict';

  var ENDPOINT = (function () {
    var script = document.currentScript;
    if (script && script.src) {
      try {
        var origin = new URL(script.src).origin;
        return origin + '/api/track';
      } catch (e) {
        /* fallback below */
      }
    }
    return '/api/track';
  })();

  var payload = {
    url: window.location.href,
    referrer: document.referrer || null
  };

  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true
  }).catch(function () {
    /* silent fail – tracking must not break the host page */
  });
})();