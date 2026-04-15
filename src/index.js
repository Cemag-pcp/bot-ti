const crypto = require("crypto");
const express = require("express");
const config = require("./config");
const { handleIncomingMessage, resumeStaleHandoffs } = require("./bot");
const { initDatabase, upsertConversation, getConversation } = require("./database");

const app = express();

app.use(
  express.json({
    verify: (req, res, buffer) => {
      req.rawBody = buffer;
    }
  })
);

function verifyWebhookSignature(req, res, next) {
  if (!config.webhookSecret) {
    return next();
  }

  const signature = req.header("X-Webhook-Hmac");
  const algorithm = req.header("X-Webhook-Hmac-Algorithm");

  if (!signature || !algorithm) {
    return res.status(401).json({ error: "Webhook sem assinatura" });
  }

  const hash = crypto
    .createHmac(algorithm, config.webhookSecret)
    .update(req.rawBody || Buffer.from(""))
    .digest("hex");

  const isValid =
    signature.length === hash.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(hash));

  if (!isValid) {
    return res.status(401).json({ error: "Assinatura do webhook invalida" });
  }

  return next();
}

function buildUserDebugData(payload) {
  return {
    id: payload?.id || null,
    from: payload?.from || null,
    sender: payload?.sender || null,
    author: payload?.author || null,
    participant: payload?.participant || null,
    notifyName: payload?.notifyName || null,
    pushName: payload?.pushName || null,
    chatId: payload?.chatId || null,
    chat: payload?.chat || null,
    contact: payload?.contact || null,
    _data: payload?._data || null
  };
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    bot: config.botName,
    session: config.wahaSession,
    dbHost: config.dbHost,
    dbSchema: config.dbSchema
  });
});

app.post("/webhook/waha", verifyWebhookSignature, async (req, res) => {
  try {
    const payload = req.body?.payload || {};
    console.log(
      "[WAHA webhook]",
      JSON.stringify({
        event: req.body?.event,
        session: req.body?.session,
        id: payload.id,
        from: payload.from,
        fromMe: payload.fromMe,
        body: payload.body
      })
    );
    console.log("[WAHA user payload]", JSON.stringify(buildUserDebugData(payload)));

    const result = await handleIncomingMessage(req.body);
    console.log("[WAHA webhook result]", JSON.stringify(result));
    res.json({ ok: true, result });
  } catch (error) {
    console.error("Erro ao processar webhook do WAHA:", error.message);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/api/conversations/:phone/state", async (req, res) => {
  try {
    const conversation = await getConversation(req.params.phone);
    res.json({ ok: true, conversation });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/conversations/:phone/resume-bot", async (req, res) => {
  try {
    const conversation = await getConversation(req.params.phone);

    if (!conversation) {
      return res.status(404).json({ ok: false, error: "Conversa nao encontrada" });
    }

    if (conversation.state !== "human_handoff") {
      return res.status(400).json({ ok: false, error: `Estado atual nao e human_handoff: ${conversation.state}` });
    }

    await upsertConversation({
      phoneNumber: req.params.phone,
      state: "idle",
      context: { draft: {}, last_reply: null }
    });

    console.log("[api] atendimento humano encerrado, bot retomado para", req.params.phone);
    res.json({ ok: true, phone: req.params.phone, state: "idle" });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.use((error, req, res, next) => {
  console.error("Erro na API:", error.message);
  res.status(500).json({ ok: false, error: error.message });
});

const HANDOFF_CHECK_INTERVAL_MS = 60 * 1000; // verifica a cada 1 minuto

initDatabase()
  .then(() => {
    app.listen(config.port, () => {
      console.log(`Bot ouvindo em http://localhost:${config.port}`);
      console.log(`Webhook configurado para uso com WAHA: ${config.webhookUrl}`);
      console.log(`Banco PostgreSQL em ${config.dbHost}/${config.dbName} schema ${config.dbSchema}`);
    });

    setInterval(async () => {
      try {
        const resumed = await resumeStaleHandoffs({ session: config.wahaSession });
        if (resumed > 0) {
          console.log(`[monitor] ${resumed} conversa(s) retomadas por timeout de handoff`);
        }
      } catch (error) {
        console.error("[monitor] erro ao verificar handoffs expirados:", error.message);
      }
    }, HANDOFF_CHECK_INTERVAL_MS);
  })
  .catch((error) => {
    console.error("Falha ao iniciar banco de dados:", error.message);
    process.exit(1);
  });
