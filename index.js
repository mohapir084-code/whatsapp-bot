// ===== fetch compatible CJS =====
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const FormData = require('form-data');
const express  = require('express');
const bodyParser = require('body-parser');
const fs   = require('fs');
const path = require('path');

// ====== ENV ======
const ACCESS_TOKEN    = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const SIO_SECRET      = process.env.SIO_SECRET || '';

const PORT                  = Number(process.env.PORT || 10000);
const DELAY_MIN_SEC         = Number(process.env.DELAY_MIN_SEC || 60);
const DELAY_MAX_SEC         = Number(process.env.DELAY_MAX_SEC || 240);
const PROGRAM_DELAY_MIN_MIN = Number(process.env.PROGRAM_DELAY_MIN_MIN || 1200); // 20h
const PROGRAM_DELAY_MAX_MIN = Number(process.env.PROGRAM_DELAY_MAX_MIN || 1380); // 23h

// ===== App =====
const app = express();
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Mémoire (POC) =====
// contacts: waId -> { sioProfile, history:[{role,text,at}], summary, programScheduledAt, programSent, _welcomed }
const contacts = new Map();

// ===== Stockage léger (debug) =====
const DATA_DIR     = path.join('/tmp');                 // FS éphémère Render
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

// ===== Utils =====
const pick = (v, fallback = '') => (v === null || v === undefined ? fallback : String(v).trim());
function normalizeFRPhone(raw) {
  if (!raw) return '';
  let p = String(raw).trim();

  // garder + et chiffres
  p = p.replace(/[^\d+]/g, '');

  // 00xx -> +xx
  if (p.startsWith('00')) p = '+' + p.slice(2);

  // déjà en +E.164
  if (p.startsWith('+')) return p;

  // 0XXXXXXXXX -> +33XXXXXXXXX
  if (/^0\d{9}$/.test(p)) return '+33' + p.slice(1);

  // 33XXXXXXXXX -> +33XXXXXXXXX
  if (/^33\d{9}$/.test(p)) return '+' + p;

  // fallback: chiffres seuls
  if (/^\d+$/.test(p)) {
    if (p.startsWith('0') && p.length === 10) return '+33' + p.slice(1);
    return '+' + p;
  }
  return p;
}

// ===== WhatsApp helpers =====
async function waPost(path, payload) {
  const url = `https://graph.facebook.com/v24.0/${path}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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
    text: { body, preview_url: false },
  });
}

async function sendImage(to, link, caption = '') {
  return waPost(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { link, caption },
  });
}

// ===== OpenAI helpers =====
async function openaiChat(messages, temperature = 0.7) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages, temperature }),
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
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  if (!r.ok) throw new Error(`OpenAI transcribe ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.text || '';
}

// ===== Exemples de médias (remplace par tes propres liens hébergés) =====
const EXOS_MEDIA = {
  pushups: 'https://i.imgur.com/0hYhD6j.gif',
  squats:  'https://i.imgur.com/7q5E2iB.gif',
  plank:   'https://i.imgur.com/zV7rpxd.gif',
};

// ===== Génération des programmes =====
async function generatePrograms(profile, userRequestText) {
  const sys = [
    'Tu es FitMouv, coach SPORT + NUTRITION (FR). Ton style: simple, chaleureux, concret.',
    'Structure claire avec sections, emojis mesurés, quantités réalistes.',
    'Tiens compte: âge, sexe, poids, objectif, temps dispo, lieu, matériel, régime, allergies, dislikes.',
    'But: plan réaliste et tenable (adhérence).'
  ].join('\n');

  const longSummary = profile._summary || '';
  const user = `
Résumé client:
${longSummary || '(pas encore de résumé long)'}

Profil:
${JSON.stringify(profile, null, 2)}

Demande: "${userRequestText || 'Prépare un programme complet personnalisé.'}"

Donne en sortie:
1) Objectif & approche (2–4 lignes)
2) Nutrition (plan 15 jours): détail J1–J3 + logique de rotation (quantités indicatives)
3) Sport (plan 15 jours): 3 jours-type détaillés (5–6 exos/jour: échauffement, force, cardio/HIIT, core, mobilité)
4) Conseils d’adhérence (3–5 points)
`.trim();

  return openaiChat([
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ]);
}

// ===== Mémoire longue (résumé périodique) =====
async function updateLongSummary(waId) {
  const c = contacts.get(waId);
  if (!c || !c.history) return;
  if ((c.history.length || 0) % 12 !== 0) return; // toutes ~12 interactions

  const transcript = c.history.map(h => `${h.role.toUpperCase()}: ${h.text}`).join('\n');
  const prompt = 'Fais un résumé persistant et utile de la conversation coach-client (FR), concis et actionnable.';
  const summary = await openaiChat(
    [{ role: 'system', content: prompt }, { role: 'user', content: transcript.slice(-6000) }],
    0.3
  );
  contacts.set(waId, { ...c, summary });
}

// ===== Délais humanisés =====
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

// ===== Scheduler: envoi des programmes à l’heure prévue =====
setInterval(async () => {
  const now = Date.now();
  for (const [waId, c] of contacts) {
    if (!c.programSent && c.programScheduledAt && c.programScheduledAt <= now) {
      try {
        const profile = { ...(c.sioProfile || {}), _summary: c.summary || '' };
        const baseText = await generatePrograms(profile, 'Programme sport + nutrition personnalisé.');

        // petit délai avant envoi (humain)
        await new Promise(r => setTimeout(r, randDelayMs()));

        await sendText(waId, `Comme promis, voici ton programme personnalisé (sport + nutrition) :\n\n${baseText}`);
        await sendImage(waId, EXOS_MEDIA.pushups, 'Pompes – exécution');
        await sendImage(waId, EXOS_MEDIA.squats, 'Squats – exécution');
        await sendImage(waId, EXOS_MEDIA.plank,  'Planche – gainage');

        contacts.set(waId, { ...c, programSent: true });
      } catch (e) {
        console.error('Scheduler send error:', e.message);
      }
    }
  }
}, 60 * 1000);

// ===== Healthcheck =====
app.get('/', (_req, res) => res.send('FitMouv webhook OK'));

// ===== Meta webhook verify =====
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===== Systeme.io webhook (optin) =====
app.post('/sio-webhook', async (req, res) => {
  try {
    const qSecret = pick(req.query.secret);
    if (!SIO_SECRET || qSecret !== SIO_SECRET) {
      console.warn('SIO secret invalid');
      return res.status(403).json({ ok: false });
    }

    const payload = Object.keys(req.body || {}).length ? req.body : {};
    console.log('SIO raw payload:', payload);

    const lead = {
      source: 'systeme.io',
      createdAt: new Date().toISOString(),
      email:   pick(payload.email || payload.user_email),
      phone:   normalizeFRPhone(payload.phone || payload.telephone || payload.whatsapp || payload.phone_number || payload.mobile),
      firstName: pick(payload.first_name || payload.firstname || payload.prenom || payload.firstName),
      lastName:  pick(payload.last_name  || payload.lastname  || payload.nom     || payload.lastName),
      objectif:  pick(payload.objectif || payload.goal),
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
      raw: payload,
    };

    if (!lead.phone) {
      console.warn('SIO webhook sans téléphone, on ignore.');
      return res.json({ ok: true, stored: false, reason: 'no_phone' });
    }

    const db = readClients();
    db[lead.phone] = { ...(db[lead.phone] || {}), ...lead };
    writeClients(db);
    console.log('Lead enregistré pour', lead.phone);

    // message d’accueil auto (sans **gras**)
    const prenom = lead.firstName || '';
    const bienvenue =
      `Salut ${prenom || '👋'} !\n\n` +
      `Merci pour ton inscription. On a bien reçu toutes tes infos — on te prépare un programme vraiment personnalisé (sport + nutrition).\n` +
      `D’ici 24–48 h, tes coachs reviennent vers toi pour te le présenter et l’ajuster avec toi.\n\n` +
      `Si tu as une contrainte urgente (blessure, dispo qui change, aliment à éviter), écris-la ici. Sinon, on s’occupe de tout. 💪`;

    await sendText(lead.phone, bienvenue);

    // initialise la fiche contact en mémoire
    const waId = lead.phone.replace(/\D/g, ''); // WhatsApp renvoie souvent sans +
    const prev = contacts.get(waId) || { history: [], summary: '', programSent: false, programScheduledAt: null, sioProfile: null };
    const dueAt = Date.now() + randProgramDelayMs();

    contacts.set(waId, {
      ...prev,
      _welcomed: true,
      programScheduledAt: dueAt,
      sioProfile: {
        firstname: lead.firstName,
        lastname: lead.lastName,
        email: lead.email,
        phone: waId,
        goal: lead.objectif,
        level: lead.niveau,
        constraints: lead.contraintes,
        gender: lead.sexe,
        age: lead.age,
        weight_kg: lead.poids,
        height_cm: lead.taille,
        availability: lead.disponibilites,
        equipment: lead.materiel,
        patho: lead.patho,
        preferences: lead.preferences,
      },
    });

    return res.json({ ok: true, stored: true });
  } catch (err) {
    console.error('SIO /sio-webhook error:', err);
    return res.json({ ok: true, stored: false, error: true });
  }
});

// ===== Télécharger média WhatsApp (vocaux) =====
async function downloadWhatsAppMedia(mediaId) {
  const meta1 = await fetch(`https://graph.facebook.com/v24.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  if (!meta1.ok) throw new Error(`media meta ${meta1.status}: ${await meta1.text()}`);
  const { url } = await meta1.json();

  const fileRes = await fetch(url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (!fileRes.ok) throw new Error(`media download ${fileRes.status}: ${await fileRes.text()}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  return buf;
}

// ===== Réception messages WhatsApp =====
app.post('/webhook', async (req, res) => {
  try {
    res.sendStatus(200);

    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    const msg    = value?.messages?.[0];
    if (!msg) return;

    const waId  = msg.from;
    const msgId = msg.id;
    const type  = msg.type;

    let c = contacts.get(waId) || { history: [], programSent: false, programScheduledAt: null, sioProfile: null, summary: '', _welcomed: false };
    contacts.set(waId, c);

    await markAsRead(waId, msgId);

    // Texte utilisateur ou transcription
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

    // Si pas encore accueilli (cas où le premier message vient de WhatsApp au lieu de SIO)
    if (!c._welcomed) {
      const welcome =
        "Hello ! Ici l’équipe FitMouv 👋\n\n" +
        "On va préparer ton programme personnalisé (sport + nutrition) et revenir vers toi sous 24–48 h pour le passer ensemble et l’ajuster.\n" +
        "Si tu as une contrainte urgente, écris-la ici.";
      await sendText(waId, welcome);
      const dueAt = Date.now() + randProgramDelayMs();
      contacts.set(waId, { ...c, _welcomed: true, programScheduledAt: dueAt });
      return;
    }

    // Réponse “humaine” avec délai
    await sendText(waId, "Bien noté, je te réponds dans quelques minutes…");
    await new Promise(r => setTimeout(r, randDelayMs()));

    const last30 = c.history.slice(-30).map(h => ({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: h.text,
    }));
    const sys =
      "Tu es FitMouv (FR), coach sport + nutrition. Style naturel et chaleureux. " +
      "Si le programme n’est pas encore envoyé, reste en mode collecte/clarification (1–2 questions max) et prends des notes mentales pour adapter le plan. " +
      "Évite les sujets sensibles (médical, médicaments, paiements, politique/actualité à débat) et recentre calmement si ça sort du coaching.";
    const mem = c.summary ? `Mémoire: ${c.summary}` : 'Pas de mémoire longue.';

    const reply = await openaiChat([{ role: 'system', content: sys }, { role: 'user', content: mem }, ...last30]);
    await sendText(waId, reply);

    // Mémorise réponse et maj résumé
    c = contacts.get(waId);
    c.history.push({ role: 'assistant', text: reply, at: Date.now() });
    contacts.set(waId, c);
    updateLongSummary(waId).catch(e => console.error('updateLongSummary:', e.message));

  } catch (e) {
    console.error('Erreur /webhook:', e);
  }
});

// ===== Start =====
app.listen(PORT, () => console.log(`Serveur FitMouv lancé sur ${PORT}`));
