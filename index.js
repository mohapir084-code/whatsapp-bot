const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(express.json());
app.use(bodyParser.json());

// === Variables d'env ===
const ACCESS_TOKEN  = process.env.ACCESS_TOKEN;          // <-- à définir sur Render
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;     // 799570023246806
const VERIFY_TOKEN  = process.env.VERIFY_TOKEN;          // fitmouv_verify_123

// Vérification du webhook Meta
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

// Réception et réponse automatique
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;
    const msg = data?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (msg) {
      const from = msg.from;
      const text = msg.text?.body || '';
      console.log('Message reçu :', text);

      await fetch(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: from,
          text: { body: `Merci pour ton message ! Tu as écrit : "${text}"` }
        })
      });
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('Erreur webhook :', e);
    res.sendStatus(500);
  }
});

// Test simple
app.get('/', (req, res) => res.send('OK - Webhook en ligne'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Serveur WhatsApp lancé sur le port', PORT));
