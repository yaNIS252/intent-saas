require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Activer la confiance proxy pour gérer proprement req.ip derrière un proxy (Railway, Render, Nginx, etc.)
app.set('trust proxy', true);

app.use(cors());
app.use(express.json());

// ==========================================
// 1. Initialisation unique des variables & Supabase
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; // Anon Key
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Service Role Key (Admin)

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ ERREUR: SUPABASE_URL et SUPABASE_KEY doivent être définis dans le fichier .env');
  process.exit(1);
}

// Client Supabase Standard (Public)
const supabase = createClient(supabaseUrl, supabaseKey);

// Client Supabase Admin (Bypass RLS pour la déduplication et l'écriture des leads)
const supabaseAdmin = createClient(
  supabaseUrl,
  supabaseServiceKey || supabaseKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// ==========================================
// 2. Caches en mémoire & Nettoyage automatique
// ==========================================
const ipInfoCache = new Map();
const rateLimitMap = new Map();

// Nettoyage joint de la mémoire toutes les 5 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  
  // Nettoyage du Rate Limit (entrées de plus de 1 minute)
  for (const [ip, data] of rateLimitMap.entries()) {
    if (now - data.firstRequest > 60 * 1000) {
      rateLimitMap.delete(ip);
    }
  }

  // Nettoyage du cache IPInfo (entrées de plus de 24 heures)
  for (const [ip, entry] of ipInfoCache.entries()) {
    if (now - entry.timestamp > 24 * 60 * 60 * 1000) {
      ipInfoCache.delete(ip);
    }
  }
}, CLEANUP_INTERVAL);

// ==========================================
// 3. Fonctions Utilitaires
// ==========================================

// Détection des adresses IP privées / locales (localhost, sous-réseaux privés)
function isPrivateIp(ip) {
  if (!ip) return true;
  const cleanIp = ip.replace(/^::ffff:/, '');
  return (
    cleanIp === '127.0.0.1' ||
    cleanIp === '::1' ||
    cleanIp.startsWith('10.') ||
    cleanIp.startsWith('192.168.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(cleanIp)
  );
}

// Service d'enrichissement IP via IPInfo (avec cache)
async function getIpData(ip) {
  if (ipInfoCache.has(ip)) {
    return ipInfoCache.get(ip).data;
  }

  const token = process.env.IPINFO_TOKEN;
  if (!token) {
    return { ip, org: 'Inconnu', city: 'Inconnu', country: 'Inconnu' };
  }

  try {
    const response = await fetch(`https://ipinfo.io/${ip}?token=${token}`);
    if (!response.ok) throw new Error(`Erreur IPInfo: ${response.statusText}`);
    const data = await response.json();
    
    ipInfoCache.set(ip, { data, timestamp: Date.now() });
    return data;
  } catch (error) {
    console.error(`[IPInfo Error] Échec de l'enrichissement pour l'IP ${ip}:`, error.message);
    return { ip, org: 'Inconnu', city: 'Inconnu', country: 'Inconnu' };
  }
}

// Notification Slack
async function sendSlackNotification(webhookUrl, payload) {
  if (!webhookUrl) return;

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error(`[Slack Error] Échec de l'envoi (${response.status}):`, await response.text());
    }
  } catch (error) {
    console.error('[Slack Error] Erreur réseau lors de l\'envoi Slack:', error.message);
  }
}

// ==========================================
// 4. Route API de Tracking (/api/track)
// ==========================================
app.post('/api/track', async (req, res) => {
  try {
    const { url, siteId, site_id } = req.body;
    const targetSiteId = siteId || site_id;

    if (!url || !targetSiteId) {
      return res.status(400).json({ success: false, error: 'Paramètres "url" et "siteId" requis' });
    }

    // Récupération sécurisée de l'IP
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Filtre des adresses IP locales/privées
    if (isPrivateIp(ip)) {
      return res.json({ success: true, skipped: 'private_ip' });
    }

    // Rate Limiting : max 30 requêtes par minute par IP
    const now = Date.now();
    const limitWindow = 60 * 1000;
    const maxRequests = 30;

    let rateData = rateLimitMap.get(ip);
    if (!rateData || now - rateData.firstRequest > limitWindow) {
      rateData = { count: 1, firstRequest: now };
    } else {
      rateData.count += 1;
    }
    rateLimitMap.set(ip, rateData);

    if (rateData.count > maxRequests) {
      return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
    }

    // Récupération de la configuration client dans Supabase
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('*')
      .eq('site_id', targetSiteId)
      .single();

    if (clientError || !client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    // Vérification des mots-clés d'intention (page stratégique)
    const keywords = Array.isArray(client.intent_keywords)
      ? client.intent_keywords
      : (client.intent_keywords || 'pricing,devis,tarifs,contact').split(',').map(k => k.trim());

    const isStrategicPage = keywords.some(kw => kw && url.toLowerCase().includes(kw.toLowerCase()));

    if (!isStrategicPage) {
      return res.json({ success: true, skipped: 'non_strategic_page' });
    }

    // Déduplication (Contrôle des doublons sur les dernières 24h via supabaseAdmin)
    try {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: existingLeads, error: dedupError } = await supabaseAdmin
        .from('leads')
        .select('id')
        .eq('client_id', client.id)
        .eq('ip_address', ip)
        .gte('created_at', twentyFourHoursAgo);

      if (dedupError) {
        console.error('[Dedup Check Error]', dedupError.message);
        return res.status(500).json({ success: false, error: 'Dedup check failed' });
      }

      if (existingLeads && existingLeads.length > 0) {
        return res.json({ success: true, skipped: 'duplicate_lead' });
      }
    } catch (err) {
      console.error('[Dedup Exception]', err.message);
      return res.status(500).json({ success: false, error: 'Dedup check failed' });
    }

    // Enrichissement des données de l'IP
    const ipData = await getIpData(ip);

    // Construction et enregistrement du Lead dans Supabase
    const leadPayload = {
      client_id: client.id,
      site_id: targetSiteId,
      ip_address: ip,
      url_visited: url,
      company_name: ipData.org || (ipData.company && ipData.company.name) || 'Inconnu',
      city: ipData.city || 'Inconnu',
      country: ipData.country || 'Inconnu',
      created_at: new Date().toISOString()
    };

    const { data: insertedLead, error: insertError } = await supabaseAdmin
      .from('leads')
      .insert([leadPayload])
      .select()
      .single();

    if (insertError) {
      console.error('[Supabase Insert Error]', insertError.message);
    }

    // Envoi de l'alerte Slack si un Webhook est configuré pour ce client
    if (client.slack_webhook_url) {
      const slackMessage = {
        text: `🎯 *Nouveau Lead d'Intention Détecté !*`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `🎯 *Nouveau Lead d'Intention Détecté !*\n*Entreprise :* ${leadPayload.company_name}\n*Page visitée :* ${url}\n*Localisation :* ${leadPayload.city}, ${leadPayload.country}\n*IP :* \`${ip}\``
            }
          }
        ]
      };

      await sendSlackNotification(client.slack_webhook_url, slackMessage);
    }

    return res.json({ success: true, alerted: true, lead: insertedLead || leadPayload });

  } catch (error) {
    console.error('[Server Internal Error]', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ==========================================
// 5. Démarrage du serveur & Graceful Shutdown
// ==========================================
const server = app.listen(PORT, () => {
  console.log(`🚀 Serveur Intent-SaaS démarré sur le port ${PORT}`);
});

function shutdownGracefully(signal) {
  console.log(`\n[${signal}] Fermeture propre du serveur...`);
  clearInterval(cleanupTimer);
  server.close(() => {
    console.log('👋 Serveur arrêté proprement.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT', () => shutdownGracefully('SIGINT'));