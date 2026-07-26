(function () {
  'use strict';

  var script = document.currentScript;

  var ENDPOINT = (function () {
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

  var siteId = script ? script.getAttribute('data-site-id') : null;

  var payload = {
    url: window.location.href,
    referrer: document.referrer || null
  };

  if (siteId) {
    payload.siteId = siteId;
  }

  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true
  }).catch(function () {
    /* silent fail — tracking must not break the host page */
  });
})();
