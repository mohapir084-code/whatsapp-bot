// index.js
const express = require("express");
const axios = require("axios");

const app = express();

// Conserve le raw body si un jour on veut vérifier la signature Meta
app.use(express.json({ limit: "1mb" }));

// --- Healthcheck
app.get("/", (req, res) => res.status(200).send("OK"));

// --- Webhook unique : accepte soit notre payload Respond.io, soit le callback Meta
app.post("/webhook", async (req, res) => {
  try {
    // LOG centralisé
    console.log("---- /webhook IN ----");
    console.log(JSON.stringify(req.body, null, 2));

    // Cas 1 : payload custom (depuis Respond.io → HTTP Request)
    // attendu: { from: "+33759...", name: "Mohamed", message: "..." }
    if (req.body && (req.body.from || req.body.message)) {
      const { from, name, message } = req.body;

      // TODO: ici on branchera OpenAI + envoi WhatsApp (quand on active la réponse)
      // Pour l’instant on log juste proprement
      console.log("Payload Respond.io → Render:", { from, name, message });

      return res.status(200).json({ ok: true, source: "respondio" });
    }

    // Cas 2 : callback Meta (Cloud API → App Webhooks)
    // structure: { object: 'whatsapp_business_account', entry: [...] }
    if (req.body && req.body.object === "whatsapp_business_account") {
      // On ne traite pas encore, on log seulement
      return res.status(200).send("EVENT_RECEIVED");
    }

    // Inconnu mais on répond 200 pour éviter les retries
    return res.status(200).json({ ok: true, note: "payload inconnu loggé" });
  } catch (e) {
    console.error("Webhook error:", e);
    return res.status(500).json({ ok: false });
  }
});

// 404 propre
app.use((req, res) => res.status(404).json({ error: "Not found" }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server up on :${PORT}`);
});
