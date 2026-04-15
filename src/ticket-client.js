const axios = require("axios");
const config = require("./config");

const client = axios.create({
  baseURL: config.sgtiBaseUrl,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json"
  }
});

async function openTicket(payload) {
  const response = await client.post("/tickets/api/open/", payload);
  return response.data;
}

async function getDeviceTypes() {
  const response = await client.get(config.sgtiDevicesPath);
  const data = response.data;

  // Suporta { results: [...] } (paginado) ou array direto
  const items = Array.isArray(data) ? data : (data?.results ?? []);

  return items.map((item) => ({
    id: item.id ?? null,
    name: String(item.name ?? item.label ?? item.device_name ?? "").trim()
  })).filter((item) => item.name);
}

module.exports = {
  openTicket,
  getDeviceTypes
};
