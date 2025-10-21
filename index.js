const express = require('express');
const app = express();
app.use(express.json());

// === Tes identifiants (inchangés) ===
const ACCESS_TOKEN    = 'EAArXJeZAS1lwBPjxlQWpFddZA4uZAkTr5NZBSzwRJLB1zWlsEjZCVO6ud4FZAEpUwkHcCCaRZAn8SeHcuDhh0ypwRjwaehr1gKE7hkvkZAZCMM2ScK3UtcDLzNs8MR1lpT1RFpJJ5RMckyDtTZBFypZBF8uY7qfDFDudIt0nNqCcHJZAecD2sZClObhmfOLmh5Nb7MwZDZD';
const PHONE_NUMBER_ID = '799570023246806'; // ton ID WhatsApp Business
const VERIFY_TOKEN    = 'fitmouv_verify_123';

// 📨 Fonction d’envoi de message WhatsApp
async function sendWhatsAppMessage(to, body) {
  const url = `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      text: { body }
    })
  });

  const data = await res.json().catch(() => ({}));
  console.log('↪️ Réponse Meta:', res.status, JSON.stringify(data));

  if (!res.ok) {
    throw new Error(`Échec d’envoi WhatsApp (${res.status})`);
  }
}

// 🚦 Route de test
app.get('/', (_req, res) => res.send('✅ Webhook FitMouv actif'));

// 🪪 Vérification du webhook pour Meta
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 💬 Réception des messages
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;
    res.sendStatus(200);

    const msg = data?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const text = msg.text?.body || '';
    console.log('📩 Message reçu de', from, ':', text);

    // 🔁 Réponse automatique
    const reply = `Merci pour ton message ! Tu as écrit : « ${text} »`;
    await sendWhatsAppMessage(from, reply);
    console.log('✅ Réponse envoyée à', from);
  } catch (err) {
    console.error('❌ Erreur webhook :', err.message);
  }
});

// 🚀 Lancement du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Serveur FitMouv lancé sur le port', PORT));
