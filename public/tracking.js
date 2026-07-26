(function () {
  'use strict';

  var trackedUrls = new Set();
  var pendingUrls = new Set(); // Verrou immédiat pour éviter les doublons simultanés

  function triggerTracking() {
    var currentUrl = window.location.href;

    // Si l'URL a déjà été notifiée OU est en cours d'envoi, on bloque immédiatement
    if (trackedUrls.has(currentUrl) || pendingUrls.has(currentUrl)) {
      return;
    }

    // VERROU : On marque l'URL comme "en cours" AVANT le fetch
    pendingUrls.add(currentUrl);

    // Détection automatique du domaine de l'API Render
    var ENDPOINT = (function () {
      var script = document.currentScript || document.querySelector('script[src*="tracking.js"]');
      if (script && script.src) {
        try {
          var origin = new URL(script.src).origin;
          return origin + '/api/track';
        } catch (e) {
          /* fallback */
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
      // Si l'alerte a bien été envoyée sur Slack, on la mémorise définitivement
      if (data.success && !data.skipped) {
        trackedUrls.add(currentUrl);
      }
    })
    .catch(function () {
      /* silent fail */
    })
    .finally(function() {
      // Déverrouillage de la requête en cours
      pendingUrls.delete(currentUrl);
    });
  }

  // 1. Exécution au chargement initial
  triggerTracking();

  // 2. Écoute des changements d'ancres (#tarif) et de routes SPA
  window.addEventListener('hashchange', triggerTracking);
  window.addEventListener('popstate', triggerTracking);
})();