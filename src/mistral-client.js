const axios = require("axios");
const config = require("./config");

const client = axios.create({
  baseURL: "https://api.mistral.ai",
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.mistralApiKey}`
  }
});

function hasMistralConfig() {
  return Boolean(config.mistralApiKey);
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();

  if (!raw) {
    return {};
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;

  return JSON.parse(candidate);
}

async function decideNextStep({ message, profile, requester, draft, locations, lastReply }) {
  if (!hasMistralConfig()) {
    throw new Error("MISTRAL_API_KEY nao configurada");
  }

  const locationList =
    locations?.length > 0
      ? locations.map((l) => l.name).join(", ")
      : "Nenhum setor disponivel.";

  const requesterInfo = requester
    ? [
        "Cadastrado.",
        `Nome: ${requester.full_name || "N/A"}.`,
        `Matricula: ${requester.matricula || "N/A"}.`,
        `Email: ${requester.email || "N/A"}.`
      ].join(" ")
    : "Nao cadastrado no sistema.";

  const draftInfo =
    Object.keys(draft || {}).length > 0
      ? JSON.stringify(draft)
      : "Nenhum dado coletado ainda.";

  const systemPrompt = [
    `Voce é assistente de suporte de TI virtual.`,
    "Sua única função é conduzir a conversa até abrir um chamado de TI.",
    "Seja bem direto, objetivo e natural. Nao use linguagem muito formal ou tecnica. Seja amigavel, mas nao prolixo. Evite perguntas abertas, seja especifico no que esta pedindo.",
    "Seu objetivo é ser o mais direto possivel e rápido para abertura de chamado.",
    "Caso o usuario diga 'Estou sem internet.', por exemplo, nao pergunte 'Qual é o problema?'. Pergunte diretamente 'Entendi, voce esta sem internet. Qual é o setor onde voce esta?'. E conduza para abertura do chamado.",
    "",
    "Retorne APENAS JSON valido, sem texto fora do JSON, com exatamente estes campos:",
    '  "action": "COLLECT" | "OPEN_TICKET" | "OUT_OF_SCOPE"',
    '  "reply": string — mensagem natural em portugues para enviar ao usuario',
    '  "extracted": objeto com os campos extraidos DA MENSAGEM ATUAL (null se ausente):',
    "    name, name_confirmed, matricula, title, description, category, priority, location_name, asset_tag",
    "",
    "Regras de action:",
    "- OPEN_TICKET: use SOMENTE quando o draft (somado ao extracted) tiver TODOS estes campos:",
    "    matricula, title, description, location_name.",
    "  E o solicitante ja estiver cadastrado OU a matricula tiver sido fornecida.",
    "- Se a mensagem atual for apenas saudacao, agradecimento, confirmacao neutra ou conversa geral sem novos dados do chamado, NAO use OPEN_TICKET.",
    "- Nesses casos, use COLLECT ou OUT_OF_SCOPE e responda naturalmente, como um assistente de TI via WhatsApp.",
    "- Nunca abra chamado reaproveitando um draft antigo quando a mensagem atual nao trouxer informacao util nova para o chamado.",
    "- OUT_OF_SCOPE: use quando a mensagem nao tiver relacao com TI ou suporte tecnico.",
    "- COLLECT: use em todos os outros casos. Peca naturalmente o que estiver faltando.",
    "",
    "Regras de fluxo:",
    "- Verifica se o solicitante está cadastrado",
    "- Se o solicitante nao esta cadastrado e o nome do WhatsApp esta disponivel, confirme esse nome antes de pedir a matricula.",
    "- Pergunte de forma natural algo como: 'Estou vendo que seu nome e X, correto? Se nao, digite o nome correto.'",
    "- Peca um dado por vez, na ordem: confirmacao do nome > matricula > descricao do problema > setor.",
    "- Se o usuario ja descreveu o problema na mensagem atual (extracted.description nao eh null), NAO peca mais detalhes sobre o problema. Avance imediatamente para o proximo campo faltante (geralmente o setor).",
    "- Se o solicitante ja esta cadastrado (situacao: Cadastrado), pule confirmacao de nome e matricula. Comece pedindo a descricao ou setor conforme o que ja foi coletado.",
    "- Se o usuario confirmar o nome (sim/correto/isso/exato/etc), salve o nome em extracted.name e extracted.name_confirmed = true.",
    "- Se o usuario corrigir o nome diretamente (ex: 'Nao, sou Joao'), salve o nome correto em extracted.name e extracted.name_confirmed = true.",
    "- Se o usuario NEGAR o nome sem fornecer o correto (ex: 'Nao', 'Errado', 'Nao e esse'), NAO avance para matricula. Pergunte qual e o nome correto. Nao salve nada em extracted.",
    "- Se o usuario quiser mudar o nome ja confirmado (ex: 'Meu nome e outro', 'Quero mudar o nome', 'Nome errado'), extraia name_confirmed = false e name = null. Pergunte qual e o nome correto.",
    "- Se o nome ainda nao estiver confirmado nesta mensagem, extracted.name_confirmed deve ser null.",
    "- location_name deve ser EXATAMENTE igual a um dos setores validos listados, ou null.",
    "- Tente mapear abreviacoes ou nomes parciais para o setor correto.",
    "- Categorias validas: HARDWARE, SOFTWARE, NETWORK, ACCESS, OTHER.",
    "- Prioridades validas: LOW, MEDIUM, HIGH, CRITICAL. Use MEDIUM se nao indicada.",
    "- title deve ser um resumo curto do problema (ex: 'Sem acesso ao sistema', 'Impressora nao funciona'). Se o usuario descreveu o problema, gere um title resumido mesmo que ele nao tenha dito explicitamente.",
    "- asset_tag e o numero de patrimonio do equipamento (ex: '12345', 'PAT-001'). E opcional. So extraia se o usuario mencionar. Nao pergunte proativamente.",
    "- Nao invente dados. Se nao estiver na mensagem, use null em extracted. Excecao: title pode ser gerado a partir da descricao.",
    "- extracted deve conter APENAS o que o usuario disse AGORA, nao copie o draft.",
    "- Seja objetivo, amigavel e natural. Nao liste campos tecnicos para o usuario.",
    "- Para OPEN_TICKET, o reply deve informar que o chamado sera aberto agora.",
    "  Nao inclua o numero do chamado no reply (sera informado pelo sistema apos abertura)."
  ].join("\n");

  const confirmedName = draft?.name_confirmed === true ? draft?.name : null;
  const effectiveName = confirmedName || requester?.full_name || null;

  const userContent = [
    `Mensagem atual do usuario: "${message}"`,
    effectiveName
      ? `Nome confirmado do usuario: ${effectiveName} (use este nome para se dirigir ao usuario)`
      : `Nome no WhatsApp (ainda nao confirmado): ${profile?.whatsapp_name || "Nao informado"}`,
    `Telefone: ${profile?.phone || "Nao informado"}`,
    `Situacao do solicitante: ${requesterInfo}`,
    `Dados ja coletados: ${draftInfo}`,
    lastReply ? `Ultima mensagem que voce enviou: "${lastReply}"` : null,
    `Setores validos: ${locationList}`
  ]
    .filter(Boolean)
    .join("\n");

  const response = await client.post("/v1/chat/completions", {
    model: config.mistralModel,
    temperature: 0.2,
    max_tokens: 500,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent }
    ]
  });

  const content = response.data?.choices?.[0]?.message?.content?.trim() || "{}";
  const parsed = parseJsonObject(content);

  return {
    action: parsed.action || "COLLECT",
    reply: String(parsed.reply || "Poderia repetir? Nao entendi sua solicitacao."),
    extracted: {
      name: parsed.extracted?.name || null,
      name_confirmed: parsed.extracted?.name_confirmed === true ? true : null,
      matricula:
        parsed.extracted?.matricula != null ? String(parsed.extracted.matricula) : null,
      title: parsed.extracted?.title || null,
      description: parsed.extracted?.description || null,
      category: parsed.extracted?.category || null,
      priority: parsed.extracted?.priority || null,
      location_name: parsed.extracted?.location_name || null,
      asset_tag: parsed.extracted?.asset_tag || null
    }
  };
}

async function generateTitle(description) {
  if (!hasMistralConfig()) return null;

  const response = await client.post("/v1/chat/completions", {
    model: config.mistralModel,
    temperature: 0.2,
    max_tokens: 60,
    messages: [
      {
        role: "system",
        content:
          "Voce resume descricoes de problemas de TI em um titulo curto e direto (maximo 60 caracteres). Retorne apenas o titulo, sem aspas, sem pontuacao final, sem explicacoes."
      },
      {
        role: "user",
        content: description
      }
    ]
  });

  const title = response.data?.choices?.[0]?.message?.content?.trim() || null;
  return title && title.length > 0 ? title : null;
}

module.exports = {
  decideNextStep,
  generateTitle,
  hasMistralConfig
};
