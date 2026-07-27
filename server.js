require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Initialisation des clients Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; // Anon Key
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Service Role Key (Admin)

if (!supabaseUrl || !supabaseKey) {
  console.error('[intent-saas] Erreur : SUPABASE_URL ou SUPABASE_KEY manquant dans le .env');
}

if (!supabaseServiceKey) {
  console.warn('[intent-saas] Attention : SUPABASE_SERVICE_ROLE_KEY manquante. L\'auto-confirmation d\'inscription échouera.');
}

// Client public / standard
const supabase = createClient(supabaseUrl, supabaseKey);

// Client Admin (Privilèges élevés)
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey || supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Patterns Regex pour filtrer les FAI résidentiels
const ISP_PATTERNS = [
  /orange/i,
  /sfr/i,
  /bouygues/i,
  /free\s*(?:mobile|sas|s\.a\.s|telecom|box)?/i,
  /comcast/i,
  /verizon/i,
  /at\s*&?\s*t/i,
  /t-mobile/i,
  /vodafone/i,
  /telia/i,
  /deutsche\s*telekom/i,
  /telefonica/i,
  /virgin\s*media/i,
  /sky\s*broadband/i,
  /bt\s*(?:group|plc|internet)?/i,
  /charter\s*communications/i,
  /cox\s*communications/i,
  /centurylink/i,
  /lumen/i,
  /spectrum/i,
  /xfinity/i,
  /proximus/i,
  /kpn/i,
  /swisscom/i,
  /telecom\s*italia/i,
  /wind\s*tre/i,
  /iliad/i,
  /numericable/i,
  /altice/i,
  /cablevision/i,
  /optimum/i,
  /frontier\s*communications/i,
  /residential/i,
  /broadband/i,
  /cable\s*(?:vision|company|corp)/i,
  /internet\s*service/i,
  /isp\b/i
];

app.set('trust proxy', true);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// -----------------------------------------------------------------------------
// SÉCURITÉ : RATE LIMITER
// -----------------------------------------------------------------------------
const rateLimitMap = new Map();

/**
 * Limite le nombre de requêtes par IP sur l'endpoint de tracking
 * (100 requêtes max par tranche de 15 minutes par IP)
 */
function trackingRateLimiter(req, res, next) {
  const ip = extractClientIp(req);
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxRequests = 100;

  const record = rateLimitMap.get(ip) || { count: 0, resetTime: now + windowMs };

  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + windowMs;
  } else {
    record.count += 1;
  }

  rateLimitMap.set(ip, record);

  if (record.count > maxRequests) {
    console.warn(`[intent-saas] Rate limit dépassé pour l'IP : ${ip}`);
    return res.status(429).json({ success: false, error: 'Too many requests' });
  }

  next();
}

/**
 * Analyse si l'URL contient un des mots-clés configurés par LE CLIENT
 */
function isHighIntentPage(url, keywords) {
  if (!url || typeof url !== 'string') return false;
  if (!keywords || !Array.isArray(keywords)) return false;

  const lower = url.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

function extractClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }

  const realIp = req.headers['x-real-ip'];
  if (realIp) return realIp.trim();

  const remote = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  return remote.replace(/^::ffff:/, '');
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^fc00:/i.test(ip) || /^fd/i.test(ip) || /^fe80:/i.test(ip)) return true;
  return false;
}

function resolveCompanyName(ipInfo) {
  if (ipInfo.company?.name) return ipInfo.company.name;
  if (ipInfo.org) return ipInfo.org.replace(/^AS\d+\s+/i, '').trim() || ipInfo.org;
  return 'Entreprise inconnue';
}

function getOrgString(ipInfo) {
  return [ipInfo.org, ipInfo.company?.name, ipInfo.asn?.name]
    .filter(Boolean)
    .join(' ');
}

function isResidentialIsp(orgString) {
  if (!orgString) return true;
  return ISP_PATTERNS.some((pattern) => pattern.test(orgString));
}

function formatTimestamp(date) {
  return date.toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris',
    dateStyle: 'short',
    timeStyle: 'medium'
  });
}

async function lookupIpInfo(ip) {
  const token = process.env.IPINFO_TOKEN;
  if (!token) {
    console.error('[intent-saas] IPINFO_TOKEN is not configured');
    return null;
  }

  const response = await axios.get(`https://ipinfo.io/${ip}`, {
    params: { token },
    timeout: 5000
  });

  return response.data;
}

/**
 * Envoie l'alerte sur le Webhook Slack spécifique du client
 */
async function sendSlackAlert({ company, location, page, referrer, timestamp, clientName, webhookUrl }) {
  if (!webhookUrl) {
    console.warn('[intent-saas] Webhook Slack non configuré pour ce client — alerte ignorée');
    return;
  }

  const text = [
    `🚨 *Visite entreprise détectée pour : ${clientName}*`,
    '',
    `🏢 *Entreprise :* ${company}`,
    `📍 *Localisation :* ${location}`,
    `📄 *Page visitée :* ${page}`,
    `🔗 *Referrer :* ${referrer || 'Direct'}`,
    `⏰ *Horodatage :* ${timestamp}`
  ].join('\n');

  await axios.post(
    webhookUrl,
    { text },
    { timeout: 5000, headers: { 'Content-Type': 'application/json' } }
  );
}

// -----------------------------------------------------------------------------
// AUTHENTICATION MIDDLEWARE
// -----------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.substring(7);
  supabase.auth.getUser(token)
    .then(({ data: { user }, error }) => {
      if (error || !user) {
        return res.status(401).json({ success: false, error: 'Invalid token' });
      }
      req.user = user;
      next();
    })
    .catch(err => {
      return res.status(500).json({ success: false, error: 'Authentication error' });
    });
}

// -----------------------------------------------------------------------------
// ROUTES D'AUTHENTIFICATION & DASHBOARD
// -----------------------------------------------------------------------------

/**
 * Inscription auto-confirmée (Bypass des quotas SMTP Supabase)
 */
app.post('/api/signup', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'E-mail et mot de passe requis.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Le mot de passe doit faire au moins 6 caractères.' });
    }

    // Création directe de l'utilisateur avec email_confirm = true
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });

    if (error) {
      console.error('[intent-saas] Erreur de création utilisateur:', error.message);
      return res.status(400).json({ success: false, error: error.message });
    }

    console.log(`[intent-saas] Utilisateur créé et auto-confirmé : ${email}`);
    return res.json({ success: true, user: data.user });

  } catch (err) {
    console.error('[intent-saas] /api/signup error:', err.message);
    return res.status(500).json({ success: false, error: 'Erreur interne du serveur.' });
  }
});

/**
 * Récupération de la configuration du client (protégé)
 */
app.get('/api/client/me', requireAuth, async (req, res) => {
  try {
    const { data: client, error } = await supabase
      .from('clients')
      .select('*')
      .eq('user_id', req.user.id)
      .single();

    if (error || !client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    res.json({ success: true, client });
  } catch (err) {
    console.error('[intent-saas] /api/client/me error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Mise à jour de la configuration du client (protégé)
 */
app.post('/api/client/config', requireAuth, express.json(), async (req, res) => {
  try {
    const { intent_keywords, slack_webhook_url } = req.body;
    if (intent_keywords === undefined && slack_webhook_url === undefined) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }
    const updateObj = {};
    if (intent_keywords !== undefined) updateObj.intent_keywords = intent_keywords;
    if (slack_webhook_url !== undefined) updateObj.slack_webhook_url = slack_webhook_url;

    const { data: client, error } = await supabase
      .from('clients')
      .update(updateObj)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    res.json({ success: true, client });
  } catch (err) {
    console.error('[intent-saas] /api/client/config error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Récupération de l'historique des leads pour l'utilisateur authentifié (protégé)
 */
app.get('/api/leads', requireAuth, async (req, res) => {
  try {
    // Find client for this user
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, site_id')
      .eq('user_id', req.user.id)
      .single();

    if (clientError || !client) {
      return res.status(404).json({ success: false, error: 'Client not found for user' });
    }

    const { data: leads, error: leadsError } = await supabase
      .from('leads')
      .select('*')
      .eq('client_id', client.id)
      .order('created_at', { ascending: false });

    if (leadsError) {
      console.error('[intent-saas] Erreur de lecture des leads:', leadsError.message);
      return res.status(500).json({ success: false, error: 'Erreur lors de la récupération des leads.' });
    }

    res.json({
      success: true,
      count: leads.length,
      leads: leads
    });
  } catch (err) {
    console.error('[intent-saas] /api/leads error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// -----------------------------------------------------------------------------
// ROUTE PRINCIPALE DE TRACKING
// -----------------------------------------------------------------------------
app.post('/api/track', trackingRateLimiter, async (req, res) => {
  try {
    const { url, referrer, siteId } = req.body || {};

    if (!url) {
      return res.status(400).json({ success: false, error: 'Missing url' });
    }

    // 1. Récupération du site_id
    const targetSiteId = siteId || 'cli_test_123';

    // 2. Requête Supabase pour récupérer le profil du client
    const { data: client, error: dbError } = await supabase
      .from('clients')
      .select('*')
      .eq('site_id', targetSiteId)
      .single();

    if (dbError || !client) {
      console.warn(`[intent-saas] Client introuvable pour site_id : ${targetSiteId}`);
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    // 3. Vérification des mots-clés stratégiques PROPRES AU CLIENT
    if (!isHighIntentPage(url, client.intent_keywords)) {
      console.log(`[intent-saas] Non-strategic page for ${client.name}: ${url}`);
      return res.json({ success: true, skipped: 'non_strategic_page' });
    }

    // 4. Détection de l'IP (Dynamique : '8.8.8.8' en dev local, vraie IP en prod)
    const isDev = process.env.NODE_ENV !== 'production';
    const ip = isDev ? '8.8.8.8' : extractClientIp(req);

    console.log(`[intent-saas] IP détectée (${isDev ? 'DEV' : 'PROD'}) : ${ip}`);

    if (isPrivateIp(ip)) {
      console.log(`[intent-saas] Private/local IP skipped: ${ip}`);
      return res.json({ success: true, skipped: 'private_ip' });
    }

    // 5. Lookup IPinfo
    let ipInfo;
    try {
      ipInfo = await lookupIpInfo(ip);
    } catch (err) {
      console.error('[intent-saas] IPinfo lookup failed:', err.message);
      return res.json({ success: true, skipped: 'ip_lookup_failed' });
    }

    if (!ipInfo) {
      return res.json({ success: true, skipped: 'ip_lookup_failed' });
    }

    // 6. Filtrage FAI / Résidentiel
    const orgString = getOrgString(ipInfo);

    if (isResidentialIsp(orgString)) {
      console.log(`[intent-saas] ISP/residential traffic filtered: ${orgString || ip}`);
      return res.json({ success: true, skipped: 'residential_isp' });
    }

    // 7. Formatage et enregistrement du lead
    const company = resolveCompanyName(ipInfo);
    const location = [ipInfo.city, ipInfo.country].filter(Boolean).join(', ') || 'Inconnue';
    const timestamp = formatTimestamp(new Date());

    // SAUVEGARDE BDD : Insertion dans la table 'leads'
    const { error: leadError } = await supabaseAdmin
      .from('leads')
      .insert({
        client_id: client.id,
        company_name: company,
        location: location,
        page_url: url,
        referrer: referrer || null,
        ip_address: ip
      });

    if (leadError) {
      console.error('[intent-saas] Erreur enregistrement lead BDD:', leadError.message);
    }

    // 8. Envoi de l'alerte Slack
    await sendSlackAlert({
      company,
      location,
      page: url,
      referrer,
      timestamp,
      clientName: client.name,
      webhookUrl: client.slack_webhook_url
    });

    console.log(`[intent-saas] Lead sauvegardé & Alerte Slack envoyée pour "${client.name}" — ${company}`);
    return res.json({ success: true, alerted: true });

  } catch (err) {
    console.error('[intent-saas] /api/track error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`[intent-saas] Server running on http://localhost:${PORT}`);
});