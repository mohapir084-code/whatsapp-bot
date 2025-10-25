// =======================
// FitMouv WhatsApp Bot
// =======================

// 1) BOOT EXPRESS EN PREMIER
const express = require('express');
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// 2) IMPORTS & HELPERS
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// 3) ENV
const {
  ACCESS_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN = 'fitmouv_verify_123',
  OPENAI_API_KEY,
  SIO_ALLOWED_ORIGIN = 'https://pay.fitmouv.fr',
  SIO_SECRET = 'fitmouv_2025_secret_89HGsQ',
  SIO_THANKS_URL = 'https://pay.fitmouv.fr/8cea436d',
  PORT = 10000,
  DELAY_MIN_SEC = 60,
  DELAY_MAX_SEC = 240,
  PROGRAM_DELAY_MIN_MIN = 1200, // 20h
  PROGRAM_DELAY_MAX_MIN = 1380  // 23h
} = process.env;

// 4) CORS minimal (si un <form action> appelle l’API directement)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || origin === SIO_ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', SIO_ALLOWED_ORIGIN);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 5) STOCKAGE LÉGER + MÉMOIRE
const contacts = new Map(); // waId -> { sioProfile, history:[{role,text,at}], summary, programScheduledAt, programSent, firstLeadAt, lastInboundAt, _welcomed }
const DATA_DIR = '/tmp';
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
const pick = (v, fb = '') => (v === null || v === undefined ? fb : String(v).trim());
const phoneSanitize = p => pick(p).replace(/\s+/g, '');
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randDelayMs = () => randInt(Number(DELAY_MIN_SEC), Number(DELAY_MAX_SEC)) * 1000;
const randProgramDelayMs = () => randInt(Number(PROGRAM_DELAY_MIN_MIN), Number(PROGRAM_DELAY_MAX_MIN)) * 60 * 1000;

// 7) WHATSAPP HELPERS
async function waPost(path, payload) {
  const url = `https://graph.facebook.com/v24.0/${path}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Meta POST ${path} -> ${r.status}: ${txt}`);
  try { return JSON.parse(txt); } catch { return txt; }
}
async function sendText(to, body) {
  return waPost(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body, preview_url: false }
  });
}
async function sendTemplate(to, templateName, variables = [], lang = 'fr') {
  return waPost(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: lang },
      components: variables.length ? [{ type: 'body', parameters: variables.map(v => ({ type: 'text', text: String(v) })) }] : []
    }
  });
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

// 8) OPENAI HELPERS (pour programme & réponses)
async function openaiChat(messages, temperature = 0.7) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
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
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: form });
  if (!r.ok) throw new Error(`OpenAI transcribe ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.text || '';
}

// 9) GÉNÉRATION PROGRAMMES
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
2) 🥗 Nutrition (plan 15 jours): détail J1-J3 + logique de rotation (quantités indicatives).
3) 🏋️‍♂️ Sport (plan 15 jours): 3 JOURS-TYPE détaillés (5-6 exos/jour, échauffement/force/cardio/core/mobilité).
4) 💡 Conseils d’adhérence (3-5 bullets).
  `.trim();

  return openaiChat([{ role: 'system', content: sys }, { role: 'user', content: user }]);
}

// 10) RÉSUMÉ LONG PONCTUEL
async function updateLongSummary(waId) {
  const c = contacts.get(waId);
  if (!c || !c.history) return;
  if ((c.history.length || 0) % 12 !== 0) return;
  const transcript = c.history.map(h => `${h.role.toUpperCase()}: ${h.text}`).join('\n');
  const summary = await openaiChat(
    [{ role: 'system', content: 'Résume très compactement la conversation coach-client pour mémoire longue.' },
     { role: 'user', content: transcript.slice(-6000) }],
    0.3
  );
  contacts.set(waId, { ...c, summary });
}

// 11) SCHEDULER (envoi programme quand fenêtre ouverte = client a répondu)
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
        await new Promise(r => setTimeout(r, randDelayMs()));
        await sendText(waId, `🗓️ Comme promis, voici ton programme personnalisé (sport + nutrition) :\n\n${baseText}`);
        await waPost(`${PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', to: waId, type: 'image', image: { link: EXOS_MEDIA.pushups, caption: "Pompes – exécution" }});
        await waPost(`${PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', to: waId, type: 'image', image: { link: EXOS_MEDIA.squats,  caption: "Squats – exécution" }});
        await waPost(`${PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', to: waId, type: 'image', image: { link: EXOS_MEDIA.plank,   caption: "Planche – gainage" }});
        contacts.set(waId, { ...c, programSent: true });
      } catch (e) { console.error('Scheduler send error:', e.message); }
    }
  }
}, 60 * 1000);

// 12) ENDPOINTS

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

// Systeme.io → Webhook : FIN FORMULAIRE = stock + ENVOI TEMPLATE WELCOME
app.post('/sio-webhook', async (req, res) => {
  try {
    const secretFromQuery = pick(req.query.secret);
    if (!SIO_SECRET || secretFromQuery !== SIO_SECRET) {
      console.warn('SIO secret invalid'); return res.status(200).json({ ok: false, reason: 'bad_secret' });
    }

    const payload = Object.keys(req.body || {}).length ? req.body : {};
    console.log('SIO raw payload:', payload);

    const lead = {
      source: 'systeme.io',
      createdAt: new Date().toISOString(),
      email:     pick(payload.email || payload.user_email),
      phone:     phoneSanitize(payload.phone || payload.telephone || payload.whatsapp || payload.phone_number),
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

    if (!lead.phone) return res.json({ ok: true, stored: false, reason: 'no_phone' });

    // Persist JSON
    const db = readClients();
    db[lead.phone] = { ...(db[lead.phone] || {}), ...lead };
    writeClients(db);

    // Mémo RAM (utile pour la suite)
    const waId = lead.phone.startsWith('33') ? lead.phone : `33${lead.phone.replace(/^0/, '')}`;
    const current = contacts.get(waId) || {};
    contacts.set(waId, { ...current, sioProfile: { ...(current.sioProfile||{}), ...lead }, firstLeadAt: Date.now() });

    // === CRUCIAL === 1er contact => TEMPLATE (fenêtre fermée)
    // Template: fitmouv_welcome_v1 avec variable prénom si présente
    const varName = lead.firstName || '👋';
    try {
      await sendTemplate(waId, 'fitmouv_welcome_v1', [varName], 'fr');
    } catch (e) {
      console.error('Welcome template error:', e.message);
    }

    // Redirection si <form action="...">
    const acceptsHTML = (req.headers.accept || '').includes('text/html');
    if (acceptsHTML) return res.redirect(302, SIO_THANKS_URL);
    return res.json({ ok: true, stored: true });
  } catch (err) {
    console.error('SIO /sio-webhook error:', err);
    return res.json({ ok: true, stored: false, error: true });
  }
});

// Systeme.io → Profil JSON (optionnel)
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

    contacts.set(waId, { ...old, sioProfile: profile, history: old.history || [], summary: old.summary || '', programScheduledAt: old.programScheduledAt || null, programSent: old.programSent || false });
    return res.json({ ok: true });
  } catch (e) {
    console.error('/sio error:', e);
    return res.status(500).json({ ok: false });
  }
});

// Téléchargement média WhatsApp (vocaux)
async function downloadWhatsAppMedia(mediaId) {
  const meta1 = await fetch(`https://graph.facebook.com/v24.0/${mediaId}`, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (!meta1.ok) throw new Error(`media meta ${meta1.status}: ${await meta1.text()}`);
  const { url } = await meta1.json();
  const fileRes = await fetch(url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (!fileRes.ok) throw new Error(`media download ${fileRes.status}: ${await fileRes.text()}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  return buf;
}

// Réception messages WhatsApp (POST)
app.post('/webhook', async (req, res) => {
  try {
    res.sendStatus(200);

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    const msg    = value?.messages?.[0];
    if (!msg) return;

    const waId  = msg.from;
    const msgId = msg.id;
    const type  = msg.type;

    let c = contacts.get(waId) || { history: [], programSent: false, programScheduledAt: null, sioProfile: null, summary: '' };
    contacts.set(waId, c);

    await markAsRead(waId, msgId);
    c.lastInboundAt = Date.now();

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
        await sendText(waId, "J’ai pas réussi à comprendre le vocal 😅 Tu peux réessayer en texte ?");
        return;
      }
    } else {
      await sendText(waId, "Reçu ✅ Dis-moi en texte ce que tu veux qu’on prépare pour toi 💬");
      return;
    }

    // Mémorise message
    c = contacts.get(waId);
    c.history.push({ role: 'user', text: userText, at: Date.now() });
    contacts.set(waId, c);

    // Premier vrai message reçu → planifie programme (ouvre fenêtre)
    if (!c._welcomed) {
      const welcome =
        "👋 Hello, ici l’équipe FitMouv !\n\n" +
        "Bonne nouvelle : tu es pris(e) en charge par tes coachs dédiés (sport + nutrition). " +
        "On prépare ton programme personnalisé et on revient vers toi pour le valider ensemble.\n\n" +
        "Si tu as des contraintes (horaires, blessures, aliments à éviter…), dis-le ici 💬";
      await sendText(waId, welcome);
      const dueAt = Date.now() + randProgramDelayMs();
      contacts.set(waId, { ...c, _welcomed: true, programScheduledAt: dueAt });
      return;
    }

    // Échanges intermédiaires (IA)
    await sendText(waId, "👌 Bien noté, je te réponds dans quelques minutes…");
    await new Promise(r => setTimeout(r, randDelayMs()));

    const last30 = c.history.slice(-30).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text }));
    const mem = c.summary ? `Mémoire longue: ${c.summary}` : 'Pas de mémoire longue.';
    const sys = "Tu es FitMouv (FR), coach sport + nutrition. Style chill, empathique, précis.";

    const reply = await openaiChat([{ role: 'system', content: sys }, { role: 'user', content: mem }, ...last30]);
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
app.listen(Number(PORT), () => console.log(`🚀 Serveur FitMouv lancé sur ${PORT}`));
