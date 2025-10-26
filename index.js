// =======================
// FitMouv WhatsApp Bot
// Index.js — FULL (A/4)
// =======================

/* 1) BOOT EXPRESS */
const express = require('express');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/* 2) IMPORTS & HELPERS */
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

/* 3) ENV */
const ACCESS_TOKEN       = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID    = process.env.PHONE_NUMBER_ID;
const WABA_ID            = process.env.WABA_ID || '';
const VERIFY_TOKEN       = process.env.VERIFY_TOKEN || 'fitmouv_verify_123';
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY || '';
const SIO_ALLOWED_ORIGIN = process.env.SIO_ALLOWED_ORIGIN || 'https://pay.fitmouv.fr';
const SIO_SECRET         = process.env.SIO_SECRET || 'fitmouv_2025_secret_89HGsQ';
const SIO_THANKS_URL     = process.env.SIO_THANKS_URL || 'https://pay.fitmouv.fr/8cea436d';
const ADMIN_SECRET       = process.env.ADMIN_SECRET || 'fitmouv_admin_please_change';

const PORT                  = process.env.PORT || 10000;
const DELAY_MIN_SEC         = Number(process.env.DELAY_MIN_SEC || 60);
const DELAY_MAX_SEC         = Number(process.env.DELAY_MAX_SEC || 240);
const PROGRAM_DELAY_MIN_MIN = Number(process.env.PROGRAM_DELAY_MIN_MIN || 1200); // 20h
const PROGRAM_DELAY_MAX_MIN = Number(process.env.PROGRAM_DELAY_MAX_MIN || 1380); // 23h

/* 4) CORS minimal */
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

/* 5) STOCKAGE (RAM + /tmp/clients.json) */
const contacts = new Map(); // waId -> { sioProfile, history:[{role,text,at}], summary, programScheduledAt, programSent, _welcomed, lastUserAt, lastAssistantAt, relanceStage, lastRelanceAt, autoPaused }
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

/* 6) UTILS */
function pick(v, fallback = '') { return (v === null || v === undefined) ? fallback : String(v).trim(); }
function phoneSanitize(p) { return pick(p).replace(/\s+/g, ''); }

// 06/07 -> e164 +33…
function toE164FR(any) {
  let s = (any || '').toString().trim();
  if (!s) return s;
  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('+')) return s; // déjà E.164
  if (s.startsWith('00')) return '+' + s.slice(2);
  if (/^0\d{9}$/.test(s)) return '+33' + s.slice(1);
  if (/^\d{10,15}$/.test(s)) return '+' + s;
  return s;
}

const ONE_MIN  = 60 * 1000;
const ONE_HOUR = 60 * ONE_MIN;
const ONE_DAY  = 24 * ONE_HOUR;

// Silence nocturne Paris 22h–7h
function isQuietHoursParis(d = new Date()) {
  const h = d.getHours();
  return (h >= 22 || h < 7);
}
function now() { return Date.now(); }
function within24h(ts) { return ts && (now() - ts) <= ONE_DAY; }
function randDelayMs() {
  const min = Math.max(5, DELAY_MIN_SEC);
  const max = Math.max(min, DELAY_MAX_SEC);
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
}
function randProgramDelayMs() {
  const min = PROGRAM_DELAY_MIN_MIN;
  const max = PROGRAM_DELAY_MAX_MIN;
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 60 * 1000;
}
function firstNameFor(waId) {
  const c = contacts.get(waId) || {};
  const p = c.sioProfile || {};
  return (p.firstName || p.firstname || p.FirstName || '').trim();
}
function isWindowOpen(waId) {
  const c = contacts.get(waId);
  if (!c || !c.lastUserAt) return false;
  return within24h(c.lastUserAt);
}
// =======================
// Index.js — FULL (B/4)
// =======================

/* 7) WHATSAPP HELPERS */
async function waPost(pathURL, payload) {
  const url = `https://graph.facebook.com/v24.0/${pathURL}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const txt = await r.text();
  if (!r.ok) {
    console.error('WA POST ERROR', r.status, txt);
    throw new Error(`Meta POST ${pathURL} -> ${r.status}: ${txt}`);
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

// Envoi de template (cascade de langues)
async function sendTemplate(to, templateName, components = [], langPref = 'fr') {
  const candidates = [langPref, 'fr', 'fr_FR', 'french'].filter(Boolean);
  let lastErr = null;
  for (const code of candidates) {
    try {
      const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: { name: templateName, language: { code }, components }
      };
      const res = await waPost(`${PHONE_NUMBER_ID}/messages`, payload);
      console.log(`✅ Template "${templateName}" envoyé à ${to} avec la langue "${code}"`);
      return res;
    } catch (e) {
      console.error(`❌ Echec template "${templateName}" (${to}) avec code "${code}":`, e.message);
      lastErr = e;
      continue;
    }
  }
  throw lastErr || new Error('sendTemplate: all languages failed');
}

/* 8) OPENAI HELPERS */
async function openaiChat(messages, temperature = 0.7) {
  if (!OPENAI_API_KEY) return '';
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

/* 9) GÉNÉRATION PROGRAMMES */
async function generatePrograms(profile, userRequestText) {
  const sys = [
    'Tu es FitMouv, coach SPORT + NUTRITION. Français. Ton chill, clair, bienveillant.',
    'Structure les réponses avec emojis, quantités réalistes, et sections nettes.',
    'Tiens compte de: âge/sexe/poids/objectif/temps dispo/lieu/matériel/diet/allergies/dislikes.',
    'Objectif: plan réaliste, tenable, axé adhérence.',
    "Interdit : mise en gras avec des astérisques."
  ].join('\n');

  const longSummary = profile._summary || '';
  const user = `
Résumé client:
${longSummary || '(pas de résumé long)'}

Profil:
${JSON.stringify(profile, null, 2)}

Demande: "${userRequestText || 'Programme complet.'}"

Donne en sortie:
1) Objectif & approche (2-4 lignes)
2) Nutrition (plan 15 jours): détail J1-J3 + rotation (quantités indicatives)
3) Sport (plan 15 jours): 3 jours-type (5-6 exos/jour, échauffement/force/cardio/core/mobilité)
4) Conseils d’adhérence (3-5 bullets)
  `.trim();

  return openaiChat([
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ]);
}

/* 10) RÉSUMÉ LONG PONCTUEL */
async function updateLongSummary(waId) {
  const c = contacts.get(waId);
  if (!c || !c.history) return;
  if ((c.history.length || 0) % 12 !== 0) return;

  const transcript = c.history.map(h => `${h.role.toUpperCase()}: ${h.text}`).join('\n').slice(-6000);
  const prompt = 'Résume la conversation client-coach FitMouv en mémoire longue compacte (faits utiles seulement).';
  const summary = await openaiChat([{ role: 'system', content: prompt }, { role: 'user', content: transcript }], 0.3);

  contacts.set(waId, { ...c, summary });
}

/* 11) VISUELS EXOS */
const EXOS_MEDIA = {
  pushups: "https://i.imgur.com/0hYhD6j.gif",
  squats:  "https://i.imgur.com/7q5E2iB.gif",
  plank:   "https://i.imgur.com/zV7rpxd.gif",
};
// =======================
// Index.js — FULL (C/4)
// =======================

/* 12) ADMIN — Helpers + Auth */
function lastMsgPreview(history = [], n = 1) {
  const h = history.slice(-n);
  return h.map(x => `[${x.role}] ${String(x.text || '').slice(0,120)}`).join('\n');
}
function adminAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return res.status(401).set('WWW-Authenticate','Basic').send('Auth required');
    const base64 = h.slice('Basic '.length).trim();
    const [user, pass] = Buffer.from(base64, 'base64').toString('utf8').split(':');
    if (user !== 'admin' || pass !== ADMIN_SECRET) return res.status(403).send('Forbidden');
    return next();
  } catch { return res.status(401).send('Auth required'); }
}

/* 13) ADMIN — API utilisée par admin.html (version unique, clean) */

// Liste contacts (RAM uniquement)
app.get('/admin/api/contacts', adminAuth, (req, res) => {
  const list = [];
  for (const [waId, c] of contacts) {
    list.push({
      waId,
      firstname:  c?.sioProfile?.firstname || c?.sioProfile?.firstName || '',
      lastname:   c?.sioProfile?.lastname  || c?.sioProfile?.lastName  || '',
      phone:      c?.sioProfile?.phone     || waId,
      windowOpen: isWindowOpen(waId),
      autoPaused: !!c?.autoPaused,
      programSent: !!c?.programSent,
      relanceStage: c?.relanceStage ?? 0,
      lastRelanceAt: c?.lastRelanceAt || null,
      lastUserAt: c?.lastUserAt || null,
      lastPreview: lastMsgPreview(c?.history || [], 1),
    });
  }
  res.json({ ok: true, contacts: list });
});

// Historique d’un contact
app.get('/admin/api/chat/:waId', adminAuth, (req, res) => {
  const waId = String(req.params.waId || '').trim();
  const c = contacts.get(waId);
  if (!c) return res.status(404).json({ ok:false, error:'not_found' });
  res.json({
    ok:true,
    profile: c.sioProfile || {},
    history: c.history || [],
    windowOpen: isWindowOpen(waId),
    autoPaused: !!c.autoPaused,
  });
});

// Envoi d’un texte manuel
app.post('/admin/api/send-text', adminAuth, async (req, res) => {
  try {
    const waId = String(req.body.waId || '').trim();
    const text = String(req.body.text || '').trim();
    if (!waId || !text) return res.status(400).json({ ok:false, error:'missing params' });

    await sendText(waId, text);

    const c = contacts.get(waId) || { history: [] };
    c.history = c.history || [];
    c.history.push({ role: 'assistant', text, at: Date.now(), by: 'admin' });
    contacts.set(waId, c);

    res.json({ ok:true });
  } catch (e) {
    console.error('admin send-text error:', e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Envoi d’un template manuel
app.post('/admin/api/send-template', adminAuth, async (req, res) => {
  try {
    const waId     = String(req.body.waId || '').trim();
    const template = String(req.body.template || '').trim();
    const lang     = String(req.body.lang || 'fr').trim();
    if (!waId || !template) return res.status(400).json({ ok:false, error:'missing params' });

    const prenom = firstNameFor(waId) || '👋';
    const comps = [{ type:'body', parameters:[{ type:'text', text: prenom }] }];

    await sendTemplate(waId, template, comps, lang);

    const c = contacts.get(waId) || { history: [] };
    c.history = c.history || [];
    c.history.push({ role:'assistant', text:`[TEMPLATE ${template} ${lang}] ${prenom}`, at: Date.now(), by:'admin' });
    contacts.set(waId, c);

    res.json({ ok:true });
  } catch (e) {
    console.error('admin send-template error:', e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Pause/reprise auto-relances
app.post('/admin/api/pause', adminAuth, (req,res) => {
  const waId = String(req.body.waId || '').trim();
  const paused = !!req.body.paused;
  const c = contacts.get(waId);
  if (!c) return res.status(404).json({ ok:false, error:'not_found' });
  contacts.set(waId, { ...c, autoPaused: paused });
  res.json({ ok:true, autoPaused: paused });
});

// Page Admin (statique) — SANS auth ici (l’auth est sur /admin/api/*)
app.get('/admin', (_req,res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

/* 15) SCHEDULER PROGRAMME (envoi différé) */
setInterval(async () => {
  const nowts = now();
  for (const [waId, c] of contacts) {
    if (!c.programSent && c.programScheduledAt && c.programScheduledAt <= nowts) {
      try {
        const profile = { ...(c.sioProfile || {}), _summary: c.summary || '' };
        const baseText = await generatePrograms(profile, 'Prépare le programme sport + nutrition personnalisé.');

        const delayBeforeSend = randDelayMs();
        await new Promise(r => setTimeout(r, delayBeforeSend));

        await sendText(waId, `🗓️ Comme promis, voici ton programme personnalisé (sport + nutrition) :\n\n${baseText}`);
        await sendImage(waId, EXOS_MEDIA.pushups, 'Pompes – exécution');
        await sendImage(waId, EXOS_MEDIA.squats,  'Squats – exécution');
        await sendImage(waId, EXOS_MEDIA.plank,   'Planche – gainage');

        contacts.set(waId, { ...c, programSent: true });
      } catch (e) { console.error('Scheduler send error:', e.message); }
    }
  }
}, 60 * 1000);

/* 16) RELANCES AUTOMATIQUES (fenêtre FERMÉE uniquement) */
const RELANCE_TEMPLATES = ['relance_fitmouv', 'reprise_fitmouv', 'fitmouv_relance_finale']; // ordre
setInterval(async () => {
  try {
    for (const [waId, st] of contacts) {
      const c = contacts.get(waId) || {};
      const stage = c.relanceStage || 0;
      if (stage >= RELANCE_TEMPLATES.length) continue;               // plus de relances auto
      if (c.autoPaused) continue;                                    // mis en pause par l’admin
      if (isQuietHoursParis()) continue;                             // 22h-7h OFF
      if (isWindowOpen(waId)) continue;                              // fenêtre ouverte => jamais de template
      if (c.lastRelanceAt && (now() - c.lastRelanceAt) < (6 * ONE_HOUR)) continue; // cadence 6h

      const prenom = firstNameFor(waId) || '👋';
      const components = [{ type: 'body', parameters: [{ type: 'text', text: prenom }] }];

      const tpl = RELANCE_TEMPLATES[stage];
      try {
        await sendTemplate(waId, tpl, components, 'fr');
        contacts.set(waId, { ...c, relanceStage: stage + 1, lastRelanceAt: now() });
        console.log(`Relance envoyée à ${waId} → étape ${stage} (${tpl})`);
      } catch (e) {
        console.error(`Relance échec ${waId} étape ${stage} (${tpl}) :`, e.message);
      }
    }
  } catch (e) { console.error('Relance scheduler error:', e.message); }
}, 15 * ONE_MIN);
// =======================
// Index.js — FULL (D/4)
// =======================

/* 17) HEALTH */
app.get('/', (_req, res) => res.send('FitMouv webhook OK'));

/* 18) VERIFY WEBHOOK META (GET) */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* 19) SIO WEBHOOK (form -> Bot) */
app.post('/sio-webhook', async (req, res) => {
  try {
    const secretFromQuery = pick(req.query.secret);
    if (!SIO_SECRET || secretFromQuery !== SIO_SECRET) {
      console.warn('SIO secret invalid');
      return res.status(200).json({ ok: false, reason: 'bad_secret' });
    }
    const payload = Object.keys(req.body || {}).length ? req.body : {};
    console.log('SIO raw payload:', payload);

    const phoneRaw = phoneSanitize(payload.phone || payload.telephone || payload.whatsapp || payload.phone_number);
    const phoneE164 = toE164FR(phoneRaw);
    if (!phoneE164) {
      console.warn('SIO webhook sans téléphone');
      return res.json({ ok: true, stored: false, reason: 'no_phone' });
    }

    const lead = {
      source: 'systeme.io',
      createdAt: new Date().toISOString(),
      email:     pick(payload.email || payload.user_email),
      phone:     phoneE164.replace(/^\+/, ''), // waId sans +
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

    const db = readClients();
    db[lead.phone] = { ...(db[lead.phone] || {}), ...lead };
    writeClients(db);
    console.log('Lead enregistré pour', lead.phone);

    // Template welcome immédiat (fenêtre fermée par définition)
    const prenom = lead.firstName || '👋';
    const components = [{ type: 'body', parameters: [{ type: 'text', text: prenom }] }];
    try {
      await sendTemplate(lead.phone, 'fitmouv_welcome', components, 'fr');
    } catch (e) {
      console.error('Welcome template error:', e.message);
    }

    // Etat mémoire minimal
    const old = contacts.get(lead.phone) || {};
    contacts.set(lead.phone, {
      ...old,
      sioProfile: {
        firstname: lead.firstName,
        lastname:  lead.lastName,
        email:     lead.email,
        phone:     lead.phone,
      },
      history: old.history || [],
      summary: old.summary || '',
      programScheduledAt: old.programScheduledAt || (now() + randProgramDelayMs()),
      programSent: old.programSent || false,
      lastUserAt: old.lastUserAt || 0,
      relanceStage: 0,
      lastRelanceAt: null,
      autoPaused: false
    });

    // Si formulaire HTML (navigateur), redirige vers page merci
    const acceptsHTML = (req.headers.accept || '').includes('text/html');
    if (acceptsHTML) return res.redirect(302, SIO_THANKS_URL);

    return res.json({ ok: true, stored: true });
  } catch (err) {
    console.error('SIO /sio-webhook error:', err);
    return res.json({ ok: true, stored: false, error: true });
  }
});

/* 20) ENDPOINT SIO (profil JSON push optionnel) */
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
    };
    contacts.set(waId, { ...old, sioProfile: profile, history: old.history || [], summary: old.summary || '', programScheduledAt: old.programScheduledAt || null, programSent: old.programSent || false });
    return res.json({ ok: true });
  } catch (e) {
    console.error('/sio error:', e);
    return res.status(500).json({ ok: false });
  }
});

/* 21) DOWNLOAD MEDIA (vocaux) */
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

/* 22) WEBHOOK META (messages entrants) */
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

    let c = contacts.get(waId) || { history: [], programSent: false, programScheduledAt: null, sioProfile: null, summary: '', relanceStage: 0, lastRelanceAt: null, autoPaused: false };
    contacts.set(waId, c);

    await markAsRead(waId, msgId);

    // Silence nocturne: on enregistre seulement, pas de réponse immédiate
    if (isQuietHoursParis()) {
      c.lastUserAt = now();
      c.history.push({ role: 'user', text: '[Message reçu pendant la nuit]', at: Date.now() });
      contacts.set(waId, c);
      return;
    }

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

    // Mise à jour état + history
    c = contacts.get(waId);
    c.history.push({ role: 'user', text: userText, at: Date.now() });
    c.lastUserAt = now();
    contacts.set(waId, c);

    // Si premier contact → welcome IA + planif programme
    if (!c._welcomed) {
      const welcome = "Hello, ici l’équipe FitMouv !\nBonne nouvelle : tes coachs t’ont pris(e) en charge. On prépare ton programme personnalisé et on revient sous 24–48h pour l’ajuster avec toi.\nSi tu as des contraintes particulières (voyage, horaires, blessures…), dis-le ici.";
      await sendText(waId, welcome);
      const dueAt = Date.now() + randProgramDelayMs();
      contacts.set(waId, { ...c, _welcomed: true, programScheduledAt: dueAt });
      return;
    }

    // Si la fenêtre est OUVERTE -> IA répond (pas de template)
    const mem = c.summary ? `Mémoire longue: ${c.summary}` : 'Pas de mémoire longue.';
    const sys = "Tu es FitMouv (FR), coach sport + nutrition. Style chill, empathique, précis. PAS DE gras ** avec des astérisques. Si le programme n’est pas encore envoyé, reste en conversation : clarifie 1–2 points utiles max.";
    const last30 = c.history.slice(-30).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text }));
    const reply = await openaiChat([{ role: 'system', content: sys }, { role: 'user', content: mem }, ...last30]);

    await sendText(waId, reply);

    c = contacts.get(waId);
    c.history.push({ role: 'assistant', text: reply, at: Date.now() });
    contacts.set(waId, c);
    updateLongSummary(waId).catch(e => console.error('updateLongSummary:', e.message));

  } catch (e) { console.error('Erreur /webhook:', e); }
});

/* 23) START */
app.listen(PORT, () => console.log(`🚀 Serveur FitMouv lancé sur ${PORT}`));
