const axios = require("axios");
const config = require("./config");

const useOllama = Boolean(config.ollamaBaseUrl);

const client = useOllama
  ? axios.create({
      baseURL: config.ollamaBaseUrl,
      timeout: 60000,
      headers: { "Content-Type": "application/json" }
    })
  : axios.create({
      baseURL: "https://api.mistral.ai",
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.mistralApiKey}`
      }
    });

function hasMistralConfig() {
  return useOllama || Boolean(config.mistralApiKey);
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

async function decideNextStep({ message, profile, requester, draft, locations, deviceTypes, history, lastTicketLocation }) {
  if (!hasMistralConfig()) {
    throw new Error("MISTRAL_API_KEY nao configurada");
  }

  const locationList =
    locations?.length > 0
      ? locations.map((l) => l.name).join(", ")
      : "Nenhum setor disponivel.";

  const deviceList =
    deviceTypes?.length > 0
      ? deviceTypes.map((d) => d.name).join(", ")
      : null;

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
    "IMPORTANTE: NUNCA repita ou ecoe a mensagem do usuario no campo reply. O reply deve conter APENAS a resposta do assistente, nunca a mensagem recebida.",
    "Caso o usuario diga 'Estou sem internet.', por exemplo, nao pergunte 'Qual é o problema?'. Pergunte diretamente 'Entendi, voce esta sem internet. Qual é o setor onde voce esta?'. E conduza para abertura do chamado.",
    "Problemas de rede, internet, Wi-Fi, cabo, conexao, 'net', acesso bloqueado, sistema lento, impressora, computador, email, VPN e qualquer equipamento ou sistema de TI SAO sempre escopo de TI — use COLLECT ou OPEN_TICKET, nunca OUT_OF_SCOPE nesses casos.",
    "",
    "Retorne APENAS JSON valido, sem texto fora do JSON, com exatamente estes campos:",
    '  "action": "COLLECT" | "OPEN_TICKET" | "OUT_OF_SCOPE" | "TRANSFER_TO_HUMAN"',
    '  "reply": string — mensagem natural em portugues para enviar ao usuario',
    '  "extracted": objeto com os campos extraidos DA MENSAGEM ATUAL (null se ausente):',
    "    name, name_confirmed, matricula, title, description, category, priority, location_name, asset_tag, device_name",
    "",
    "=== CAMPOS DO CHAMADO ===",
    "Campos que DEVEM estar preenchidos antes de abrir o chamado (coletados do usuario ou inferidos):",
    "  - matricula: numero de matricula do solicitante.",
    "  - description: descricao do problema relatado pelo usuario.",
    "  - location_name: setor onde o usuario esta (deve ser um dos setores validos listados).",
    "  - device_name: equipamento envolvido quando a categoria for HARDWARE. Para categorias SOFTWARE, NETWORK, ACCESS e OTHER, defina SEMPRE device_name='Outro' automaticamente sem perguntar ao usuario.",
    "  - priority: prioridade do chamado (ver regras abaixo).",
    "Campos gerados automaticamente (NAO pergunte ao usuario):",
    "  - title: resumo curto gerado a partir da description.",
    "  - category: inferida do contexto (HARDWARE, SOFTWARE, NETWORK, ACCESS, OTHER).",
    "  - asset_tag: numero de patrimonio — so extraia se o usuario mencionar espontaneamente.",
    "",
    "=== EXTRACAO AUTOMATICA ===",
    "Ao receber a descricao do problema, extraia automaticamente sem perguntar:",
    "  - device_name: se o usuario mencionar qualquer equipamento, extraia e prefira o nome exato da lista de dispositivos cadastrados (se disponivel). Se a category for SOFTWARE, NETWORK, ACCESS ou OTHER e nenhum equipamento especifico for mencionado, use device_name='Outro'.",
    "  - category: HARDWARE se for equipamento fisico; SOFTWARE se for sistema/programa; NETWORK se for rede/internet/conexao; ACCESS se for acesso/senha/permissao; OTHER caso contrario.",
    "  - title: gere um titulo curto e direto a partir da descricao (ex: 'Impressora sem conexao', 'Sistema lento', 'Sem acesso ao email').",
    "",
    "=== REGRAS DE ACTION ===",
    "- OPEN_TICKET: use SOMENTE quando o draft (somado ao extracted) tiver TODOS os campos obrigatorios:",
    "    matricula, description, location_name, priority.",
    "    E tambem device_name SE a category for HARDWARE.",
    "  E o solicitante ja estiver cadastrado OU a matricula tiver sido fornecida.",
    "- Se a mensagem atual for apenas saudacao, agradecimento, confirmacao neutra ou conversa geral sem novos dados do chamado, NAO use OPEN_TICKET.",
    "- Nesses casos, use COLLECT ou OUT_OF_SCOPE e responda naturalmente.",
    "- Nunca abra chamado reaproveitando um draft antigo quando a mensagem atual nao trouxer informacao util nova.",
    "- TRANSFER_TO_HUMAN: use quando o usuario pedir explicitamente para falar com um atendente, humano ou pessoa real.",
    "- OUT_OF_SCOPE: use SOMENTE quando tiver 100% de certeza que a mensagem nao tem nenhuma relacao com TI (ex: saude, vendas de imoveis, RH, assuntos pessoais). Em caso de duvida, use COLLECT. Qualquer mencao a senha, acesso, sistema, programa, equipamento, rede ou software e escopo de TI.",
    "- COLLECT: use em todos os outros casos. Peca naturalmente o que estiver faltando.",
    "",
    "=== ORDEM DE COLETA ===",
    "Peca um dado por vez, nesta ordem:",
    "  1. Confirmacao do nome (se nao cadastrado e nome do WhatsApp disponivel)",
    "  2. Matricula (se nao cadastrado)",
    "  3. Descricao do problema (se nao informada) — ao receber, extraia automaticamente device_name, category e title",
    "  4. Setor (location_name)",
    "  5. device_name — APENAS se category for HARDWARE e nao tiver sido extraido da descricao. Pergunte: 'Qual equipamento esta com problema?'. NUNCA pergunte device_name se category for SOFTWARE, NETWORK, ACCESS ou OTHER — nesses casos use automaticamente device_name='Outro' sem perguntar.",
    "  6. Prioridade — apenas se nao puder ser determinada automaticamente (ver regras abaixo)",
    "",
    "REGRA CRITICA sobre saudacoes: quando o usuario enviar apenas uma saudacao ('oi', 'ola', 'bom dia', etc.) sem informar o problema, NUNCA pergunte o setor como primeira pergunta. Siga a ordem: confirme o nome se necessario, depois pergunte qual e o problema. So pergunte o setor APOS ter a descricao do problema.",
    "",
    "IMPORTANTE sobre interpretacao de respostas:",
    "- Interprete a resposta do usuario com base na ultima mensagem que voce enviou.",
    "- Se voce pediu a matricula e o usuario respondeu com numeros/alfanumericos, isso E a matricula.",
    "- Se voce pediu o setor e o usuario respondeu com um nome, isso E o setor.",
    "- Se voce perguntou 'Continua sendo o setor X?' ou 'Sua ultima solicitacao foi para o setor X. Continua sendo esse setor?' e o usuario confirmar (sim, correto, isso, exato, pode ser, ta bom, etc.), extraia location_name = X (o setor exato mencionado na sua ultima mensagem enviada).",
    "- Se voce pediu o equipamento e o usuario respondeu com um nome de device, isso E o device_name.",
    "- Se voce pediu a descricao do problema e o usuario respondeu (mesmo com poucas palavras como 'nao liga', 'travou', 'lento', 'nao abre', 'tela preta', 'sem sinal'), isso E a descricao — extraia em extracted.description e avance para o proximo campo. Nao peca mais detalhes do problema.",
    "- Nao repita uma pergunta que o usuario acabou de responder.",
    "",
    "Regras de nome:",
    "- Se o solicitante nao esta cadastrado e o nome do WhatsApp esta disponivel, confirme: 'Estou vendo que seu nome e X, correto?'",
    "- Se o usuario confirmar (sim/correto/isso/exato/etc): extraia name e name_confirmed = true.",
    "- Se o usuario corrigir diretamente (ex: 'Nao, sou Joao'): extraia o nome correto e name_confirmed = true.",
    "- Se o usuario NEGAR sem fornecer o correto: pergunte qual e o nome. Nao salve nada em extracted.",
    "- Se o solicitante ja esta cadastrado: pule confirmacao de nome e matricula.",
    "- Se o nome ainda nao estiver confirmado nesta mensagem: extracted.name_confirmed deve ser null.",
    "",
    "Regras de location_name:",
    "- Deve ser EXATAMENTE igual a um dos setores validos listados, ou null.",
    "- Tente mapear abreviacoes ou nomes parciais para o setor correto (ex: 'producao' → 'Produção', 'TI' → 'T.I.', 'rh' → 'Recursos Humanos').",
    "- Se o usuario informou um setor mas nao e possivel mapear para nenhum setor valido, use null e no reply apresente os setores validos disponiveis para o usuario escolher.",
    "",
    "=== REGRAS DE PRIORIDADE ===",
    "Determine automaticamente sem perguntar ao usuario:",
    "- CRITICAL automatico se:",
    "  1. O setor for de producao/chao de fabrica (producao, corte, estamparia, serra, usinagem, pintura, montagem, solda, conformacao, prensa, expedicao).",
    "  2. O problema for perda total de conectividade (sem internet, sem rede, net caiu, Wi-Fi caiu, cabo nao funciona).",
    "  3. O usuario mencionar que a producao parou ou que nao consegue trabalhar.",
    "- HIGH automatico se:",
    "  1. O usuario disser que esta impedido de trabalhar (fora de setor produtivo).",
    "  2. O problema afeta varios usuarios ou um setor inteiro.",
    "  3. Palavras de urgencia: urgente, rapido, preciso agora, parou, travou tudo.",
    "- MEDIUM: padrao quando nenhuma regra acima se aplicar.",
    "- LOW: apenas quando o usuario mencionar explicitamente que nao e urgente.",
    "",
    "Pergunta de prioridade (somente quando necessario):",
    "- Se a prioridade NAO puder ser determinada automaticamente E description E location_name ja estiverem coletados, faca UMA pergunta simples:",
    "  'Isso esta te impedindo de trabalhar agora?' (sim → HIGH, nao → MEDIUM).",
    "- Nao use a palavra 'prioridade'. Fale de forma natural.",
    "- Nao pergunte se a prioridade ja foi determinada automaticamente.",
    "",
    "=== REGRAS GERAIS ===",
    "- Nao invente dados. Se nao estiver na mensagem do usuario, use null em extracted. Excecao: title e category podem ser gerados/inferidos.",
    "- extracted deve conter APENAS o que o usuario disse AGORA, nao copie o draft.",
    "- Seja objetivo, amigavel e natural. Nao liste campos tecnicos para o usuario.",
    "- Para OPEN_TICKET, o reply deve informar que o chamado sera aberto agora.",
    "  Nao inclua o numero do chamado no reply (sera informado pelo sistema apos abertura)."
  ].join("\n");

  const confirmedName = draft?.name_confirmed === true ? draft?.name : null;
  const effectiveName = confirmedName || requester?.full_name || null;

  const contextContent = [
    effectiveName
      ? `Nome confirmado do usuario: ${effectiveName}`
      : `Nome no WhatsApp (nao confirmado): ${profile?.whatsapp_name || "Nao informado"}`,
    `Situacao do solicitante: ${requesterInfo}`,
    `Dados ja coletados: ${draftInfo}`,
    null,
    `Setores validos: ${locationList}`,
    deviceList ? `Dispositivos cadastrados: ${deviceList}` : null
  ]
    .filter(Boolean)
    .join("\n");

  // Historico de conversa como mensagens multi-turn (max 10 turnos)
  const historyMessages = (history || []).slice(-10).map((h) => ({
    role: h.role,
    content: h.content
  }));

  // Primeira mensagem de usuario carrega o contexto; as demais sao apenas o texto
  const firstUserMessage = historyMessages.length === 0
    ? `${contextContent}\n\nMensagem: "${message}"`
    : contextContent;

  const model = useOllama ? (config.ollamaModel || "qwen2.5:7b") : config.mistralModel;
  const body = {
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: firstUserMessage },
      ...historyMessages,
      ...(historyMessages.length > 0 ? [{ role: "user", content: message }] : [])
    ]
  };

  if (useOllama) {
    body.stream = false;
    body.format = "json";
    body.keep_alive = -1;
    body.options = { num_predict: 500 };
  } else {
    body.max_tokens = 500;
    body.response_format = { type: "json_object" };
  }

  const endpoint = useOllama ? "/api/chat" : "/v1/chat/completions";
  const response = await client.post(endpoint, body);

  const content = useOllama
    ? (response.data?.message?.content?.trim() || "{}")
    : (response.data?.choices?.[0]?.message?.content?.trim() || "{}");
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
      asset_tag: parsed.extracted?.asset_tag || null,
      device_name: parsed.extracted?.device_name || null
    }
  };
}

async function generateTitle(description) {
  if (!hasMistralConfig()) return null;

  const model = useOllama ? (config.ollamaModel || "qwen2.5:7b") : config.mistralModel;
  const response = await client.post("/v1/chat/completions", {
    model,
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
