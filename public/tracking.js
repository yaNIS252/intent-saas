(function () {
  'use strict';

  // Ensemble (Set) pour mémoriser les URLs déjà envoyées durant cette session
  // Évite de spamer Slack si l'utilisateur va et vient sur #tarif
  var trackedUrls = new Set();

  function triggerTracking() {
    var currentUrl = window.location.href;

    // Si cette URL exacte (#tarif) a déjà été validée dans cette session, on s'arrête
    if (trackedUrls.has(currentUrl)) {
      return;
    }

    // Détection automatique du domaine de ton API Render
    var ENDPOINT = (function () {
      var script = document.currentScript || document.querySelector('script[src*="tracking.js"]');
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
      url: currentUrl,
      referrer: document.referrer || null
    };

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true
    })
    .then(function(response) {
      return response.json();
    })
    .then(function(data) {
      // Si le serveur a accepté l'URL et envoyé la notif, on la stocke dans notre Set
      if (data.success && !data.skipped) {
        trackedUrls.add(currentUrl);
      }
    })
    .catch(function () {
      /* silent fail – ne doit jamais faire crasher le site hôte */
    });
  }

  // 1. Exécution au chargement initial de la page
  triggerTracking();

  // 2. Écoute les changements d'ancre dans l'URL (#tarif, #contact, etc.)
  window.addEventListener('hashchange', triggerTracking);

  // 3. Écoute les changements d'URL via l'API History (Webflow, React, Next.js)
  window.addEventListener('popstate', triggerTracking);
})();