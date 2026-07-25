require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const STRATEGIC_KEYWORDS = ['pricing', 'tarifs', 'demo', 'contact'];

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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

function getOrgString(ipInfo) {
  return [ipInfo.org, ipInfo.company, ipInfo.asn?.name]
    .filter(Boolean)
    .join(' ');
}

function isResidentialIsp(orgString) {
  if (!orgString) return true;
  return ISP_PATTERNS.some((pattern) => pattern.test(orgString));
}

function isStrategicPage(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return STRATEGIC_KEYWORDS.some((keyword) => lower.includes(keyword));
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
    throw new Error('IPINFO_TOKEN is not configured');
  }

  const response = await axios.get(`https://ipinfo.io/${ip}`, {
    params: { token },
    timeout: 5000
  });

  return response.data;
}

async function sendSlackAlert({ company, page, city, country, timestamp, referrer }) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[intent-saas] SLACK_WEBHOOK_URL is not configured — alert skipped');
    return;
  }

  const location = [city, country].filter(Boolean).join(', ') || 'Inconnu';
  const referrerLine = referrer ? `\n🔗 *Referrer :* ${referrer}` : '';

  const text = [
    '🚨 *Visite entreprise détectée*',
    '',
    `🏢 *Entreprise :* ${company}`,
    `📍 *Page :* ${page}`,
    `🌐 *Localisation :* ${location}`,
    `⏰ *Horodatage :* ${timestamp}${referrerLine}`
  ].join('\n');

  await axios.post(
    webhookUrl,
    { text },
    { timeout: 5000, headers: { 'Content-Type': 'application/json' } }
  );
}

app.post('/api/track', async (req, res) => {
  try {
    const { url, referrer } = req.body || {};

    if (!url) {
      return res.status(400).json({ success: false, error: 'Missing url' });
    }

    const ip = extractClientIp(req);

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

    const orgString = getOrgString(ipInfo);

    if (isResidentialIsp(orgString)) {
      console.log(`[intent-saas] ISP/residential traffic filtered: ${orgString || ip}`);
      return res.json({ success: true, skipped: 'residential_isp' });
    }

    if (!isStrategicPage(url)) {
      console.log(`[intent-saas] Non-strategic page: ${url}`);
      return res.json({ success: true, skipped: 'non_strategic_page' });
    }

    const company = orgString || ipInfo.org || 'Entreprise inconnue';
    const city = ipInfo.city || null;
    const country = ipInfo.country || null;
    const timestamp = formatTimestamp(new Date());

    await sendSlackAlert({
      company,
      page: url,
      city,
      country,
      timestamp,
      referrer
    });

    console.log(`[intent-saas] Slack alert sent for ${company} on ${url}`);
    return res.json({ success: true, alerted: true });
  } catch (err) {
    console.error('[intent-saas] /api/track error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`[intent-saas] Server running on http://localhost:${PORT}`);
});
