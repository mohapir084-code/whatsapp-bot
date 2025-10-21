// index.js — FitMouv WhatsApp + OpenAI (v24 Meta + Responses API OpenAI)
const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// ---- Secrets (from Render Environment) ----
const ACCESS_TOKEN   = process.env.ACCESS_TOKEN;     // token permanent Meta (WABA)
const PHONE_NUMBER_ID= process.env.PHONE_NUMBER_ID;  // 799570023246806 (chez toi)
const VERIFY_TOKEN   = process.env.VERIFY_TOKEN;     // fitmouv_verify_123 (ex.)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;   // ta clé sk-proj-...

// ---- Healthcheck simple ----
app.get('/', (_, res) => res.send('OK - Webhook en ligne'));

// ---- Vérification Webhook Meta (GET /webhook) ----
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---- Réception messages WhatsApp (POST /webhook) ----
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;
    // Vérifie qu'on a bien un message texte entrant
    const msg = data?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) {
      return res.sendStatus(200);
    }

    const from = msg.from;                         // numéro de l’expéditeur
    const text = msg.text?.body?.trim() || '';     // texte reçu

    console.log('Message reçu :', text);

    // 1) Appel OpenAI (Responses API)
    let aiText = 'Désolé, je n’ai pas pu générer de réponse.';
    try {
      const aiRes = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          // Style: coach FR, réponses courtes et actionnables
          input: [
            { role: 'system', content: "Tu es FitMouv, coach sportif & nutrition FR. Donne des réponses claires, pratiques et motivantes. Max ~900 caractères. Si on te demande un plan, fais simple en puces (jour 1/2/3). Evite le jargon." },
            { role: 'user', content: text }
          ]
        })
      });
      const aiJson = await aiRes.json();
      aiText = aiJson.output_text?.trim() || aiText;
    } catch (e) {
      console.error('Erreur OpenAI :', e);
    }

    // 2) Envoi de la réponse sur WhatsApp
    const waRes = await fetch(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: from,
        type: 'text',
        text: { body: aiText }
      })
    });

    const waJson = await waRes.json();
    console.log('Réponse Meta:', waRes.status, JSON.stringify(waJson));

    res.sendStatus(200);
  } catch (err) {
    console.error('Erreur dans /webhook:', err);
    res.sendStatus(500);
  }
});

// ---- Lancement serveur (Render fournit le port via PORT) ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Serveur FitMouv lancé sur le port ${PORT}`);
});
