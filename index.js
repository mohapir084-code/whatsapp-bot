// =======================
// FitMouv WhatsApp Bot – Version stable
// =======================

const express = require('express');
const app = express();
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ===== ENV =====
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'fitmouv_verify_123';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SIO_SECRET = process.env.SIO_SECRET || 'fitmouv_2025_secret_89HGsQ';
const SIO_THANKS_URL = process.env.SIO_THANKS_URL || 'https://pay.fitmouv.fr/8cea436d';
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ===== UTILS =====
function pick(v, fallback = '') {
  if (v === null || v === undefined) return fallback;
  return String(v).trim();
}
function phoneSanitize(p) {
  if (!p) return '';
  let num = p.replace(/\s+/g, '').replace(/[^\d+]/g, '');
  if (num.startsWith('0')) num = `33${num.slice(1)}`;
  if (num.startsWith('+')) num = num.slice(1);
  return num;
}

// ===== ENVOI TEMPLATE =====
async function sendTemplate(to, templateName, components = []) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,         // ex: "fitmouv_welcome_v1"
      language: { code: 'fr' },   // 👈 forcé en "fr"
      components
    }
  };

  try {
    const r = await fetch(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const txt = await r.text();
    if (!r.ok) {
      console.error(`WA POST ERROR ${r.status}`, txt);
      throw new Error(`Meta POST ${PHONE_NUMBER_ID}/messages -> ${r.status}: ${txt}`);
    }
    console.log('✅ Template envoyée avec succès:', txt);
  } catch (e) {
    console.error(`❌ Erreur envoi template "${templateName}":`, e.message);
  }
}

// ===== ENVOI MESSAGE TEXTE SIMPLE =====
async function sendText(to, body) {
  try {
    const r = await fetch(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        text: { body }
      })
    });
    const txt = await r.text();
    console.log('WA Text =>', txt);
  } catch (err) {
    console.error('WA Text error:', err.message);
  }
}

// ===== ROUTES =====

// Vérification webhook META
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook validé avec succès');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Systeme.io → Webhook
app.post('/sio-webhook', async (req, res) => {
  try {
    const secretFromQuery = pick(req.query.secret);
    if (secretFromQuery !== SIO_SECRET) {
      console.warn('❌ Mauvais secret reçu');
      return res.status(200).json({ ok: false, reason: 'bad_secret' });
    }

    const payload = req.body || {};
    console.log('SIO payload:', payload);

    const phone = phoneSanitize(payload.phone || payload.whatsapp || payload.telephone);
    const prenom = pick(payload.first_name || payload.prenom || '👋');

    if (!phone) {
      console.warn('Aucun numéro trouvé');
      return res.json({ ok: true, stored: false, reason: 'no_phone' });
    }

    // ✅ Envoi immédiat de la template de bienvenue
    await sendTemplate(phone, 'fitmouv_welcome_v1');

    console.log(`✅ Template "fitmouv_welcome_v1" envoyée à ${phone}`);

    const acceptsHTML = (req.headers.accept || '').includes('text/html');
    if (acceptsHTML) return res.redirect(302, SIO_THANKS_URL);

    return res.json({ ok: true, sent: true });
  } catch (err) {
    console.error('Erreur /sio-webhook:', err);
    return res.json({ ok: false, error: true });
  }
});

// Healthcheck
app.get('/', (_req, res) => res.send('✅ FitMouv bot opérationnel'));

// ===== START =====
app.listen(PORT, () => console.log(`🚀 Serveur FitMouv lancé sur le port ${PORT}`));
