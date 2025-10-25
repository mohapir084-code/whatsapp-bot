// =======================
// FitMouv WhatsApp Bot - FINAL
// =======================

// 1) BOOT EXPRESS EN PREMIER
const express = require('express');
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// 2) IMPORTS & HELPERS
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
// fetch compatible CJS (évite les conflits avec Node 22)
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// 3) ENV
const ACCESS_TOKEN       = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID    = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN       = process.env.VERIFY_TOKEN || 'fitmouv_verify_123';
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;
const SIO_ALLOWED_ORIGIN = process.env.SIO_ALLOWED_ORIGIN || 'https://pay.fitmouv.fr';
const SIO_SECRET         = process.env.SIO_SECRET || 'fitmouv_2025_secret_89HGsQ';
const SIO_THANKS_URL     = process.env.SIO_THANKS_URL || 'https://pay.fitmouv.fr/8cea436d';

const PORT                  = process.env.PORT || 10000;
const DELAY_MIN_SEC         = Number(process.env.DELAY_MIN_SEC || 60);
const DELAY_MAX_SEC         = Number(process.env.DELAY_MAX_SEC || 240);
const PROGRAM_DELAY_MIN_MIN = Number(process.env.PROGRAM_DELAY_MIN_MIN || 1200); // 20h
const PROGRAM_DELAY_MAX_MIN = Number(process.env.PROGRAM_DELAY_MAX_MIN || 1380); // 23h

// 4) CORS minimal (pour POST direct depuis SIO si jamais)
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
// contacts: waId -> state
// state: {
//   sioProfile, history:[{role,text,at}], summary,
//   programScheduledAt, programSent,
//   _welcomed, welcomeSentAt,
//   lastInboundAt, lastOutboundAt,
//   relanceStage (0..3), relanceSchedule:[t1,t2,t3],
//   programReadyNoticeSent, pendingProgramText,
//   lastWindowOpenAt, weeklyEligible:boolean
// }
const contacts = new Map();

const DATA_DIR = path.join('/tmp');
const CLIENTS_PATH = path.join(DATA_DIR, 'clients.json'); // stockage leads SIO (simple)
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
function pick(v, fb = '') { return (v === null || v === undefined) ? fb : String(v).trim(); }
function phoneSanitize(p) { return pick(p).replace(/\s+/g, ''); }

function nowMs() { return Date.now(); }

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

// “Fenêtre ouverte” WhatsApp = dernier message USER < 24h
function isWindowOpen(state) {
  if (!state?.lastInboundAt) return false;
  return (nowMs() - state.lastInboundAt) < (24 * 60 * 60 * 1000);
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
  const resp = await waPost(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body, preview_url: false }
  });
  return resp;
}
async function sendImage(to, link, caption = '') {
  return waPost(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { link, caption }
  });
}

// TEMPLATES (toujours “french”)
async function sendTemplate(to, templateName, components = []) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'french' },
      components
    }
  };
  try {
    return await waPost(`${PHONE_NUMBER_ID}/messages`, payload);
  } catch (e) {
    console.error(`Template "${templateName}" FAIL: ${e.message}`);
    throw e;
  }
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

// 8) OPENAI HELPERS
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

// 11) ASSETS EXOS
const EXOS_MEDIA = {
  pushups: "https://i.imgur.com/0hYhD6j.gif",
  squats:  "https://i.imgur.com/7q5E2iB.gif",
  plank:   "https://i.imgur.com/zV7rpxd.gif",
};

// 12) SCHEDULER (1/min)
setInterval(async () => {
  const t = nowMs();

  for (const [waId, c] of contacts) {
    // a) Programme prêt (dans notre POC: quand l’horaire arrive)
    if (!c.programSent && c.programScheduledAt && c.programScheduledAt <= t) {
      try {
        // Si fenêtre OUVERTE → envoi direct (IA style texte + images)
        if (isWindowOpen(c)) {
          const profile = { ...(c.sioProfile || {}), _summary: c.summary || '' };
          const baseText = await generatePrograms(profile, "Prépare le programme sport + nutrition personnalisé.");

          const delayBeforeSend = randDelayMs();
          await new Promise(r => setTimeout(r, delayBeforeSend));

          await sendText(waId, `🗓️ Comme promis, voici ton programme personnalisé (sport + nutrition) :\n\n${baseText}`);
          await sendImage(waId, EXOS_MEDIA.pushups, "Pompes – exécution");
          await sendImage(waId, EXOS_MEDIA.squats,  "Squats – exécution");
          await sendImage(waId, EXOS_MEDIA.plank,   "Planche – gainage");

          contacts.set(waId, { ...c, programSent: true, lastOutboundAt: t });
        } else {
          // Fenêtre FERMÉE → template “programme prêt”
          if (!c.programReadyNoticeSent) {
            await sendTemplate(waId, 'programme_pret_fitmouv', []);
            contacts.set(waId, {
              ...c,
              programReadyNoticeSent: true,
              // on prépare le contenu pour l’envoyer dès qu’il répond
              pendingProgramText: '__TO_GENERATE__',
              lastOutboundAt: t
            });
          }
        }
      } catch (e) {
        console.error('Scheduler program send error:', e.message);
      }
    }

    // b) Relances automatiques (si fenêtre fermée & aucune réponse)
    // Stages: 0 -> rien envoyé; 1 -> 24h; 2 -> 72h; 3 -> 7j (final)
    if (!isWindowOpen(c)) {
      if (c.relanceSchedule && c.relanceStage < 3) {
        const due = c.relanceSchedule[c.relanceStage]; // timestamps [t24, t72, t168]
        if (due && t >= due) {
          try {
            if (c.relanceStage === 0) {
              await sendTemplate(waId, 'relance_fitmouv', []);
            } else if (c.relanceStage === 1) {
              await sendTemplate(waId, 'reprise_fitmouv', []);
            } else if (c.relanceStage === 2) {
              await sendTemplate(waId, 'fitmouv_relance_finale', []);
            }
            contacts.set(waId, { ...c, relanceStage: c.relanceStage + 1, lastOutboundAt: t });
          } catch (e) {
            console.error('Relance error:', e.message);
          }
        }
      }
    }

    // c) Check hebdo (OPTIONNEL): uniquement si fenêtre a été ouverte récemment (≤ 3 jours)
    // et seulement si elle est fermée au moment du check
    if (c.weeklyEligible && c.nextWeeklyCheckAt && t >= c.nextWeeklyCheckAt) {
      const hadRecentOpen = c.lastInboundAt && (t - c.lastInboundAt) <= (3 * 24 * 60 * 60 * 1000);
      if (!isWindowOpen(c) && hadRecentOpen) {
        try {
          await sendTemplate(waId, 'fitmouv_check_contact', []);
        } catch (e) {
          console.error('Weekly check error:', e.message);
        }
      }
      // planifie la prochaine vérification une semaine plus tard, mais garde l’éligibilité telle quelle
      contacts.set(waId, { ...c, nextWeeklyCheckAt: t + (7 * 24 * 60 * 60 * 1000) });
    }
  }
}, 60 * 1000);

// 13) ENDPOINTS

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

    if (!lead.phone) {
      console.warn('SIO webhook sans téléphone, on ignore.');
      return res.json({ ok: true, stored: false, reason: 'no_phone' });
    }

    // stockage léger JSON (lead)
    const db = readClients();
    db[lead.phone] = { ...(db[lead.phone] || {}), ...lead };
    writeClients(db);
    console.log('Lead enregistré pour', lead.phone);

    // état en RAM pour orchestration
    let c = contacts.get(lead.phone) || {};
    const t = nowMs();

    // Envoi TEMPLATE de bienvenue immédiat (fenêtre fermée)
    try {
      await sendTemplate(lead.phone, 'fitmouv_welcome_v1', []);
    } catch (e) {
      console.error('Welcome template error:', e.message);
    }

    // relances programmées: 24h, 72h, 7j (si pas de réponse)
    const t24  = t + (24 * 60 * 60 * 1000);
    const t72  = t + (72 * 60 * 60 * 1000);
    const t168 = t + (168 * 60 * 60 * 1000); // 7 jours

    c = {
      ...c,
      sioProfile: {
        ...((c && c.sioProfile) || {}),
        firstname: lead.firstName,
        lastname:  lead.lastName,
        email:     lead.email,
        phone:     lead.phone,
        objectif:  lead.objectif,
        niveau:    lead.niveau,
        sexe:      lead.sexe,
        age:       lead.age,
        poids:     lead.poids,
        taille:    lead.taille,
        disponibilites: lead.disponibilites,
        materiel:  lead.materiel,
        patho:     lead.patho,
        preferences: lead.preferences,
      },
      history: c.history || [],
      summary: c.summary || '',

      _welcomed: true,
      welcomeSentAt: t,

      lastOutboundAt: t,
      // si le client répond, on resettra le relanceStage à 0
      relanceStage: 0,
      relanceSchedule: [t24, t72, t168],

      // Planification programme 20–23h plus tard
      programScheduledAt: c.programScheduledAt || (t + randProgramDelayMs()),
      programSent: c.programSent || false,
      programReadyNoticeSent: c.programReadyNoticeSent || false,
      pendingProgramText: c.pendingProgramText || null,

      // Hebdo: on activera weeklyEligible quand il y aura une vraie fenêtre ouverte
      weeklyEligible: c.weeklyEligible || false,
      nextWeeklyCheckAt: c.nextWeeklyCheckAt || null
    };

    contacts.set(lead.phone, c);

    // Redirection propre si appel via <form>
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

    let c = contacts.get(waId) || {
      history: [],
      programSent: false,
      programScheduledAt: null,
      sioProfile: null,
      summary: '',
      relanceStage: 0
    };
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
        await sendText(waId, "J’ai pas réussi à comprendre le vocal 😅 Tu peux réessayer en texte ?");
        return;
      }
    } else {
      await sendText(waId, "Reçu ✅ Dis-moi en texte ce que tu veux qu’on prépare pour toi 💬");
      return;
    }

    // Mémorise message et ouvre la fenêtre
    const t = nowMs();
    c = contacts.get(waId);
    c.history.push({ role: 'user', text: userText, at: t });
    c.lastInboundAt = t;
    c.lastWindowOpenAt = t;
    c.weeklyEligible = true; // il y a eu une fenêtre ouverte récemment
    if (!c.nextWeeklyCheckAt) c.nextWeeklyCheckAt = t + (7 * 24 * 60 * 60 * 1000);

    // Reset relances si le client vient de répondre
    c.relanceStage = 0;
    c.relanceSchedule = null;

    // Si on avait un programme prêt mais bloqué (fenêtre fermée), envoi maintenant
    if (c.pendingProgramText === '__TO_GENERATE__' && !c.programSent) {
      try {
        const profile = { ...(c.sioProfile || {}), _summary: c.summary || '' };
        const baseText = await generatePrograms(profile, "Envoie maintenant le programme (fenêtre ré-ouverte).");
        await sendText(waId, `🗓️ Voici ton programme personnalisé (sport + nutrition) :\n\n${baseText}`);
        await sendImage(waId, EXOS_MEDIA.pushups, "Pompes – exécution");
        await sendImage(waId, EXOS_MEDIA.squats,  "Squats – exécution");
        await sendImage(waId, EXOS_MEDIA.plank,   "Planche – gainage");

        c.programSent = true;
        c.pendingProgramText = null;
        c.lastOutboundAt = nowMs();
        contacts.set(waId, c);
        return;
      } catch (e) {
        console.error('Envoi programme après réouverture erreur:', e.message);
      }
    }

    // Si le client ré-ouvre après une longue absence, IA demande brièvement l’explication et s’adapte
    const longAbsence = c.welcomeSentAt && (t - (c.lastOutboundAt || c.welcomeSentAt)) > (72 * 60 * 60 * 1000); // >72h
    const preface = longAbsence
      ? "Contente de te revoir ! Tu veux me dire en 2 mots ce qui t’a bloqué ? On s’adapte 👇\n\n"
      : "";

    // Réponse IA (fenêtre ouverte)
    const last30 = c.history.slice(-30).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text }));
    const mem = c.summary ? `Mémoire longue: ${c.summary}` : 'Pas de mémoire longue.';
    const sys = "Tu es FitMouv (FR), coach sport + nutrition. Style chill, empathique, précis. Pose max 1-2 questions utiles, puis propose un micro-plan d’action concret. Rappelle qu’il/elle a 2 coachs dédiés.";

    const reply = await openaiChat([
      { role: 'system', content: sys },
      { role: 'user', content: mem },
      ...last30
    ]);

    await sendText(waId, preface + reply);

    // Mémorise réponse & MAJ résumé parfois
    c = contacts.get(waId);
    c.history.push({ role: 'assistant', text: preface + reply, at: nowMs() });
    c.lastOutboundAt = nowMs();
    contacts.set(waId, c);
    updateLongSummary(waId).catch(e => console.error('updateLongSummary:', e.message));

  } catch (e) {
    console.error('Erreur /webhook:', e);
  }
});

// 14) LANCEMENT
app.listen(PORT, () => console.log(`🚀 FitMouv bot lancé sur ${PORT}`));
