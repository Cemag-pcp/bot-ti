const axios = require("axios");

const client = axios.create({
  baseURL: "http://localhost:8000",
  timeout: 30000,
  headers: {
    "Content-Type": "application/json"
  }
});

async function openTicket(payload) {
  const response = await client.post("/tickets/api/open/", payload);
  return response.data;
}

module.exports = {
  openTicket
};
