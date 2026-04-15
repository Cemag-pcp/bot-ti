const config = require("../src/config");
const { getQrUrl, startSession } = require("../src/waha-client");

async function main() {
  const session = await startSession();

  console.log("Sessao iniciada ou atualizada com sucesso.");
  console.log(JSON.stringify(session, null, 2));
  console.log("");
  console.log("Se a sessao ainda nao estiver autenticada, abra a URL abaixo para ver o QR code:");
  console.log(getQrUrl());
  console.log("");
  console.log("Depois de escanear, envie 'menu' para o numero conectado.");
}

main().catch((error) => {
  const details = error.response?.data ? JSON.stringify(error.response.data, null, 2) : error.message;
  console.error("Falha ao iniciar a sessao no WAHA.");
  console.error(details);
  process.exit(1);
});
