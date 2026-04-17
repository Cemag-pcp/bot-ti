const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function required(name, fallback) {
  const value = process.env[name] ?? fallback;

  if (!value) {
    throw new Error(`Variavel obrigatoria ausente: ${name}`);
  }

  return value;
}

module.exports = {
  port: Number(process.env.PORT || 3001),
  botName: process.env.BOT_NAME || "Assistente de TI",
  dbHost: process.env.DB_HOST || "",
  dbPort: Number(process.env.DB_PORT || 5432),
  dbName: process.env.DB_NAME || "",
  dbUser: process.env.DB_USER || "",
  dbPassword: process.env.DB_PASSWORD || "",
  dbSchema: process.env.DB_SCHEMA || "public",
  mistralApiKey: process.env.MISTRAL_API_KEY || "",
  groqApiKey: process.env.GROQ_API_KEY || "",
  mistralModel: process.env.MISTRAL_MODEL || "mistral-small-2506",
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL || "qwen2.5:7b",
  sgtiBaseUrl: (process.env.SGTI_BASE_URL || "https://sgti.onrender.com").replace(/\/+$/, ""),
  sgtiDevicesPath: process.env.SGTI_DEVICES_PATH || "/tickets/api/devices/",
  wahaBaseUrl: required("WAHA_BASE_URL", "http://localhost:3000").replace(/\/+$/, ""),
  wahaApiKey: required("WAHA_API_KEY"),
  wahaSession: process.env.WAHA_SESSION || "default",
  webhookUrl: required("WAHA_WEBHOOK_URL"),
  webhookSecret: process.env.WAHA_WEBHOOK_SECRET || ""
};
