// === Fetch compatible Node 18+ & fallback node-fetch ===
const fetch = globalThis.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

// === Dépendances ===
const express = require("express");
const bodyParser = require("body-parser");

// === Initialisation serveur Express ===
const app = express();
app.use(bodyParser.json());

// === Variables d’environnement (Render) ===
const ACCESS_TOKEN = process.env.ACCESS_TOKEN; // Token permanent Meta (WABA)
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // Exemple : fitmouv_verify_123
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // ID téléphone WhatsApp
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // Clé OpenAI (sk-proj-...)

// === Route de test (ping) ===
app.get("/", (req, res) => {
  res.send("✅ Webhook FitMouv WhatsApp + OpenAI en ligne !");
});

// === Vérification du Webhook Meta (GET /webhook) ===
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("🟢 Webhook vérifié par Meta");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// === Réception des messages (POST /webhook) ===
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (body.object) {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const message = changes?.value?.messages?.[0];

      if (message && message.text) {
        const from = message.from; // Numéro de l'utilisateur
        const text = message.text.body;
        console.log("💬 Message reçu :", text);

        // --- Appel OpenAI ---
        const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            input: `Tu es le coach FitMouv. Réponds de façon claire et motivante à : "${text}"`,
          }),
        });

        const data = await openaiResponse.json();
        const aiMessage = data.output?.[0]?.content?.[0]?.text || "Désolé, je n’ai pas compris 😅";

        console.log("🤖 Réponse générée :", aiMessage);

        // --- Envoi de la réponse sur WhatsApp ---
        await fetch(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ACCESS_TOKEN}`,
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: from,
            text: { body: aiMessage },
          }),
        });

        console.log("✅ Réponse envoyée à", from);
      }

      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  } catch (err) {
    console.error("❌ Erreur dans /webhook:", err);
    res.sendStatus(500);
  }
});

// === Lancement du serveur ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur FitMouv lancé sur le port ${PORT}`);
});
