// =======================
// FitMouv WhatsApp Bot (index.js)
// =======================

// 1) BOOT EXPRESS EN PREMIER
const express = require('express');
const app = express();

// Parsers
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// 2) IMPORTS & HELPERS
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// 3) ENV
const ACCESS_TOKEN       = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID    = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN       = process.env.VERIFY_TOKEN || 'fitmouv_verify_123';
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;
const SIO_ALLOWED_ORIGIN = process.env.SIO_ALLOWED_ORIGIN || 'https://pay.fitmouv.fr';
const SIO_SECRET         = process.env.SIO_SECRET || 'fitmouv_2025_secret_89HGsQ';
const SIO_THANKS_URL     = process.env.SIO_THANKS_URL || 'https://pay.fitmouv.fr/8cea436d';
const WELCOME_TEMPLATE_NAME = process.env.WELCOME_TEMPLATE_NAME || 'fitmouv_welcome';
const WELCOME_TEMPLATE_LANG = process.env.WELCOME_TEMPLATE_LANG || 'fr';

const PORT                   = process.env.PORT || 10000;
const DELAY_MIN_SEC          = Number(process.env.DELAY_MIN_SEC || 60);
const DELAY_MAX_SEC          = Number(process.env.DELAY_MAX_SEC || 240);
const PROGRAM_DELAY_MIN_MIN  = Number(process.env.PROGRAM_DELAY_MIN_MIN || 1200);
const PROGRAM_DELAY_MAX_MIN  = Number(process.env.PROGRAM_DELAY_MAX_MIN || 1380);

// 4) CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || origin === SIO_ALLOWED_ORIGIN) res.setHeader('Access-Control-Allow-Origin', SIO_ALLOWED_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 5) STOCKAGE LÉGER + MÉMOIRE
const contacts = new Map();
const DATA_DIR = path.join('/tmp');
const CLIENTS_PATH = path.join(DATA_DIR, 'clients.json');

function readClients() {
  try {
    if (!fs.existsSync(CLIENTS_PATH)) return {};
    const raw = fs.readFileSync(CLIENTS_PATH, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (e) { console.error('readClients error:', e); return {}; }
}
function writeClients(db) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CLIENTS_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) { console.error('writeClients error:', e); }
}

// 6) UTILS
function pick(v, fallback = '') { return v ? String(v).trim() : fallback; }
function phoneSanitize(p) { return pick(p).replace(/\s+/g, ''); }
function toWaIdFromFR(phoneRaw) {
  const digits = (phoneRaw || '').replace(/\D/g, '');
  if (!digits) return ''; if (digits.startsWith('33')) return digits;
  return `33${digits.replace(/^0/, '')}`;
}
function randDelayMs() {
  const sec = Math.floor(Math.random() * (DELAY_MAX_SEC - DELAY_MIN_SEC + 1)) + DELAY_MIN_SEC;
  return sec * 1000;
}
function randProgramDelayMs() {
  const m = Math.floor(Math.random() * (PROGRAM_DELAY_MAX_MIN - PROGRAM_DELAY_MIN_MIN + 1)) + PROGRAM_DELAY_MIN_MIN;
  return m * 60 * 1000;
}
function stripMarkdown(s) {
  return (s || '').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1')
  .replace(/_(.*?)_/g, '$1').replace(/`{1,3}([\s\S]*?)`{1,3}/g, '$1').replace(/~{2}(.*?)~{2}/g, '$1');
}
// ===============
// 7) WHATSAPP API HELPERS
// ===============
async function waPost(path, payload) {
  const url = `https://graph.facebook.com/v24.0/${path}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const txt = await r.text();
  if (!r.ok) {
    console.error('WA POST ERROR', r.status, txt);
    throw new Error(`Meta POST ${path} -> ${r.status}: ${txt}`);
  }
  try { return JSON.parse(txt); } catch { return txt; }
}

async function sendText(to, body) {
  // pas de gras/étoiles : on nettoie
  const clean = stripMarkdown(body);
  return waPost(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: clean, preview_url: false }
  });
}

async function sendImage(to, link, caption = '') {
  const clean = stripMarkdown(caption);
  return waPost(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { link, caption: clean }
  });
}

async function markAsRead(waId, msgId) {
  if (!msgId) return;
  try {
    await waPost(`${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: msgId,
      to: waId,
    });
  } catch (e) { console.error('markAsRead:', e.message); }
}

/**
 * Envoi d'un message template avec cascade de langues.
 * On essaie successivement: WELCOME_TEMPLATE_LANG (env), 'fr', 'fr_FR', 'french'
 * components: tableau de composants (header/body/button variables si besoin)
 */
// ==========================
// Envoi d'un template WhatsApp
// ==========================
async function sendTemplate(to, templateName, components = [], langPref = 'fr') {
  const candidates = [langPref, 'fr', 'fr_FR', 'french']; // <== bien défini ici
  let lastErr = null;

  for (const code of candidates) {
    try {
      const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code },
          components
        }
      };

      const res = await waPost(`${PHONE_NUMBER_ID}/messages`, payload);
      console.log(`✅ Template "${templateName}" envoyé à ${to} avec la langue "${code}"`);
      return res;
    } catch (e) {
      console.error(`❌ Échec template "${templateName}" (${to}) avec code "${code}": ${e.message}`);
      lastErr = e;
      continue;
    }
  }

  console.error(`❌ Erreur envoi template accueil: ${lastErr.message}`);
  throw lastErr;
}
// Heuristique "fenêtre ouverte" côté bot (approximation locale):
// - si dernier message UTILISATEUR < 23h -> on considère OPEN
// - sinon CLOSED (alors on utilise template)
function isSessionOpen(waId) {
  const c = contacts.get(waId);
  if (!c || !c.history || c.history.length === 0) return false;
  const lastUser = [...c.history].reverse().find(h => h.role === 'user');
  if (!lastUser) return false;
  const ageMs = Date.now() - (lastUser.at || 0);
  return ageMs < 23 * 60 * 60 * 1000; // ~23h
}

// ===============
// 8) OPENAI HELPERS
// ===============
async function openaiChat(messages, temperature = 0.7) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY manquant');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages, temperature })
  });
  if (!r.ok) throw new Error(`OpenAI chat ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return stripMarkdown(data.choices?.[0]?.message?.content ?? '');
}

async function transcribeAudio(fileBuffer, filename = 'audio.ogg') {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY manquant');
  const form = new FormData();
  form.append('file', fileBuffer, { filename, contentType: 'audio/ogg' });
  form.append('model', 'whisper-1');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: form
  });
  if (!r.ok) throw new Error(`OpenAI transcribe ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return (data.text || '').trim();
}

// ===============
// 9) GÉNÉRATION PROGRAMMES (sans gras/étoiles)
// ===============
async function generatePrograms(profile, userRequestText) {
  const sys = [
    "Tu es FitMouv, coach SPORT + NUTRITION. Français. Ton chill, clair, bienveillant.",
    "Structure simple, sans mise en gras Markdown, sans emoji si non nécessaire.",
    "Tiens compte de: âge/sexe/poids/objectif/temps dispo/lieu/matériel/diet/allergies/dislikes.",
    "Objectif: plan réaliste, tenable, axé adhérence.",
    "Réponses courtes et actionnables."
  ].join('\n');

  const longSummary = profile._summary || '';
  const user = `
Résumé client (mémoire longue):
${longSummary || '(pas de résumé long pour le moment)'}

Profil SIO:
${JSON.stringify(profile, null, 2)}

Demande: "${userRequestText || 'Prépare un programme complet.'}"

Donne en sortie:
1) Objectif & approche (2-4 lignes)
2) Nutrition (plan 15 jours): détail J1-J3 + logique de rotation (quantités indicatives).
3) Sport (plan 15 jours): 3 jours-type détaillés (5-6 exos/jour: échauffement, force, cardio/HIIT, core, mobilité).
4) Conseils d’adhérence (3-5 points).
  `.trim();

  const raw = await openaiChat([
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ]);
  return stripMarkdown(raw);
}

// ===============
// 10) RÉSUMÉ LONG PONCTUEL
// ===============
async function updateLongSummary(waId) {
  const c = contacts.get(waId);
  if (!c || !c.history) return;
  if ((c.history.length || 0) % 12 !== 0) return;

  const transcript = c.history.map(h => `${h.role.toUpperCase()}: ${h.text}`).join('\n');
  const prompt = `Tu es un assistant qui résume une conversation client-coach FitMouv. Fais un résumé persistant très compact et utile.`;

  const summary = await openaiChat([
    { role: 'system', content: prompt },
    { role: 'user', content: transcript.slice(-6000) }
  ], 0.3);

  contacts.set(waId, { ...c, summary });
}
// ===============
// 11) SCHEDULER (envoi programme + visuels)
// ===============
const EXOS_MEDIA = {
  pushups: "https://i.imgur.com/0hYhD6j.gif",
  squats:  "https://i.imgur.com/7q5E2iB.gif",
  plank:   "https://i.imgur.com/zV7rpxd.gif",
};

setInterval(async () => {
  const now = Date.now();
  for (const [waId, c] of contacts) {
    if (!c.programSent && c.programScheduledAt && c.programScheduledAt <= now) {
      try {
        const profile = { ...(c.sioProfile || {}), _summary: c.summary || '' };
        const baseText = await generatePrograms(profile, "Prépare le programme sport + nutrition personnalisé.");

        const delayBeforeSend = randDelayMs();
        await new Promise(r => setTimeout(r, delayBeforeSend));

        // si la fenêtre est ouverte → message texte
        if (isSessionOpen(waId)) {
          await sendText(waId, `Voici ton programme personnalisé (sport + nutrition):\n\n${baseText}`);
          await sendImage(waId, EXOS_MEDIA.pushups, "Pompes – exécution");
          await sendImage(waId, EXOS_MEDIA.squats,  "Squats – exécution");
          await sendImage(waId, EXOS_MEDIA.plank,   "Planche – gainage");
        } else {
          // sinon template de reprise
          await sendTemplate(waId, 'fitmouv_reprise');
        }

        contacts.set(waId, { ...c, programSent: true });
      } catch (e) {
        console.error('Scheduler send error:', e.message);
      }
    }
  }
}, 60 * 1000);

// ===============
// 12) ROUTES API
// ===============

// Healthcheck
app.get('/', (_req, res) => res.send('✅ FitMouv webhook opérationnel'));

// Vérification Webhook Meta (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ---- Systeme.io → Webhook principal
app.post('/sio-webhook', async (req, res) => {
  try {
    const secret = pick(req.query.secret);
    if (secret !== SIO_SECRET) return res.status(200).json({ ok: false, reason: 'bad_secret' });

    const p = Object.keys(req.body || {}).length ? req.body : {};
    console.log('📥 SIO payload reçu:', p);

    const lead = {
      source: 'systeme.io',
      createdAt: new Date().toISOString(),
      email:     pick(p.email || p.user_email),
      phone:     phoneSanitize(p.phone || p.telephone || p.whatsapp || p.phone_number || p.mobile),
      firstName: pick(p.first_name || p.prenom || p.firstname),
      lastName:  pick(p.last_name || p.nom || p.lastname),
      objectif:  pick(p.objectif),
      niveau:    pick(p.niveau || p.level),
      sexe:      pick(p.sexe || p.gender),
      age:       pick(p.age),
      poids:     pick(p.poids || p.weight),
      taille:    pick(p.taille || p.height),
      disponibilites: pick(p.disponibilites || p.creneaux),
      materiel:  pick(p.materiel || p.equipment),
      patho:     pick(p.pathologies || p.patho),
      preferences: pick(p.preferences || p.aliments_pref),
    };

    // normalise FR
    if (lead.phone && /^0[1-9]\d{8}$/.test(lead.phone)) {
      lead.phone = toWaIdFromFR(lead.phone);
    }

    if (!lead.phone) return res.json({ ok: true, stored: false, reason: 'no_phone' });

    // stockage
    const db = readClients();
    db[lead.phone] = { ...(db[lead.phone] || {}), ...lead };
    writeClients(db);

    // 1️⃣ Envoi template d’accueil (fenêtre fermée)
    try {
      await sendTemplate(
        lead.phone,
        WELCOME_TEMPLATE_NAME,
        [{ type: 'body', parameters: [{ type: 'text', text: lead.firstName || '' }] }]
      );
    } catch (e) {
      console.error('❌ Erreur envoi template accueil:', e.message);
    }

    // 2️⃣ planifie le programme J+20–23h
    const waId = lead.phone;
    const prev = contacts.get(waId) || {};
    contacts.set(waId, {
      ...prev,
      sioProfile: lead,
      history: prev.history || [],
      summary: prev.summary || '',
      programScheduledAt: Date.now() + randProgramDelayMs(),
      programSent: false,
      _welcomed: true
    });

    const acceptsHTML = (req.headers.accept || '').includes('text/html');
    if (acceptsHTML) return res.redirect(302, SIO_THANKS_URL);
    return res.json({ ok: true, stored: true });
  } catch (e) {
    console.error('Erreur /sio-webhook:', e);
    return res.json({ ok: true, stored: false, error: true });
  }
});

// ---- Webhook WhatsApp (réception messages utilisateurs)
app.post('/webhook', async (req, res) => {
  try {
    res.sendStatus(200);
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const waId = msg.from;
    const msgId = msg.id;
    const type = msg.type;

    let c = contacts.get(waId) || { history: [] };
    contacts.set(waId, c);
    await markAsRead(waId, msgId);

    // ---- contenu utilisateur
    let userText = '';
    if (type === 'text') userText = msg.text.body.trim();
    else if (type === 'audio') {
      try {
        const buf = await downloadWhatsAppMedia(msg.audio.id);
        userText = await transcribeAudio(buf, 'voice.ogg');
      } catch { await sendText(waId, "Je n’ai pas réussi à comprendre ton vocal 😅"); return; }
    } else { await sendText(waId, "Dis-moi en texte ce que tu veux qu’on prépare 💬"); return; }

    // ---- maj historique
    c.history.push({ role: 'user', text: userText, at: Date.now() });
    contacts.set(waId, c);

    // ---- première interaction
    if (!c._welcomed) {
      await sendText(waId,
        "Hello, ici l’équipe FitMouv 👋 On prépare ton programme personnalisé et on revient vers toi sous 24–48h. " +
        "Si tu as des contraintes (voyage, horaires, blessures…), dis-le ici.");
      contacts.set(waId, { ...c, _welcomed: true, programScheduledAt: Date.now() + randProgramDelayMs() });
      return;
    }

    // ---- conversation normale (IA)
    await sendText(waId, "Bien noté, je te réponds dans quelques minutes…");
    await new Promise(r => setTimeout(r, randDelayMs()));

    const lastMsgs = c.history.slice(-20).map(h => ({ role: h.role, content: h.text }));
    const sys = "Tu es FitMouv, coach sport + nutrition. Style simple, empathique, sans emoji excessif, sans mise en gras. Réponds naturellement.";
    const reply = await openaiChat([{ role: 'system', content: sys }, ...lastMsgs]);
    await sendText(waId, reply);

    c.history.push({ role: 'assistant', text: reply, at: Date.now() });
    contacts.set(waId, c);
    updateLongSummary(waId).catch(console.error);
  } catch (e) {
    console.error('Erreur /webhook:', e);
  }
});

// ===============
// 13) LANCEMENT
// ===============
app.listen(PORT, () => console.log(`🚀 Serveur FitMouv actif sur le port ${PORT}`));
