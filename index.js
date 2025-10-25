// =======================
// FitMouv WhatsApp Bot
// Option 1: Templates SEULEMENT fenêtre fermée
// =======================

// 1) BOOT EXPRESS
const express = require('express');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// 2) IMPORTS & HELPERS
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// 3) ENV
const ACCESS_TOKEN       = process.env.ACCESS_TOKEN;         // Meta permanent/prolongé
const PHONE_NUMBER_ID    = process.env.PHONE_NUMBER_ID;      // id WA sender
const VERIFY_TOKEN       = process.env.VERIFY_TOKEN || 'fitmouv_verify_123';
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;
const SIO_ALLOWED_ORIGIN = process.env.SIO_ALLOWED_ORIGIN || 'https://pay.fitmouv.fr';
const SIO_SECRET         = process.env.SIO_SECRET || 'fitmouv_2025_secret_89HGsQ';
const SIO_THANKS_URL     = process.env.SIO_THANKS_URL || 'https://pay.fitmouv.fr/8cea436d';
const PORT               = process.env.PORT || 10000;

// Langue par défaut pour les HSM (doit correspondre à une traduction existante)
const TMPL_LANG = process.env.TMPL_LANG || 'fr';

// Noms de modèles (modifie ici si tu renomme côté Meta)
const TEMPLATES = {
  welcome:     process.env.TMPL_WELCOME     || 'fitmouv_welcome',
  relance24h:  process.env.TMPL_RELANCE_24H || 'fitmouv_relance_douce',
  relance72h:  process.env.TMPL_RELANCE_72H || 'fitmouv_check_contact',
  relance7d:   process.env.TMPL_RELANCE_7D  || 'fitmouv_relance_finale',
};

// Délais
const MINUTES = 60 * 1000;
const HOURS   = 60 * MINUTES;
const DAYS    = 24 * HOURS;

const DELAY_MIN_SEC         = Number(process.env.DELAY_MIN_SEC || 60);
const DELAY_MAX_SEC         = Number(process.env.DELAY_MAX_SEC || 240);
const PROGRAM_DELAY_MIN_MIN = Number(process.env.PROGRAM_DELAY_MIN_MIN || 1200); // 20h
const PROGRAM_DELAY_MAX_MIN = Number(process.env.PROGRAM_DELAY_MAX_MIN || 1380); // 23h

// 4) CORS minimal (au cas où SIO appelle direct)
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

// 5) STOCKAGE LÉGER + MÉMOIRE (RAM + /tmp)
const contacts = new Map(); // waId -> { sioProfile, history:[{role,text,at}], summary, programScheduledAt, programSent, _welcomed, lastUserAt, lastAssistantAt, relances:[{at,type,sent}], autoPaused }
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

// 6) UTILS
function pick(v, fallback = '') {
  if (v === null || v === undefined) return fallback;
  return String(v).trim();
}
function phoneSanitize(p) {
  return pick(p).replace(/\s+/g, '');
}
// Convertit FR 06/07 en E.164 +33…
function toE164FR(any) {
  let s = (any || '').toString().trim();
  if (!s) return s;
  // enlève espaces, points, tirets, parenthèses
  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('+')) {
    return s; // déjà E.164
  }
  // si commence par 00 -> +…
  if (s.startsWith('00')) return '+' + s.slice(2);
  // si 10 chiffres et commence par 0 -> +33…
  if (/^0\d{9}$/.test(s)) return '+33' + s.slice(1);
  // si déjà 11/12 chiffres sans +, tente +…
  if (/^\d{10,15}$/.test(s)) return '+' + s;
  return s;
}

// Helper pour récupérer le prénom à partir du contact
function firstNameFor(waId) {
  const c = contacts.get(waId);
  return (
    c?.sioProfile?.firstName ||
    c?.sioProfile?.firstname ||
    c?.sioProfile?.FirstName ||
    ''
  );
}

function now() { return Date.now(); }
function within24h(ts) { return ts && (now() - ts) < (24 * HOURS); }
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

// 7) WHATSAPP HELPERS
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

// Envoi TEMPLATE (avec params optionnels)
async function sendTemplate(to, name, langCode = TMPL_LANG, bodyParams = []) {
  const components = [];
  if (bodyParams.length > 0) {
    components.push({
      type: 'body',
      parameters: bodyParams.map(v => ({ type: 'text', text: v ?? '' }))
    });
  }
  return waPost(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name, language: { code: langCode }, components }
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

// 8) OPENAI HELPERS (réponses IA sans mise en gras/astérisques)
async function openaiChat(messages, temperature = 0.7) {
  const sys = "Tu es FitMouv (FR), coach sport + nutrition. Style clair, humain, sans emphase ni astérisques. Pas de gras. Questions courtes et utiles. Reste concret.";
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{role:'system',content:sys}, ...messages], temperature })
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

// 9) GÉNÉRATION PROGRAMMES (IA)
async function generatePrograms(profile, userRequestText) {
  const sys = [
    "Tu es FitMouv, coach SPORT + NUTRITION (FR). Style clair, pas d'astérisques ni gras.",
    "Structure par sections nettes, quantités réalistes.",
    "Tiens compte: âge/sexe/poids/objectif/temps dispo/lieu/matériel/diet/allergies/dislikes.",
    "Objectif: plan réaliste, tenable, axé adhérence."
  ].join('\n');

  const longSummary = profile._summary || '';
  const user = `
Résumé client:
${longSummary || '(pas de résumé long pour le moment)'}

Profil SIO:
${JSON.stringify(profile, null, 2)}

Demande: "${userRequestText || 'Prépare un programme complet.'}"

Donne en sortie:
1) Objectif & approche (2-4 lignes)
2) Nutrition 15 jours: détail J1-J3 + logique de rotation (quantités indicatives)
3) Sport 15 jours: 3 JOURS-TYPE (5-6 exos/jour, échauffement/force/cardio/core/mobilité)
4) Conseils d’adhérence (3-5 bullets)
  `.trim();

  const txt = await openaiChat([
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ]);
  return txt;
}

// 10) RÉSUMÉ LONG
async function updateLongSummary(waId) {
  const c = contacts.get(waId);
  if (!c || !c.history) return;
  if ((c.history.length || 0) % 12 !== 0) return;

  const transcript = c.history.map(h => `${h.role.toUpperCase()}: ${h.text}`).join('\n');
  const prompt = `Fais un résumé persistant très compact des infos utiles pour personnaliser sport + nutrition.`;
  const summary = await openaiChat([
    { role: 'system', content: prompt },
    { role: 'user', content: transcript.slice(-6000) }
  ], 0.3);
  contacts.set(waId, { ...c, summary });
}

// ===== SCHEDULER : envoi programme + relances templates (si fenêtre fermée) =====
setInterval(async () => {
  const now = Date.now();

  for (const [waId, cOrig] of contacts) {
    const c = contacts.get(waId) || {};
    const fname = firstNameFor(waId) || '👋';

    // ------------------------------
    // 1) ENVOI PROGRAMME (si planifié)
    // ------------------------------
    if (!c.programSent && c.programScheduledAt && c.programScheduledAt <= now) {
      try {
        const profile = { ...(c.sioProfile || {}), _summary: c.summary || '' };
        const baseText = await generatePrograms(profile, "Prépare le programme sport + nutrition personnalisé.");

        // petit délai humain
        await new Promise(r => setTimeout(r, randDelayMs()));

        await sendText(waId, "🗓️ Comme promis, voici ton programme personnalisé (sport + nutrition) :\n\n" + baseText);
        await sendImage(waId, "https://i.imgur.com/0hYhD6j.gif", "Pompes – exécution");
        await sendImage(waId, "https://i.imgur.com/7q5E2iB.gif", "Squats – exécution");
        await sendImage(waId, "https://i.imgur.com/zV7rpxd.gif", "Planche – gainage");

        contacts.set(waId, { ...c, programSent: true });
      } catch (e) {
        console.error('Scheduler send program error:', e.message);
      }
    }

    // ------------------------------------------
    // 2) RELANCES : seulement si fenêtre fermée
    // ------------------------------------------
    const lastAnyTs = c.history && c.history.length ? c.history[c.history.length - 1].at : 0;
    const windowOpen = within24h(lastAnyTs);

    // suivi des jours consécutifs "fenêtre fermée"
    if (!windowOpen) {
      const today = Math.floor(now / 86400000); // jour absolu
      const lastMark = c._lastClosedDay ?? null;
      let daysClosed = c.daysClosed ?? 0;

      if (lastMark === null || lastMark !== today) {
        // on incrémente au 1er passage de la journée
        daysClosed += 1;
      }
      const stopAuto = daysClosed >= 7; // on stoppe au bout de 7 jours fermés d'affilée

      contacts.set(waId, {
        ...c,
        _lastClosedDay: today,
        daysClosed,
        stopAuto
      });
    } else {
      // Fenêtre rouverte → on remet les compteurs
      contacts.set(waId, {
        ...c,
        daysClosed: 0,
        stopAuto: false
      });
      continue; // si fenêtre ouverte, pas de template → l’IA répond
    }

    const c2 = contacts.get(waId);
    if (c2.stopAuto) continue; // on a dépassé 7 jours fermés → on arrête les relances auto

    // anti-spam relances : mini 6h entre 2 relances
    const lastReminderAt = c2.lastReminderAt || 0;
    if (now - lastReminderAt < 6 * 3600 * 1000) continue;

    // Temps depuis la dernière activité pour piloter l'escalade
    const hoursSince = (now - (lastAnyTs || 0)) / 3600000;
    const stage = c2.reminderStage || 0;

    // Templates disponibles :
    // - 'relance_fitmouv' (douce) — {{1}} = prénom
    // - 'reprise_fitmouv' (plus directe) — {{1}} = prénom
    // - 'fitmouv_relance_finale' (ultime) — {{1}} = prénom
    let toSend = null;

    // Escalade simple :
    // > 12h fermée  : relance_fitmouv (si pas encore envoyée)
    // > 48h fermée  : reprise_fitmouv (si pas encore envoyée)
    // > 6j fermée   : fitmouv_relance_finale (si pas encore envoyée)
    if (hoursSince >= 144 && stage < 3) {             // 6 jours
      toSend = 'fitmouv_relance_finale';
    } else if (hoursSince >= 48 && stage < 2) {       // 2 jours
      toSend = 'reprise_fitmouv';
    } else if (hoursSince >= 12 && stage < 1) {       // 12 heures
      toSend = 'relance_fitmouv';
    }

    if (toSend) {
      const components = [
        { type: 'body', parameters: [{ type: 'text', text: fname }] }
      ];

      try {
        // petit délai humain
        await new Promise(r => setTimeout(r, randDelayMs()));

        await sendTemplate(waId, toSend, components);
        contacts.set(waId, {
          ...c2,
          lastReminderAt: now,
          reminderStage: stage + 1
        });
        console.log(`Template ${toSend} envoyé à ${waId} (stage ${stage + 1})`);
      } catch (e) {
        console.error('Scheduler template error:', e.message);
      }
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

// Systeme.io → Webhook (depuis règle d’automatisation OU <form action=...>)
app.post('/sio-webhook', async (req, res) => {
  try {
    const secretFromQuery = pick(req.query.secret);
    if (!SIO_SECRET || secretFromQuery !== SIO_SECRET) {
      console.warn('SIO secret invalid');
      return res.status(200).json({ ok: false, reason: 'bad_secret' });
    }

    const payload = Object.keys(req.body || {}).length ? req.body : {};
    console.log('SIO raw payload:', payload);

    // Mapping minimal
    const phoneRaw = phoneSanitize(payload.phone || payload.telephone || payload.whatsapp || payload.phone_number);
    const phoneE164 = toE164FR(phoneRaw);
    if (!phoneE164) {
      console.warn('Webhook sans téléphone, ignore.');
      return res.json({ ok: true, stored: false, reason: 'no_phone' });
    }

    const lead = {
      source: 'systeme.io',
      createdAt: new Date().toISOString(),
      email:     pick(payload.email || payload.user_email),
      phone:     phoneE164,
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

    // Persist JSON léger
    const db = readClients();
    db[lead.phone] = { ...(db[lead.phone] || {}), ...lead };
    writeClients(db);
    console.log('Lead enregistré pour', lead.phone);

    // Mémoire RAM contact
    const waId = lead.phone.replace('+', ''); // Meta accepte + ou non, on unifie pour la Map
    const old = contacts.get(waId) || {};
    const c = {
      ...old,
      sioProfile: { ...(old.sioProfile || {}), ...lead },
      history: old.history || [],
      summary: old.summary || '',
      programScheduledAt: old.programScheduledAt || null,
      programSent: old.programSent || false,
      relances: old.relances || [],
      autoPaused: old.autoPaused || false,
      lastUserAt: old.lastUserAt || null,
      lastAssistantAt: old.lastAssistantAt || null,
      _welcomed: old._welcomed || false
    };
    contacts.set(waId, c);

    // Fenêtre ouverte ?
    const windowOpen = within24h(c.lastUserAt);
    if (!windowOpen) {
      // ENVOI TEMPLATE D’ACCUEIL (1 param: prénom si dispo, sinon vide)
      try {
        const bodyParams = [ lead.firstName || '' ]; // ajuste si ton template d’accueil n’a PAS de variable -> mets []
        await sendTemplate(lead.phone, TEMPLATES.welcome, TMPL_LANG, bodyParams);
        console.log(`Template ${TEMPLATES.welcome} envoyé à ${lead.phone}`);
        // Planifie relances auto (si pas de réponse)
        scheduleRelancesIfClosed(waId);
      } catch (e) {
        console.error(`Erreur envoi template accueil:`, e.message);
      }
    } else {
      // Fenêtre ouverte → IA enverra une réponse contextuelle lors du prochain échange
      console.log(`Fenêtre ouverte pour ${lead.phone}, pas de template.`);
    }

    // Redirection propre si formulaire HTML
    const acceptsHTML = (req.headers.accept || '').includes('text/html');
    if (acceptsHTML) return res.redirect(302, SIO_THANKS_URL);

    return res.json({ ok: true, stored: true });
  } catch (err) {
    console.error('SIO /sio-webhook error:', err);
    return res.json({ ok: true, stored: false, error: true });
  }
});

// Systeme.io → Profil JSON (si besoin d’un push complémentaire)
app.post('/sio', (req, res) => {
  try {
    const p = req.body || {};
    const phoneE164 = toE164FR((p.phone || p.telephone || ''));
    if (!phoneE164) return res.status(400).json({ ok: false, error: 'missing phone' });
    const waId = phoneE164.replace('+', '');

    const old = contacts.get(waId) || {};
    const profile = {
      firstname: p.firstname || p.first_name || old.firstname || '',
      lastname:  p.lastname || p.last_name || old.lastname || '',
      email:     p.email || old.email || '',
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

// Téléchargement média WhatsApp (vocaux)
async function downloadWhatsAppMedia(mediaId) {
  const meta1 = await fetch(`https://graph.facebook.com/v24.0/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }
  });
  if (!meta1.ok) throw new Error(`media meta ${meta1.status}: ${await meta1.text()}`);
  const { url } = await meta1.json();

  const fileRes = await fetch(url, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } });
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

    let c = contacts.get(waId) || { history: [], programSent: false, programScheduledAt: null, sioProfile: null, summary: '', relances: [], autoPaused: false };
    contacts.set(waId, c);

    await markAsRead(waId, msgId);

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
        await sendText('+' + waId, "Je n’ai pas réussi à comprendre le vocal. Tu peux réessayer en texte ?");
        return;
      }
    } else {
      await sendText('+' + waId, "Reçu. Dis-moi en texte ce que tu veux qu’on prépare pour toi.");
      return;
    }

    // Mémorise message utilisateur
    c = contacts.get(waId);
    c.history.push({ role: 'user', text: userText, at: now() });
    c.lastUserAt = now();

    // Fenêtre rouverte → on annule les relances planifiées
    if (Array.isArray(c.relances) && c.relances.some(r => !r.sent)) {
      c.relances = [];
      c.autoPaused = false;
      console.log(`Relances annulées pour ${waId} (fenêtre rouverte)`);
    }
    contacts.set(waId, c);

    // PREMIER CONTACT → welcome "humain" + planif programme (si pas encore fait)
    if (!c._welcomed) {
      const welcome =
        "Bonjour, ici l’équipe FitMouv.\n\n" +
        "Bonne nouvelle : tes coachs dédiés (sport et nutrition) s’occupent de toi. " +
        "On prépare ton programme personnalisé et on revient vers toi sous 24–48h pour l’ajuster ensemble.\n\n" +
        "Si tu as une contrainte (voyage, horaires, blessure, aliment à éviter…), dis-le ici.";
      await sendText('+' + waId, welcome);

      const dueAt = now() + randProgramDelayMs();
      contacts.set(waId, { ...c, _welcomed: true, programScheduledAt: dueAt });
      return;
    }

    // Échanges intermédiaires (IA)
    await sendText('+' + waId, "Bien noté, je te réponds dans quelques minutes.");
    await new Promise(r => setTimeout(r, randDelayMs()));

    const last30 = c.history.slice(-30).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text }));
    const mem = c.summary ? `Mémoire longue: ${c.summary}` : 'Pas de mémoire longue.';
    const reply = await openaiChat([{ role: 'user', content: mem }, ...last30]);

    await sendText('+' + waId, reply);

    // Mémorise réponse & MAJ résumé parfois
    c = contacts.get(waId);
    c.history.push({ role: 'assistant', text: reply, at: now() });
    c.lastAssistantAt = now();
    contacts.set(waId, c);
    updateLongSummary(waId).catch(e => console.error('updateLongSummary:', e.message));

  } catch (e) {
    console.error('Erreur /webhook:', e);
  }
});

// 13) START
app.listen(PORT, () => console.log(`🚀 Serveur FitMouv lancé sur ${PORT}`));
