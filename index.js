// index.js
// FitMouv – Webhook Respond.io -> WhatsApp Cloud API -> IA OpenAI
// (c) FitMouv 2025

import express from "express";
import axios from "axios";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

// --- en haut du fichier (après app.use(express.json())) ---
const pausedContacts = new Set(); // mémorise les contacts en pause
// mémoire simple côté serveur pour l'historique par contact
const contacts = new Map(); // <— AJOUTER CECI

// ====== ENV ======
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;           // Token système (long-lived) WABA
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;         // ex: "123456789012345"
const TEMPLATE_NAME = process.env.TEMPLATE_NAME || "fitmouv_welcome"; // déjà créé en "french (simple)"
const TEMPLATE_LANG  = process.env.TEMPLATE_LANG  || "french";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;           // clé OpenAI pour l’IA
const OPENAI_MODEL   = process.env.OPENAI_MODEL  || "gpt-4o-mini";

// ====== UTILS ======
const log = (...a) => console.log(...a);
const WAPI = axios.create({
  baseURL: `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}`,
  headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
});

// normalise FR: 06/07/… -> +33…
function normalizeMsisdn(raw) {
  if (!raw) return raw;
  let s = (""+raw).replace(/\s+/g,"");
  if (s.startsWith("+")) return s;
  if (/^0[1-9]\d{8}$/.test(s)) return "+33" + s.slice(1);
  return s;
}

// ====== IA ======
async function replyWithAI(to, name, lastUserMsg, channel) {
  if (!OPENAI_API_KEY) {
    log("IA désactivée (OPENAI_API_KEY manquant) -> rien envoyé");
    return;
  }
  const sys = `Tu es l'IA FitMouv. Tu parles en français simple, ton chill, précis, empathique.
Règles: pas de gras, pas d'astérisques; parle au nom de "tes coachs".
Contexte: coaching sport + nutrition par abonnement FitMouv.
Objectif: aider la personne à avancer vers ses objectifs, poser 1-2 questions utiles max.
Ne promets rien d’irréaliste.`;

  const prompt = `Prénom: ${name || "là"}.
Canal: ${channel || "WhatsApp"}.
Message reçu: "${lastUserMsg}". 
Réponds en 1 à 3 phrases maximum, ton humain et chaleureux.`;

  const resp = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: prompt }
      ]
    },
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );

  const text = resp.data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    log("IA: pas de contenu");
    return;
  }

  await sendWhatsappText(to, text);
}

// ====== WHATSAPP SENDERS ======
async function sendWhatsappText(to, text) {
  return WAPI.post("/messages", {
    messaging_product: "whatsapp",
    to, type: "text",
    text: { preview_url: false, body: text }
  });
}

async function sendWelcomeTemplate(to, name) {
  return WAPI.post("/messages", {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: TEMPLATE_NAME,
      language: { code: TEMPLATE_LANG }, // "french" (simple)
      components: name ? [{
        type: "body",
        parameters: [{ type: "text", text: name }]
      }] : undefined
    }
  });
}

// =====================
// ===  /control  ======
// =====================
app.post("/control", (req, res) => {
  const { action, contact_id, contact_phone, contact_name } = req.body || {};
  const key = contact_id || contact_phone;

  if (!action || !key) {
    console.log("[CONTROL] Requête invalide:", req.body);
    return res.status(400).json({ error: "action et contact_id ou contact_phone requis" });
  }

  if (action === "pause") {
    pausedContacts.add(key);
    console.log("=== CONTROL: PAUSE ===", { key, contact_name });
    return res.json({ ok: true, paused: true, key });
  }

  if (action === "resume") {
    pausedContacts.delete(key);
    console.log("=== CONTROL: RESUME ===", { key, contact_name });
    return res.json({ ok: true, paused: false, key });
  }

  console.log("[CONTROL] Action inconnue:", action);
  return res.status(400).json({ error: 'action doit être "pause" ou "resume"' });
});

// ====== WEBHOOK RESPOND.IO ======
app.post("/webhook", async (req, res) => {
  try {
    log("\n---- /webhook IN ----");
    log(JSON.stringify(req.body, null, 2));

    // Vérifie si le contact est en pause (tag "pause_ai" actif)
const contactKey = req.body.contact_id || req.body.from || req.body.contact_phone;

if (contactKey && pausedContacts.has(contactKey)) {
  console.log("AI PAUSED for", contactKey, "→ aucune auto-réponse.");
  return res.json({ ok: true, skipped: "paused" });
}
    

    // Payload attendu depuis Respond.io (tu l’as déjà configuré)
    const fromRaw   = req.body.de || req.body.from;
    const name      = req.body.nom || req.body.name;
    const message   = req.body.message || "";
    const channel   = req.body.channel || req.body["channel.name"];

    const to = normalizeMsisdn(fromRaw);
    if (!to) { log("Numéro manquant"); return res.status(400).json({ ok:false }); }

    // Tentative d’envoi direct (fenêtre ouverte)
    try {
      if (message && message !== "{{message.text}}") {
        await replyWithAI(to, name, message, channel);
      } else {
        // Si pas de message utilisateur (ex: trigger "Conversation ouverte"), envoie un micro ping neutre
        await sendWhatsappText(to, "Salut, bien reçu. Tes coachs te répondent ici 👍");
      }
      log("Envoi texte OK (fenêtre ouverte).");
    } catch (e) {
      const code = e?.response?.data?.error?.code;
      const sub  = e?.response?.data?.error?.error_subcode;
      const msg  = e?.response?.data?.error?.message;
      log("Erreur envoi texte:", code, sub, msg);

      // 470 = outside 24h window
      if (code === 470 || sub === 2018001 || (msg||"").includes("outside the 24 hour window")) {
        log("Fenêtre fermée -> envoi du template d’ouverture…");
        await sendWelcomeTemplate(to, name || "là 👋");
      } else {
        throw e;
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    log("Webhook ERROR:", err?.response?.data || err);
    return res.status(500).json({ ok:false });
  }
});

// === ENDPOINT POUR LES NOTES COACHS ===
app.post('/note', (req, res) => {
  try {
    const { contact_id, contact_phone, note } = req.body || {};
    const key = contact_id || contact_phone;
    if (!key || !note || !note.trim()) {
      return res.status(400).json({ ok: false, error: 'missing key or note' });
    }

    // récupère la fiche du contact ou crée une nouvelle entrée
    const c = contacts.get(key) || { history: [] };
    c.history = c.history || [];

    // ajoute la note comme si c'était l'IA elle-même
    c.history.push({
      role: 'assistant',
      text: `[Note coach] ${note.trim()}`,
      at: Date.now(),
      by: 'coach'
    });

    contacts.set(key, c);

    console.log('NOTE IA intégrée pour', key, '=>', note);
    return res.json({ ok: true });
  } catch (e) {
    console.error('/note error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/health", (req,res)=>res.send("ok"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  log("===============================================");
  log("🚀 Serveur opérationnel sur :", PORT);
  log(`🌐 URL principale : https://whatsapp-bot-v98u.onrender.com`);
  log("===============================================");
});
