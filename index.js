// ===== fetch compatible CJS =====
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const FormData = require('form-data');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

// ===== ENV =====
const ACCESS_TOKEN    = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const SIO_SECRET      = process.env.SIO_SECRET; // <— IMPORTANT : défini dans Render

const PORT                   = process.env.PORT || 10000;
const DELAY_MIN_SEC          = Number(process.env.DELAY_MIN_SEC || 60);
const DELAY_MAX_SEC          = Number(process.env.DELAY_MAX_SEC || 240);
const PROGRAM_DELAY_MIN_MIN  = Number(process.env.PROGRAM_DELAY_MIN_MIN || 1200); // 20h
const PROGRAM_DELAY_MAX_MIN  = Number(process.env.PROGRAM_DELAY_MAX_MIN || 1380); // 23h

// ===== Mémoire en RAM (POC) =====
// contacts: waId -> { sioProfile, history:[{role,text,at}], summary:string, programScheduledAt:number|null, programSent:boolean, _welcomed:boolean }
const contacts = new Map();

// ===== App =====
const app = express();
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

// ===== Helpers storage JSON (léger) =====
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

// ===== Utils =====
const pick = (v, fb = '') => (v === null || v === undefined ? fb : String(v).trim());
const phoneSanitize = p => pick(p).replace(/\s+/g, '');

// ===== WhatsApp Utils =====
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

// ===== OpenAI =====
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
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form
  });
  if (!r.ok) throw new Error(`OpenAI transcribe ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.text || '';
}

// ===== Exemples de médias (à remplacer par tes liens hébergés) =====
const EXOS_MEDIA = {
  pushups: 'https://i.imgur.com/0hYhD6j.gif',
  squats:  'https://i.imgur.com/7q5E2iB.gif',
  plank:   'https://i.imgur.com/zV7rpxd.gif',
};

// ===== Génération des programmes =====
async function generatePrograms(profile, userRequestText) {
  const sys = [
    'Tu es FitMouv, coach SPORT + NUTRITION. Français. Ton chill, clair, bienveillant.',
    'Structure avec emojis, quantités réalistes, sections nettes.',
    'Tiens compte de: âge/sexe/poids/objectif/temps dispo/lieu/matériel/diet/allergies/dislikes.',
    'Objectif: plan réaliste, tenable, axé adhérence.'
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
2) Nutrition (plan 15 jours): détail J1-J3, puis logique de rotation (quantités indicatives).
3) Sport (plan 15 jours): 3 jours-type détaillés (5-6 exos/jour : échauffement, force, cardio/HIIT, core, mobilité). Exos avec noms clairs.
4) Conseils d’adhérence (3-5 points).
  `.trim();

  return openaiChat([
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ]);
}

// ===== Mémoire longue (résumé) =====
async function updateLongSummary(waId) {
  const c = contacts.get(waId);
  if (!c || !c.history) return;
  if ((c.history.length || 0) % 12 !== 0) return;
  const transcript = c.history.map(h => `${h.role.toUpperCase()}: ${h.text}`).join('\n');
  const prompt = 'Fais un résumé persistant, compact et utile de la conversation coach-client.';
  const summary = await openaiChat([
    { role: 'system', content: prompt },
    { role: 'user', content: transcript.slice(-6000) }
  ], 0.3);
  contacts.set(waId, { ...c, summary });
}

// ===== Délais humanisés =====
const randDelayMs = () => (Math.floor(Math.random() * (Math.max(DELAY_MAX_SEC, DELAY_MIN_SEC) - DELAY_MIN_SEC + 1)) + DELAY_MIN_SEC) * 1000;
const randProgramDelayMs = () => (Math.floor(Math.random() * (PROGRAM_DELAY_MAX_MIN - PROGRAM_DELAY_MIN_MIN + 1)) + PROGRAM_DELAY_MIN_MIN) * 60 * 1000;

// ===== Scheduler : envoi du programme quand l’heure est venue =====
setInterval(async () => {
  const now = Date.now();
  for (const [waId, c] of contacts) {
    if (!c.programSent && c.programScheduledAt && c.programScheduledAt <= now) {
      try {
        let profile = c.sioProfile || {};
        profile._summary = c.summary || '';
        const baseText = await generatePrograms(profile, 'Prépare le programme sport + nutrition personnalisé.');
        await new Promise(r => setTimeout(r, randDelayMs()));
        await sendText(waId, `Comme promis, voici ton programme personnalisé (sport + nutrition) :\n\n${baseText}`);
        await sendImage(waId, EXOS_MEDIA.pushups, 'Pompes – exécution');
        await sendImage(waId, EXOS_MEDIA.squats, 'Squats – exécution');
        await sendImage(waId, EXOS_MEDIA.plank, 'Planche – gainage');
        contacts.set(waId, { ...c, programSent: true });
      } catch (e) {
        console.error('Scheduler send error:', e.message);
      }
    }
  }
}, 60 * 1000);

// ===== Healthcheck =====
app.get('/', (_req, res) => res.send('FitMouv webhook OK'));

// ===== Vérification webhook Meta =====
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===== Systeme.io → webhook (après formulaire) =====
// Rule SIO: "Appeler un webhook" → https://whatsapp-bot-v98u.onrender.com/sio-webhook?secret=VOTRE_SECRET
app.post('/sio-webhook', async (req, res) => {
  try {
    const secretFromQuery = pick(req.query.secret);
    if (!SIO_SECRET || secretFromQuery !== SIO_SECRET) {
      console.warn('SIO secret invalid');
      return res.status(403).json({ ok: false });
    }

    const payload = Object.keys(req.body || {}).length ? req.body : {};
    console.log('SIO raw payload:', payload);

    const lead = {
      source: 'systeme.io',
      createdAt: new Date().toISOString(),
      email:      pick(payload.email || payload.user_email),
      phone:      phoneSanitize(payload.phone || payload.telephone || payload.whatsapp || payload.phone_number),
      firstName:  pick(payload.first_name || payload.prenom || payload.firstname || payload.firstName),
      lastName:   pick(payload.last_name || payload.nom || payload.lastname || payload.lastName),
      objectif:   pick(payload.objectif),
      niveau:     pick(payload.niveau || payload.level),
      contraintes:pick(payload.contraintes || payload.constraints),
      sexe:       pick(payload.sexe || payload.gender),
      age:        pick(payload.age),
      poids:      pick(payload.poids || payload.weight),
      taille:     pick(payload.taille || payload.height),
      disponibilites: pick(payload.disponibilites || payload.creneaux || payload.availability),
      materiel:   pick(payload.materiel || payload.equipment),
      patho:      pick(payload.pathologies || payload.patho),
      preferences:pick(payload.preferences || payload.aliments_pref),
      raw: payload
    };

    if (!lead.phone) {
      console.warn('SIO webhook sans téléphone, on ignore.');
      return res.json({ ok: true, stored: false, reason: 'no_phone' });
    }

    const db = readClients();
    db[lead.phone] = { ...(db[lead.phone] || {}), ...lead };
    writeClients(db);
    console.log('Lead enregistré pour', lead.phone);

    const prenom = lead.firstName || '';
    const bienvenue =
`Salut ${prenom || '👋'} ! 

Merci pour ton inscription. On a bien reçu toutes tes infos — on te prépare un programme vraiment personnalisé (sport + nutrition).
D’ici 24 à 48 heures, tes coachs te recontactent pour te le présenter et l’ajuster avec toi.

Si tu as une contrainte urgente (blessure, dispo qui change, aliment à éviter), écris-la ici.
Sinon, garde un œil sur WhatsApp : on s’occupe de toi. 💪`;

    await sendText(lead.phone, bienvenue);

    return res.json({ ok: true, stored: true });
  } catch (err) {
    console.error('SIO /sio-webhook error:', err);
    return res.json({ ok: true, stored: false, error: true });
  }
});

// ===== Download média WhatsApp (vocaux) =====
async function downloadWhatsAppMedia(mediaId) {
  const meta1 = await fetch(`https://graph.facebook.com/v24.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
  });
  if (!meta1.ok) throw new Error(`media meta ${meta1.status}: ${await meta1.text()}`);
  const { url } = await meta1.json();

  const fileRes = await fetch(url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (!fileRes.ok) throw new Error(`media download ${fileRes.status}: ${await fileRes.text()}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  return buf;
}

// ===== Réception WhatsApp =====
app.post('/webhook', async (req, res) => {
  try {
    res.sendStatus(200);

    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const waId  = msg.from;
    const msgId = msg.id;
    const type  = msg.type;

    let c = contacts.get(waId) || { history: [], programSent: false, programScheduledAt: null, sioProfile: null, summary: '', _welcomed: false };
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
        await sendText(waId, "J'ai pas réussi à comprendre le vocal. Tu peux réessayer en texte ?");
        return;
      }
    } else {
      await sendText(waId, "Reçu. Dis-moi en texte ce que tu veux qu’on prépare pour toi.");
      return;
    }

    // Mémoire message
    c = contacts.get(waId);
    c.history.push({ role: 'user', text: userText, at: Date.now() });
    contacts.set(waId, c);

    // Premier accueil auto (sans gras/étoiles)
    if (!c._welcomed) {
      const welcome =
        "Hello, ici l’équipe FitMouv !\n\n" +
        "Tu es pris(e) en charge par tes coachs dédiés (sport + nutrition). " +
        "On prépare ton programme personnalisé et on te recontacte sous 24 à 48 heures " +
        "pour le passer avec toi et l’adapter à ta réalité (temps dispo, matériel, préférences).\n\n" +
        "Si tu as des contraintes particulières (voyage, horaires, blessures…), dis-le ici pour qu’on en tienne compte.";
      await sendText(waId, welcome);

      const dueAt = Date.now() + randProgramDelayMs();
      contacts.set(waId, { ...c, _welcomed: true, programScheduledAt: dueAt });
      return;
    }

    // Accusé + délai humanisé + réponse IA
    await sendText(waId, "Bien noté, je te réponds dans quelques minutes…");
    await new Promise(r => setTimeout(r, randDelayMs()));

    const last30 = c.history.slice(-30).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text }));
    const sys = "Tu es FitMouv (FR), coach sport + nutrition. Style naturel, empathique. Si le programme n’est pas encore envoyé, reste en conversation: clarifie, pose 1-2 questions utiles max et note les contraintes.";
    const mem = c.summary ? `Mémoire longue: ${c.summary}` : 'Pas de mémoire longue.';

    const reply = await openaiChat([
      { role: 'system', content: sys },
      { role: 'user', content: mem },
      ...last30
    ]);

    await sendText(waId, reply);

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
