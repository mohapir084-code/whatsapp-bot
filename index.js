// ===== fetch compatible CJS =====
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const FormData = require('form-data');
const express = require('express');
const bodyParser = require('body-parser');

const ACCESS_TOKEN    = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;

const PORT                   = process.env.PORT || 10000;
const DELAY_MIN_SEC          = Number(process.env.DELAY_MIN_SEC || 60);
const DELAY_MAX_SEC          = Number(process.env.DELAY_MAX_SEC || 240);
const PROGRAM_DELAY_MIN_MIN  = Number(process.env.PROGRAM_DELAY_MIN_MIN || 1200); // 20h
const PROGRAM_DELAY_MAX_MIN  = Number(process.env.PROGRAM_DELAY_MAX_MIN || 1380); // 23h

// ===== Mémoire en RAM (POC) =====
// contacts: waId -> { sioProfile, history:[{role,text,at}], summary:string, programScheduledAt:number|null, programSent:boolean }
const contacts = new Map();

// ------- à mettre en haut si pas déjà présent -------
const fs = require('fs');
const path = require('path');

// body parsers (JSON + form-urlencoded)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ------- helpers stockage JSON léger -------
const DATA_DIR = path.join('/tmp'); // FS éphémère sur Render (OK pour POC)
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
  // laisse quasi tel quel, on enlève juste espaces
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

// ------- ROUTE WEBHOOK SYSTEME.IO -------
// Systeme.io appellera:  POST /sio-webhook?secret=xxxxx
app.post('/sio-webhook', async (req, res) => {
  try {
    // 1) sécurité: secret en query
    const secretFromQuery = pick(req.query.secret);
    const expected = pick(process.env.SIO_SECRET);
    if (!expected || secretFromQuery !== expected) {
      console.warn('SIO secret invalid');
      return res.status(403).json({ ok: false });
    }

    // 2) payload: Systeme.io peut envoyer en JSON ou form-urlencoded
    const payload = Object.keys(req.body || {}).length ? req.body : {};
    console.log('SIO raw payload:', payload);

    // 3) mappage champs (adapte aux noms exacts de TON formulaire)
    // -> mets ici les "name" de tes inputs Systeme.io
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
      // ajoute ici si tu as d’autres champs…
      raw: payload // on garde brut pour debug
    };

    if (!lead.phone) {
      console.warn('SIO webhook sans téléphone, on ignore.');
      // On répond quand même 200 à Systeme.io
      return res.json({ ok: true, stored: false, reason: 'no_phone' });
    }

    // 4) stockage JSON léger (clé = téléphone)
    const db = readClients();
    db[lead.phone] = { ...(db[lead.phone] || {}), ...lead };
    writeClients(db);
    console.log('Lead enregistré pour', lead.phone);

    // 5) message de bienvenue automatique WhatsApp
    // (style humain, prénom, et "attends nos coachs")
    const prenom = lead.firstName || '👋';
    const bienvenue =
`Salut ${prenom} ! 🙌

Merci pour ton inscription. On a bien reçu toutes tes infos — on te prépare un programme **vraiment personnalisé** (sport + nutrition).
🕒 D’ici **24–48h**, tes coachs te reviennent pour te le présenter et l’ajuster avec toi. 

Si tu as une **contrainte urgente** (blessure, dispo qui change, aliment à éviter), tu peux me l’écrire ici.  
Sinon, garde juste un œil sur WhatsApp : on s’occupe de toi. 💪`;

    await sendWhatsAppText(lead.phone, bienvenue);

    return res.json({ ok: true, stored: true });
  } catch (err) {
    console.error('SIO /sio-webhook error:', err);
    // Toujours répondre 200 à Systeme.io pour éviter les retries en boucle
    return res.json({ ok: true, stored: false, error: true });
  }
});
// Exemples de médias (remplace par tes liens hébergés)
const EXOS_MEDIA = {
  pushups: "https://i.imgur.com/0hYhD6j.gif",
  squats: "https://i.imgur.com/7q5E2iB.gif",
  plank: "https://i.imgur.com/zV7rpxd.gif",
};

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
3) 🏋️‍♂️ Sport (plan 15 jours): 3 JOURS-TYPE détaillés avec 5-6 exos/jour (échauffement, force, cardio/HIIT, core, mobilité). Indique les exos par NOMS CLAIRS (ex: Pompes, Squats, Planche).
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
  if ((c.history.length || 0) % 12 !== 0) return; // résume tous les ~12 messages

  const transcript = c.history.map(h => `${h.role.toUpperCase()}: ${h.text}`).join('\n');
  const prompt = `
Tu es un assistant qui résume une conversation client-coach FitMouv.
Fais un résumé persistant (mémoire longue) très compact mais utile pour le contexte futur.
`.trim();

  const summary = await openaiChat([
    { role: 'system', content: prompt },
    { role: 'user', content: transcript.slice(-6000) }
  ], 0.3);

  contacts.set(waId, { ...c, summary });
}

// ===== Délai humanisé =====
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

// ===== Scheduler simple (POC) : envoie les programmes quand l’heure est venue =====
setInterval(async () => {
  const now = Date.now();
  for (const [waId, c] of contacts) {
    if (!c.programSent && c.programScheduledAt && c.programScheduledAt <= now) {
      try {
        // Génère programme si pas déjà prêt
        let profile = c.sioProfile || {};
        profile._summary = c.summary || '';

        const baseText = await generatePrograms(profile, "Prépare le programme sport + nutrition personnalisé.");
        const delayBeforeSend = randDelayMs();
        await new Promise(r => setTimeout(r, delayBeforeSend));

        await sendText(waId, `🗓️ Comme promis, voici ton programme personnalisé (sport + nutrition) :\n\n${baseText}`);
        await sendImage(waId, EXOS_MEDIA.pushups, "Pompes – exécution");
        await sendImage(waId, EXOS_MEDIA.squats, "Squats – exécution");
        await sendImage(waId, EXOS_MEDIA.plank, "Planche – gainage");

        contacts.set(waId, { ...c, programSent: true });
      } catch (e) {
        console.error('Scheduler send error:', e.message);
      }
    }
  }
}, 60 * 1000); // check toutes les minutes

// ===== App =====
const app = express();
app.use(bodyParser.json());

// Healthcheck
app.get('/', (_req, res) => res.send('FitMouv webhook OK'));

// Vérif webhook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Systeme.io → Profil
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

// Réception messages WhatsApp
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

    // --- Mémorise message
    c = contacts.get(waId);
    c.history.push({ role: 'user', text: userText, at: Date.now() });
    contacts.set(waId, c);

    // 1) SI PREMIER CONTACT -> ENVOI AUTO WELCOME + PLANIFICATION PROGRAMME (<24h)
    if (!c._welcomed) {
      const welcome =
        "👋 Hello, ici l’équipe FitMouv !\n\n" +
        "Bonne nouvelle : tu es pris(e) en charge par **tes coachs dédiés** (sport + nutrition). " +
        "On va préparer ton programme **personnalisé**, et **te recontacter d’ici 48h (généralement sous 24h)** pour le passer avec toi et l’adapter à ta réalité (temps dispo, matériel, préférences).\n\n" +
        "En attendant, si tu as des contraintes particulières (voyage, horaires, blessures…), dis-le ici pour qu’on en tienne compte 💬";

      await sendText(waId, welcome);

      // planifie envoi programme
      const dueAt = Date.now() + randProgramDelayMs();
      contacts.set(waId, { ...c, _welcomed: true, programScheduledAt: dueAt });

      return; // on ne répond rien d’autre maintenant
    }

    // 2) POUR LES ÉCHANGES INTERMÉDIAIRES (avant programme)
    // accusé + délai humanisé + réponse chill contextuelle
    await sendText(waId, "👌 Bien noté, je te réponds dans quelques minutes…");
    const delay = randDelayMs();
    await new Promise(r => setTimeout(r, delay));

    // Construit contexte IA : résumé + 30 derniers messages
    const last30 = c.history.slice(-30).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text }));
    const sys = "Tu es FitMouv (FR), coach sport + nutrition. Style chill, empathique, précis. Si le programme n’a pas encore été envoyé, reste en mode conversation: clarifie, poses 1-2 questions utiles max, note les contraintes pour adapter le plan.";
    const mem = c.summary ? `Mémoire longue: ${c.summary}` : 'Pas de mémoire longue.';

    const reply = await openaiChat([
      { role: 'system', content: sys },
      { role: 'user', content: mem },
      ...last30
    ]);

    await sendText(waId, reply);

    // mémorise réponse et met à jour résumé parfois
    c = contacts.get(waId);
    c.history.push({ role: 'assistant', text: reply, at: Date.now() });
    contacts.set(waId, c);
    updateLongSummary(waId).catch(e => console.error('updateLongSummary:', e.message));

  } catch (e) {
    console.error('Erreur /webhook:', e);
  }
});

// Lancement
app.listen(PORT, () => console.log(`Serveur FitMouv lancé sur ${PORT}`));
