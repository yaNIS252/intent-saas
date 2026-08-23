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

    // 1. Récupération de la balise script et extraction du site_id
    var script = document.currentScript
      || document.querySelector('script[data-site-id]')
      || document.querySelector('script[src*="tracker.js"]');

    var siteId = script ? script.getAttribute('data-site-id') : null;

    // VERROU : On marque l'URL comme "en cours" AVANT le fetch
    if (!siteId) {
      // Aucun siteId défini → on abandonne le suivi
      return;
    }
    pendingUrls.add(currentUrl);

    // 2. Détection automatique du domaine de l'API (Localhost ou Render)
    var ENDPOINT = (function () {
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

    // 3. Construction du payload AVEC le siteId
    var payload = {
      url: currentUrl,
      referrer: document.referrer || null,
      siteId: siteId
    };

    // Envoi avec timeout et gestion d'erreurs explicite
    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, 5000); // 5 s

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
      signal: controller.signal
    })
    .then(function(response) {
      if (!response.ok) {
        // Réponse HTTP non‑2xx → on considère comme échec
        throw new Error('HTTP ' + response.status);
      }
      return response.json();
    })
    .then(function(data) {
      // Si l'alerte a bien été envoyée sur Slack, on la mémorise définitivement
      if (data.success && !data.skipped) {
        trackedUrls.add(currentUrl);
      }
    })
    .catch(function(err) {
      // En dev, on loggue l’erreur ; en prod on peut ignorer ou envoyer à un endpoint de logging
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[tracker] Erreur de suivi :', err);
      }
    })
    .finally(function() {
      clearTimeout(timeoutId);
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