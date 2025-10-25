// ===== fetch compatible CJS =====
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const FormData = require('form-data');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const ACCESS_TOKEN    = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const SIO_ALLOWED_ORIGIN = process.env.SIO_ALLOWED_ORIGIN || 'https://pay.fitmouv.fr'; // domaine SIO

const PORT                   = process.env.PORT || 10000;
const DELAY_MIN_SEC          = Number(process.env.DELAY_MIN_SEC || 60);
const DELAY_MAX_SEC          = Number(process.env.DELAY_MAX_SEC || 240);
const PROGRAM_DELAY_MIN_MIN  = Number(process.env.PROGRAM_DELAY_MIN_MIN || 1200);
const PROGRAM_DELAY_MAX_MIN  = Number(process.env.PROGRAM_DELAY_MAX_MIN || 1380);

// ===== App =====
const app = express();

// ---- CORS global (autorise SIO à appeler ton API) ----
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || origin === SIO_ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', SIO_ALLOWED_ORIGIN);
  }
  // si tu veux ouvrir à tous (moins sécurisé): res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- Parsers ----
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ===== Mémoire en RAM (POC)
const contacts = new Map();

// ------- helpers stockage JSON léger -------
const DATA_DIR = path.join('/tmp');
const CLIENTS_PATH = path.join(DATA_DIR, 'clients.json');

function readClients() {
  try {
    if (!fs.existsSync(CLIENTS_PATH)) return {};
    const raw = fs.readFileSync(CLIENTS_PATH, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error('readClients error:', e);
    return {};
  }
}
function writeClients(db) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CLIENTS_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('writeClients error:', e);
  }
}

// ------- utilitaires -------
function pick(v, fallback = '') {
  if (v === null || v === undefined) return fallback;
  return String(v).trim();
}
function phoneSanitize(p) {
  return pick(p).replace(/\s+/g, '');
}

// Envoie d’un texte WhatsApp simple via l’API Meta
async function sendWhatsAppText(toPhone, text) {
  try {
    const url = `https://graph.facebook.com/v24.0/${process.env.PHONE_NUMBER_ID}/messages`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toPhone,
        text: { body: text }
      })
    });
    const j = await r.json();
    console.log('Meta send resp:', j);
    return j;
  } catch (e) {
    console.error('sendWhatsAppText error:', e);
  }
}

// ===== Utils WhatsApp =====
async function waPost(path, payload) {
  const url = `https://graph.facebook.com/v24.0/${path}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Meta POST ${path} -> ${r.status}: ${txt}`);
  try { return JSON.parse(txt); } catch { return txt; }
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
async function sendText(to, body) {
  return waPost(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body, preview_url: false }
  });
}
async function sendImage(to, link, caption = '') {
  return waPost(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { link, caption }
  });
}

// ===== OpenAI helpers =====
async function openaiChat(messages, temperature = 0.7) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages, temperature })
  });
  if (!r.ok) throw new Error(`OpenAI chat ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content ?? '';
}
async function transcribeAudio(fileBuffer, filename = 'audio.ogg') {
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
  return data.text || '';
}

// ===== Génération des programmes (en FR) =====
async function generatePrograms(profile, userRequestText) {
  const sys = [
    "Tu es FitMouv, coach SPORT + NUTRITION. Français. Ton chill, clair, bienveillant.",
    "Structure les réponses avec emojis, quantités réalistes, et sections nettes.",
    "Tiens compte de: âge/sexe/poids/objectif/temps dispo/lieu/matériel/diet/allergies/dislikes.",
    "Objectif: plan réaliste, tenable, axé adhérence."
  ].join('\n');

  const longSummary = profile._summary || '';
  const user = `
Résumé client (mémoire longue):
${longSummary || '(pas de résumé long pour le moment)'}

Profil SIO:
${JSON.stringify(profile, null, 2)}

Demande: "${userRequestText || 'Prépare un programme complet.'}"

Donne en sortie:
1) 🎯 Objectif & approche (2-4 lignes)
2) 🥗 Nutrition (plan 15 jours): détail J1-J3, puis logique de rotation (quantités indicatives).
3) 🏋️‍♂️ Sport (plan 15 jours): 3 JOURS-TYPE détaillés avec 5-6 exos/jour (échauffement, force, cardio/HIIT, core, mobilité). Indique les exos par NOMS CLAIRS.
4) 💡 Conseils d’adhérence (3-5 bullets).
  `.trim();

  return openaiChat([
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ]);
}

// ===== Mémoire large : dernier 30 + résumé =====
async function updateLongSummary(waId) {
  const c = contacts.get(waId);
  if (!c || !c.history) return;
  if ((c.history.length || 0) % 12 !== 0) return;

  const transcript = c.history.map(h => `${h.role.toUpperCase()}: ${h.text}`).join('\n');
  const prompt = `Tu es un assistant qui résume une conversation client-coach FitMouv. Fais un résumé persistant très compact.`;

  const summary = await openaiChat([
    { role: 'system', content: prompt },
    { role: 'user', content: transcript.slice(-6000) }
  ], 0.3);

  contacts.set(waId, { ...c, summary });
}

// ===== Délais =====
function randDelayMs() {
  const min = Math.max(5, DELAY_MIN_SEC);
  const max = Math.max(min, DELAY_MAX_SEC);
  const sec = Math.floor(Math.random() * (max - min + 1)) + min;
  return sec * 1000;
}
function randProgramDelayMs() {
  const min = PROGRAM_DELAY_MIN_MIN;
  const max = PROGRAM_DELAY_MAX_MIN;
  const m = Math.floor(Math.random() * (max - min + 1)) + min;
  return m * 60 * 1000;
}

// ===== ROUTE WEBHOOK SYSTEME.IO (coté navigateur OU règle d’automatisation) =====
app.post('/sio-webhook', async (req, res) => {
  try {
    // sécurité via secret en query
    const secretFromQuery = pick(req.query.secret);
    const expected = pick(process.env.SIO_SECRET);
    if (!expected || secretFromQuery !== expected) {
      console.warn('SIO secret invalid');
      // renvoie tout de même 200 pour éviter retry SIO mais indique erreur
      return res.status(200).json({ ok: false, reason: 'bad_secret' });
    }

    // payload (JSON/FIELD)
    const payload = Object.keys(req.body || {}).length ? req.body : {};
    console.log('SIO raw payload:', payload);

    // mapping champs
    const lead = {
      source: 'systeme.io',
      createdAt: new Date().toISOString(),
      email:    pick(payload.email || payload.user_email),
      phone:    phoneSanitize(payload.phone || payload.telephone || payload.whatsapp || payload.phone_number),
      firstName: pick(payload.first_name || payload.prenom || payload.firstname || payload.firstName),
      lastName:  pick(payload.last_name || payload.nom || payload.lastname || payload.lastName),
      objectif:  pick(payload.objectif),
      niveau:    pick(payload.niveau || payload.level),
      contraintes: pick(payload.contraintes || payload.constraints),
      sexe:      pick(payload.sexe || payload.gender),
      age:       pick(payload.age),
      poids:     pick(payload.poids || payload.weight),
      taille:    pick(payload.taille || payload.height),
      disponibilites: pick(payload.disponibilites || payload.creneaux || payload.availability),
      materiel:  pick(payload.materiel || payload.equipment),
      patho:     pick(payload.pathologies || payload.patho),
      preferences: pick(payload.preferences || payload.aliments_pref),
      raw: payload
    };

    if (!lead.phone) {
      console.warn('SIO webhook sans téléphone, on ignore.');
      return res.json({ ok: true, stored: false, reason: 'no_phone' });
    }

    // stockage
    const db = readClients();
    db[lead.phone] = { ...(db[lead.phone] || {}), ...lead };
    writeClients(db);
    console.log('Lead enregistré pour', lead.phone);

    // message de bienvenue WhatsApp
    const prenom = lead.firstName || '👋';
    const bienvenue =
`Salut ${prenom} ! 🙌

Merci pour ton inscription. On a bien reçu toutes tes infos — on te prépare un programme **vraiment personnalisé** (sport + nutrition).
🕒 D’ici **24–48h**, tes coachs te reviennent pour te le présenter et l’ajuster avec toi. 

Si tu as une contrainte urgente (blessure, dispo qui change, aliment à éviter), écris-la ici.`;

    await sendWhatsAppText(lead.phone, bienvenue);

    // Si ça vient d’un <form action=...> (HTML), on peut rediriger proprement:
    const acceptsHTML = (req.headers.accept || '').includes('text/html');
    if (acceptsHTML) {
      // redirige vers ta page de confirmation SIO
      const thanksUrl = process.env.SIO_THANKS_URL || 'https://pay.fitmouv.fr/8cea436d'; 
      return res.redirect(302, thanksUrl);
    }
    return res.json({ ok: true, stored: true });
  } catch (err) {
    console.error('SIO /sio-webhook error:', err);
    return res.json({ ok: true, stored: false, error: true });
  }
});

// ---- Healthcheck
app.get('/', (_req, res) => res.send('FitMouv webhook OK'));

// ---- Vérif webhook Meta
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ---- Endpoint /sio (profil JSON) (inchangé)
app.post('/sio', (req, res) => {
  try {
    const p = req.body || {};
    const phoneRaw = (p.phone || p.telephone || '').replace(/\D/g, '');
    if (!phoneRaw) return res.status(400).json({ ok: false, error: 'missing phone' });
    const waId = phoneRaw.startsWith('33') ? phoneRaw : `33${phoneRaw.replace(/^0/, '')}`;

    const old = contacts.get(waId) || {};
    const profile = {
      firstname: p.firstname || p.first_name || old.firstname || '',
      lastname:  p.lastname || p.last_name || old.lastname || '',
      email:     p.email || old.email || '',
      phone:     waId,
      age:       p.age || old.age || '',
      gender:    p.gender || p.sexe || old.gender || '',
      height_cm: p.height_cm || old.height_cm || '',
      weight_kg: p.weight_kg || old.weight_kg || '',
      goal:      p.goal || p.objective || old.goal || '',
      target_weight: p.target_weight || old.target_weight || '',
      time_per_day_min: p.time_per_day_min || old.time_per_day_min || '',
      workouts_per_week: p.workouts_per_week || old.workouts_per_week || '',
      equipment: p.equipment || old.equipment || '',
      training_place: p.training_place || old.training_place || '',
      diet_type: p.diet_type || old.diet_type || '',
      dislikes:  p.dislikes || old.dislikes || '',
      allergies: p.allergies || old.allergies || ''
    };

    contacts.set(waId, {
      ...old,
      sioProfile: profile,
      history: old.history || [],
      summary: old.summary || '',
      programScheduledAt: old.programScheduledAt || null,
      programSent: old.programSent || false
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error('/sio error:', e);
    return res.status(500).json({ ok: false });
  }
});

// ---- Téléchargement média, réception WA, scheduler… (inchangé: garde tes blocs existants)

// Lancement
app.listen(PORT, () => console.log(`Serveur FitMouv lancé sur ${PORT}`));
