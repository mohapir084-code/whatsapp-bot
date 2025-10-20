const express = require('express');
const app = express();
app.use(express.json());

// === Tes identifiants (déjà validés) ===
const ACCESS_TOKEN    = 'EAArXJeZAS1lwBPlzau1ZBK0hr4mE89k0ZCimk2rMZCWv7QR3rhPTWBdntU82QBKtqsGoumaklHt8cFoVyW3Fnl4UBvwBqoRFeYSwdaInpCxJihwHEf3swM62Mu25bRwt7kBS706IxsATHXnMxXIwX1w8vqidhZArY8lbVtIsmERdFIyK5cAiZBFBqqlepaCOWLwsTu9hQNbB1BX2rjb27ZCMOZAxwSsjzKw2egRZBnanyiGuUDN8sxSE1ew8PZCU4ZD';
const PHONE_NUMBER_ID = '799570023246806'; // ton ID de numéro
const VERIFY_TOKEN    = 'fitmouv_verify_123'; // le même que sur Meta

// Petit helper pour envoyer un message
async function sendWhatsAppMessage(to, body) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
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
  console.log('↪️  Réponse Meta:', res.status, JSON.stringify(data));
  if (!res.ok) {
    throw new Error(`Envoi WhatsApp échec: ${res.status}`);
  }
}

// Healthcheck rapide
app.get('/', (_req, res) => res.send('OK - Webhook en ligne'));

// Vérification du webhook (Meta appelle en GET au setup)
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Réception des messages (Meta envoie en POST ici)
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;
    // Confirme tout de suite à Meta
    res.sendStatus(200);

    // Sélectionne le premier message texte s’il existe
    const msg = data?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;                 // wa_id de l’expéditeur (ex: 336....)
    const text = msg.text?.body || '';     // contenu du message

    console.log('📩 Message reçu de', from, ':', text);

    // On répond (fenêtre 24h ouverte puisqu’il vient d’écrire)
    const reply = `Merci pour ton message ! Tu as écrit : "${text}"`;
    await sendWhatsAppMessage(from, reply);

    console.log('✅ Réponse envoyée à', from);
  } catch (err) {
    console.error('❌ Erreur dans /webhook:', err.message);
  }
});

// Render injecte le port via process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Serveur lancé sur le port', PORT));
