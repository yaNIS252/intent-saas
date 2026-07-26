require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const HIGH_INTENT_KEYWORDS = [
  'pricing',
  'tarifs',
  'tarif',
  'devis',
  'contact',
  'demo',
  'offres',
  'offre',
  'checkout',
  'subscribe',
  'plan'
];

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

function isHighIntentPage(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  return HIGH_INTENT_KEYWORDS.some((keyword) => lower.includes(keyword));
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

async function sendSlackAlert({ company, location, page, referrer, timestamp, siteId }) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[intent-saas] SLACK_WEBHOOK_URL is not configured — alert skipped');
    return;
  }

  const siteLine = siteId ? `\n🆔 *Site :* ${siteId}` : '';

  const text = [
    '🚨 *Visite entreprise à haute intention détectée*',
    '',
    `🏢 *Entreprise :* ${company}`,
    `📍 *Localisation :* ${location}`,
    `📄 *Page visitée :* ${page}`,
    `🔗 *Referrer :* ${referrer || 'Direct'}`,
    `⏰ *Horodatage :* ${timestamp}${siteLine}`
  ].join('\n');

  await axios.post(
    webhookUrl,
    { text },
    { timeout: 5000, headers: { 'Content-Type': 'application/json' } }
  );
}

app.post('/api/track', async (req, res) => {
  try {
    const { url, referrer, siteId } = req.body || {};

    if (!url) {
      return res.status(400).json({ success: false, error: 'Missing url' });
    }

    if (!isHighIntentPage(url)) {
      console.log(`[intent-saas] Non-strategic page: ${url}`);
      return res.json({ success: true, skipped: 'non_strategic_page' });
    }

    const ip = '8.8.8.8';

    if (isPrivateIp(ip)) {
      console.log(`[intent-saas] Private/local IP skipped: ${ip}`);
      return res.json({ success: true, skipped: 'private_ip' });
    }

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

    const orgString = getOrgString(ipInfo);

    if (isResidentialIsp(orgString)) {
      console.log(`[intent-saas] ISP/residential traffic filtered: ${orgString || ip}`);
      return res.json({ success: true, skipped: 'residential_isp' });
    }

    const company = resolveCompanyName(ipInfo);
    const location = [ipInfo.city, ipInfo.country].filter(Boolean).join(', ') || 'Inconnue';
    const timestamp = formatTimestamp(new Date());

    await sendSlackAlert({
      company,
      location,
      page: url,
      referrer,
      timestamp,
      siteId
    });

    console.log(`[intent-saas] Slack alert sent — ${company} on ${url}${siteId ? ` (site: ${siteId})` : ''}`);
    return res.json({ success: true, alerted: true });
  } catch (err) {
    console.error('[intent-saas] /api/track error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`[intent-saas] Server running on http://localhost:${PORT}`);
});
