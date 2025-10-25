// =======================
// FitMouv WhatsApp Bot
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
// fetch compatible CJS
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// 3) ENV
const ACCESS_TOKEN       = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID    = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN       = process.env.VERIFY_TOKEN || 'fitmouv_verify_123';
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;

const SIO_ALLOWED_ORIGIN = process.env.SIO_ALLOWED_ORIGIN || 'https://pay.fitmouv.fr';
const SIO_SECRET         = process.env.SIO_SECRET || 'fitmouv_2025_secret_89HGsQ';
const SIO_THANKS_URL     = process.env.SIO_THANKS_URL || 'https://pay.fitmouv.fr/8cea436d';

// Nom + langue du template
const FITMOUV_WELCOME_TEMPLATE = process.env.FITMOUV_WELCOME_TEMPLATE || 'fitmouv_welcome';
const FITMOUV_LANG             = process.env.FITMOUV_LANG || 'fr'; // "fr" = French (France)

const PORT                  = process.env.PORT || 10000;
const DELAY_MIN_SEC         = Number(process.env.DELAY_MIN_SEC || 60);
const DELAY_MAX_SEC         = Number(process.env.DELAY_MAX_SEC || 240);
const PROGRAM_DELAY_MIN_MIN = Number(process.env.PROGRAM_DELAY_MIN_MIN || 1200);
const PROGRAM_DELAY_MAX_MIN = Number(process.env.PROGRAM_DELAY_MAX_MIN || 1380);

// 4) CORS minimal
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || origin === SIO_ALLOWED_ORIGIN)
    res.setHeader('Access-Control-Allow-Origin', SIO_ALLOWED_ORIGIN);
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
    return JSON.parse(fs.readFileSync(CLIENTS_PATH, 'utf8') || '{}');
  } catch (e) { console.error('readClients error:', e); return {}; }
}
function writeClients(db) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CLIENTS_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) { console.error('writeClients error:', e); }
}

// 6) UTILS
function pick(v, fallback = '') { return (v ?? '').toString().trim() || fallback; }
function phoneSanitize(p) { return pick(p).replace(/\s+/g, ''); }
function toE164FR(input) {
  const s = String(input || '').replace(/\s+/g, '');
  if (!s) return '';
  if (s.startsWith('+33')) return s;
  if (s.startsWith('33')) return '+' + s;
  if (s.startsWith('0')) return '+33' + s.slice(1);
  if (/^\d{9,10}$/.test(s)) return '+33' + s.replace(/^0/, '');
  return s;
}
function randDelayMs() {
  const min = Math.max(5, DELAY_MIN_SEC), max = Math.max(min, DELAY_MAX_SEC);
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
}
function randProgramDelayMs() {
  const min = PROGRAM_DELAY_MIN_MIN, max = PROGRAM_DELAY_MAX_MIN;
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 60 * 1000;
}
// 7) WHATSAPP HELPERS
async function waPost(path, payload) {
  const url = `https://graph.facebook.com/v20.0/${path}`;
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
  return waPost(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
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

async function sendTemplate(to, templateName, langCode = FITMOUV_LANG, components = []) {
  // langCode attendu par l’API: "fr", "en_US", "es", etc. (pas "french")
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: langCode },
      ...(components.length ? { components } : {})
    }
  };
  return waPost(`${PHONE_NUMBER_ID}/messages`, payload);
}

async function markAsRead(waId, msgId) {
  if (!msgId) return;
  try {
    await waPost(`${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: msgId,
      to: waId
    });
  } catch (e) { console.error('markAsRead:', e.message); }
}

// 8) OPENAI HELPERS
async function openaiChat(messages, temperature = 0.7) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature,
      messages
    })
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

// 9) GÉNÉRATION PROGRAMMES (pas de gras ** ** dans les textes)
async function generatePrograms(profile, userRequestText) {
  const sys = [
    "Tu es FitMouv, coach SPORT + NUTRITION. Français. Ton style est simple, clair, bienveillant.",
    "Évite toute mise en gras, pas d'astérisques. Utilise des sections courtes et des emojis si utile.",
    "Tiens compte de: âge, sexe, poids, objectif, temps dispo, lieu, matériel, diet, allergies, dislikes.",
    "Objectif: plan réaliste et tenable, axé sur l’adhérence."
  ].join('\n');

  const longSummary = profile._summary || '';
  const user = `
Résumé client (mémoire longue):
${longSummary || '(aucun résumé long pour le moment)'}

Profil SIO:
${JSON.stringify(profile, null, 2)}

Demande: "${userRequestText || 'Prépare un programme complet.'}"

Donne en sortie:
1) Objectif et approche (2-4 lignes)
2) Nutrition (plan 15 jours): détail J1-J3 + logique de rotation (quantités indicatives)
3) Sport (plan 15 jours): 3 jours-type avec 5-6 exos/jour (échauffement, force, cardio/HIIT, core, mobilité)
4) Conseils d’adhérence (3-5 puces)
  `.trim();

  return openaiChat([
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ]);
}

// 10) RÉSUMÉ LONG PONCTUEL
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

// 11) SCHEDULER PROGRAMME + VISUELS
const EXOS_MEDIA = {
  pushups: "https://i.imgur.com/0hYhD6j.gif",
  squats:  "https://i.imgur.com/7q5E2iB.gif",
  plank:   "https://i.imgur.com/zV7rpxd.gif",
};

setInterval(async () => {
  const now = Date.now();
  for (const [waId, c] of contacts) {
    // si fenêtre WA non ouverte (pas d’échanges récents), on n’envoie pas le programme auto
    // tu peux brancher ici une logique de template si besoin
    if (!c.programSent && c.programScheduledAt && c.programScheduledAt <= now) {
      try {
        const profile = { ...(c.sioProfile || {}), _summary: c.summary || '' };
        const baseText = await generatePrograms(profile, "Prépare le programme sport + nutrition personnalisé.");

        const delayBeforeSend = randDelayMs();
        await new Promise(r => setTimeout(r, delayBeforeSend));

        await sendText(waId, `Voici ton programme personnalisé (sport + nutrition) :\n\n${baseText}`);
        await sendImage(waId, EXOS_MEDIA.pushups, "Pompes – exécution");
        await sendImage(waId, EXOS_MEDIA.squats,  "Squats – exécution");
        await sendImage(waId, EXOS_MEDIA.plank,   "Planche – gainage");

        contacts.set(waId, { ...c, programSent: true });
      } catch (e) {
        console.error('Scheduler send error:', e.message);
      }
    }
  }
}, 60 * 1000);
// 12) ROUTES / ENDPOINTS

// Health
app.get('/', (_req, res) => res.send('FitMouv webhook OK'));

// Vérif Webhook Meta (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Util: formate numéro FR en E.164 si besoin
function toE164FR(input) {
  if (!input) return '';
  let s = String(input).trim();
  // accepte déjà +33...
  if (s.startsWith('+')) return s;
  // enlève tout sauf chiffres
  s = s.replace(/\D/g, '');
  // s'il commence par 0 => remplace par +33
  if (s.startsWith('0')) return '+33' + s.slice(1);
  // s'il commence par 33 sans +, ajoute +
  if (s.startsWith('33')) return '+' + s;
  // fallback: préfixe + (à tes risques si ce n'est pas FR)
  return '+' + s;
}

// Envoi template de bienvenue (gère 1 variable corps -> prénom)
// Fallback auto si ton modèle n’a pas de variable.
async function sendWelcomeTemplate(toE164, firstName) {
  const lang = FITMOUV_LANG || 'fr';
  const tmpl = 'fitmouv_welcome';

  // 1) tentative avec 1 variable ({{1}} = prénom)
  try {
    const components = [{
      type: 'body',
      parameters: [{ type: 'text', text: firstName || '!' }]
    }];
    const r1 = await sendTemplate(toE164, tmpl, lang, components);
    console.log(`✅ Template "${tmpl}" envoyée (1 param) ->`, r1);
    return r1;
  } catch (e1) {
    console.error('❌ Echec template (1 param):', e1.message || e1);
    // 2) si ton template n’a PAS de variable, retente sans components
    try {
      const r2 = await sendTemplate(toE164, tmpl, lang, []);
      console.log(`✅ Template "${tmpl}" envoyée (0 param) ->`, r2);
      return r2;
    } catch (e2) {
      console.error('❌ Echec template (0 param):', e2.message || e2);
      throw e2;
    }
  }
}

// Systeme.io → Webhook (depuis règle d’automatisation OU <form action=...>)
app.post('/sio-webhook', async (req, res) => {
  try {
    const secretFromQuery = (req.query.secret || '').toString().trim();
    if (!SIO_SECRET || secretFromQuery !== SIO_SECRET) {
      console.warn('SIO secret invalide');
      return res.status(200).json({ ok: false, reason: 'bad_secret' });
    }

    const payload = Object.keys(req.body || {}).length ? req.body : {};
    console.log('SIO raw payload:', payload);

    const lead = {
      source: 'systeme.io',
      createdAt: new Date().toISOString(),
      email:     (payload.email || payload.user_email || '').toString().trim(),
      phoneRaw:  (payload.whatsapp || payload.phone || payload.telephone || payload.phone_number || '').toString().trim(),
      firstName: (payload.first_name || payload.prenom || payload.firstname || payload.firstName || '').toString().trim(),
      lastName:  (payload.last_name  || payload.nom   || payload.lastname  || payload.lastName  || '').toString().trim(),
      objectif:  (payload.objectif || '').toString().trim(),
      niveau:    (payload.niveau || payload.level || '').toString().trim(),
      contraintes: (payload.contraintes || payload.constraints || '').toString().trim(),
      sexe:      (payload.sexe || payload.gender || '').toString().trim(),
      age:       (payload.age || '').toString().trim(),
      poids:     (payload.poids || payload.weight || '').toString().trim(),
      taille:    (payload.taille || payload.height || '').toString().trim(),
      disponibilites: (payload.disponibilites || payload.creneaux || payload.availability || '').toString().trim(),
      materiel:  (payload.materiel || payload.equipment || '').toString().trim(),
      patho:     (payload.pathologies || payload.patho || '').toString().trim(),
      preferences: (payload.preferences || payload.aliments_pref || '').toString().trim(),
      raw: payload
    };

    const phoneE164 = toE164FR(lead.phoneRaw);
    if (!phoneE164 || phoneE164.length < 6) {
      console.warn('SIO webhook sans téléphone valide. Reçu:', lead.phoneRaw);
      return res.json({ ok: true, stored: false, reason: 'no_phone' });
    }

    // Stockage léger
    const db = readClients();
    db[phoneE164] = { ...(db[phoneE164] || {}), ...lead, phone: phoneE164 };
    writeClients(db);
    console.log('Lead enregistré pour', phoneE164);

    // Envoi immédiat de la template de bienvenue (fenêtre fermée)
    try {
      await sendWelcomeTemplate(phoneE164, lead.firstName || '!');
    } catch (te) {
      console.error('❌ Erreur envoi template accueil:', te.message || te);
    }

    // Si l’appel vient d’un <form> (navigateur), redirige vers la page de confirmation
    const acceptsHTML = (req.headers.accept || '').includes('text/html');
    if (acceptsHTML) return res.redirect(302, SIO_THANKS_URL);

    return res.json({ ok: true, stored: true });
  } catch (err) {
    console.error('SIO /sio-webhook error:', err);
    return res.json({ ok: true, stored: false, error: true });
  }
});

// Systeme.io → Profil JSON (optionnel si tu pousses un profil plus complet)
app.post('/sio', (req, res) => {
  try {
    const p = req.body || {};
    const phoneE164 = toE164FR(p.phone || p.telephone || '');
    if (!phoneE164) return res.status(400).json({ ok: false, error: 'missing phone' });

    const old = contacts.get(phoneE164) || {};
    const profile = {
      firstname: p.firstname || p.first_name || old.firstname || '',
      lastname:  p.lastname  || p.last_name  || old.lastname  || '',
      email:     p.email     || old.email || '',
      phone:     phoneE164,
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

    contacts.set(phoneE164, {
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

// Téléchargement média WhatsApp (vocaux)
async function downloadWhatsAppMedia(mediaId) {
  const meta1 = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }
  });
  if (!meta1.ok) throw new Error(`media meta ${meta1.status}: ${await meta1.text()}`);
  const { url } = await meta1.json();

  const fileRes = await fetch(url, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } });
  if (!fileRes.ok) throw new Error(`media download ${fileRes.status}: ${await fileRes.text()}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  return buf;
}

// Réception messages WhatsApp (POST) — IA quand fenêtre ouverte (client t’écrit)
app.post('/webhook', async (req, res) => {
  try {
    res.sendStatus(200);

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    const msg    = value?.messages?.[0];
    if (!msg) return;

    const waId  = msg.from;     // ex: "33617996917"
    const msgId = msg.id;
    const type  = msg.type;

    let c = contacts.get(waId) || { history: [], programSent: false, programScheduledAt: null, sioProfile: null, summary: '' };
    contacts.set(waId, c);

    await markAsRead(waId, msgId);

    // Texte utilisateur (ou transcription)
    let userText = '';
    if (type === 'text') {
      userText = msg.text.body.trim();
    } else if (type === 'audio') {
      try {
        const mediaId = msg.audio.id;
        const buf = await downloadWhatsAppMedia(mediaId);
        userText = await transcribeAudio(buf, 'voice.ogg');
      } catch (e) {
        console.error('Transcription vocale erreur:', e.message);
        await sendText(waId, "J’ai pas réussi à comprendre le vocal. Peux-tu réessayer en texte ?");
        return;
      }
    } else {
      await sendText(waId, "Reçu. Dis-moi en texte ce que tu veux qu’on prépare pour toi.");
      return;
    }

    // Mémorise message
    c = contacts.get(waId);
    c.history.push({ role: 'user', text: userText, at: Date.now() });
    contacts.set(waId, c);

    // Premier contact réel (ou après template) → message humain + planif programme
    if (!c._welcomed) {
      const welcome =
        "Hello, ici l’équipe FitMouv !\n\n" +
        "Bonne nouvelle : tu es pris(e) en charge par tes coachs (sport + nutrition). " +
        "On prépare ton programme personnalisé, et on te recontacte sous 24–48h pour le passer avec toi.\n\n" +
        "En attendant, s’il y a des contraintes (voyage, horaires, blessures…), dis-le ici.";
      await sendText(waId, welcome);

      // Planifie programme (20–23h)
      const dueAt = Date.now() + (Math.floor(Math.random() * (PROGRAM_DELAY_MAX_MIN - PROGRAM_DELAY_MIN_MIN + 1)) + PROGRAM_DELAY_MIN_MIN) * 60 * 1000;
      contacts.set(waId, { ...c, _welcomed: true, programScheduledAt: dueAt });

      return; // stop ici pour le premier échange
    }

    // Échanges intermédiaires: réponse IA simple (pas de gras)
    await sendText(waId, "Bien noté, je te réponds dans quelques minutes…");
    const delay = Math.floor(Math.random() * (DELAY_MAX_SEC - DELAY_MIN_SEC + 1)) + DELAY_MIN_SEC;
    await new Promise(r => setTimeout(r, delay * 1000));

    const last30 = c.history.slice(-30).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text }));
    const mem = c.summary ? `Mémoire longue: ${c.summary}` : 'Pas de mémoire longue.';
    const sys = "Tu es FitMouv (FR), coach sport + nutrition. Style simple, empathique, précis. Pas de gras ou astérisques. Si le programme n’a pas encore été envoyé, reste en conversation: clarifie (1–2 questions max), note les contraintes utiles, pas de promesses médicales.";

    const reply = await openaiChat([
      { role: 'system', content: sys },
      { role: 'user', content: mem },
      ...last30
    ]);

    await sendText(waId, reply);

    // Mémorise réponse & MAJ résumé parfois
    c = contacts.get(waId);
    c.history.push({ role: 'assistant', text: reply, at: Date.now() });
    contacts.set(waId, c);
    updateLongSummary(waId).catch(e => console.error('updateLongSummary:', e.message));

  } catch (e) {
    console.error('Erreur /webhook:', e);
  }
});

// 13) START
app.listen(PORT, () => console.log(`🚀 Serveur FitMouv lancé sur ${PORT}`));
