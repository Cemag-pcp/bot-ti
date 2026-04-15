const axios = require("axios");
const FormData = require("form-data");
const config = require("./config");

function hasGroqConfig() {
  return Boolean(config.groqApiKey);
}

async function downloadAudio(url, wahaApiKey) {
  const headers = wahaApiKey ? { "X-Api-Key": wahaApiKey } : {};
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers
  });
  return Buffer.from(response.data);
}

async function transcribeAudio(audioBuffer, filename = "audio.ogg") {
  if (!hasGroqConfig()) {
    throw new Error("GROQ_API_KEY nao configurada");
  }

  const form = new FormData();
  form.append("file", audioBuffer, { filename, contentType: "audio/ogg" });
  form.append("model", "whisper-large-v3-turbo");
  form.append("language", "pt");
  form.append("response_format", "text");

  const response = await axios.post(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${config.groqApiKey}`
      },
      timeout: 30000
    }
  );

  return String(response.data || "").trim();
}

async function getAudioUrl({ session, messageId, wahaBaseUrl, wahaApiKey }) {
  const response = await axios.get(
    `${wahaBaseUrl}/api/${encodeURIComponent(session)}/messages/${encodeURIComponent(messageId)}/download`,
    {
      headers: { "X-Api-Key": wahaApiKey },
      timeout: 15000
    }
  );
  return response.data?.url || null;
}

module.exports = {
  hasGroqConfig,
  downloadAudio,
  transcribeAudio,
  getAudioUrl
};
