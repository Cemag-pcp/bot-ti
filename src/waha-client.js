const axios = require("axios");
const config = require("./config");

const client = axios.create({
  baseURL: config.wahaBaseUrl,
  headers: {
    "Content-Type": "application/json",
    "X-Api-Key": config.wahaApiKey
  },
  timeout: 15000
});

async function sendText({ chatId, text, session = config.wahaSession, replyTo }) {
  const payload = { session, chatId, text };

  if (replyTo) {
    payload.reply_to = replyTo;
  }

  const response = await client.post("/api/sendText", payload);
  return response.data;
}

async function sendSeen({ chatId, session = config.wahaSession, messageIds }) {
  const payload = { session, chatId };

  if (messageIds?.length) {
    payload.messageIds = messageIds;
  }

  const response = await client.post("/api/sendSeen", payload);
  return response.data;
}

async function stopSession(name = config.wahaSession) {
  await client.post(`/api/sessions/${encodeURIComponent(name)}/stop`);
}

async function startSession({
  name = config.wahaSession,
  webhookUrl = config.webhookUrl,
  webhookSecret = config.webhookSecret
} = {}) {
  const webhooks = [
    {
      url: webhookUrl,
      events: ["message"]
    }
  ];

  if (webhookSecret) {
    webhooks[0].hmac = { key: webhookSecret };
  }

  const body = { name, config: { webhooks } };

  try {
    const response = await client.post("/api/sessions/start", body);
    return response.data;
  } catch (error) {
    if (error.response?.status === 422) {
      console.log("Sessao ja existe. Parando e reiniciando com webhook...");
      await stopSession(name);
      const response = await client.post("/api/sessions/start", body);
      return response.data;
    }
    throw error;
  }
}

async function resolveLidToPhone({ lid, session = config.wahaSession }) {
  const normalizedLid = String(lid || "").trim();

  if (!normalizedLid) {
    return null;
  }

  const lidValue = normalizedLid.endsWith("@lid") ? normalizedLid : `${normalizedLid}@lid`;
  const encodedLid = encodeURIComponent(lidValue);
  const response = await client.get(`/api/${encodeURIComponent(session)}/lids/${encodedLid}`);
  return response.data || null;
}

function getQrUrl(session = config.wahaSession) {
  return `${config.wahaBaseUrl}/api/screenshot?session=${encodeURIComponent(session)}`;
}

module.exports = {
  resolveLidToPhone,
  sendSeen,
  sendText,
  startSession,
  getQrUrl
};
