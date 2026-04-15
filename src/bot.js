const {
  extractBestPhone,
  extractPhone,
  getConversation,
  getRequesterByPhone,
  getStaleHandoffConversations,
  getTicketLocations,
  upsertRequesterProfile,
  upsertConversation
} = require("./database");
const { resolveLidToPhone, sendSeen, sendText } = require("./waha-client");
const { decideNextStep, generateTitle, hasMistralConfig } = require("./mistral-client");
const { hasGroqConfig, downloadAudio, transcribeAudio, getAudioUrl } = require("./groq-client");
const { openTicket, getDeviceTypes } = require("./ticket-client");

const processedMessages = new Map();
const PROCESSED_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CATEGORY = "OTHER";
const DEFAULT_PRIORITY = "MEDIUM";
const HANDOFF_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos

const PRODUCTION_SECTOR_KEYWORDS = [
  "producao", "producão", "produção", "corte", "estamparia", "serra",
  "usinagem", "pintura", "montagem", "solda", "soldagem", "conformacao",
  "conformação", "prensa", "expedicao", "expedição", "injecao", "injeção"
];

const CRITICAL_PROBLEM_KEYWORDS = [
  "sem internet", "sem rede", "sem conexao", "sem conexão", "net caiu",
  "internet caiu", "rede caiu", "wifi caiu", "wi-fi caiu", "cabo nao funciona",
  "cabo não funciona", "sem acesso a rede", "sem acesso à rede", "sem acesso a internet",
  "sem acesso à internet", "parou a producao", "parou a produção", "parou producao",
  "parou produção", "producao parada", "produção parada", "nao consigo trabalhar",
  "não consigo trabalhar", "maquina parada", "máquina parada"
];

const HIGH_PROBLEM_KEYWORDS = [
  "urgente", "rapido", "rápido", "preciso agora", "parou", "travou tudo",
  "varios usuarios", "vários usuários", "todo setor", "setor inteiro"
];

function inferPriority(locationName, description) {
  const loc = normalizeValue(locationName || "");
  const desc = normalizeValue(description || "");

  const isProductionSector = PRODUCTION_SECTOR_KEYWORDS.some(
    (kw) => loc.includes(normalizeValue(kw))
  );

  const isCriticalProblem = CRITICAL_PROBLEM_KEYWORDS.some(
    (kw) => desc.includes(normalizeValue(kw))
  );

  if (isProductionSector || isCriticalProblem) {
    return "CRITICAL";
  }

  const isHighProblem = HIGH_PROBLEM_KEYWORDS.some(
    (kw) => desc.includes(normalizeValue(kw))
  );

  if (isHighProblem) {
    return "HIGH";
  }

  return null; // sem inferencia — usar o que o LLM definiu ou MEDIUM
}

function rememberMessage(id) {
  const now = Date.now();
  processedMessages.set(id, now);

  for (const [key, timestamp] of processedMessages) {
    if (now - timestamp > PROCESSED_TTL_MS) {
      processedMessages.delete(key);
    }
  }
}

function isDuplicate(id) {
  return processedMessages.has(id);
}

function isDirectChat(chatId) {
  return typeof chatId === "string" && (chatId.endsWith("@c.us") || chatId.endsWith("@lid"));
}

function isPhoneChatId(value) {
  return typeof value === "string" && value.endsWith("@c.us");
}

function isLidChatId(value) {
  return typeof value === "string" && value.endsWith("@lid");
}

function pickResolvedPhoneCandidate(result) {
  if (!result) {
    return "";
  }

  const values = [
    result.phone,
    result.pn,
    result.chatId,
    result.user,
    result.contact?.id,
    result.contact?.chatId,
    result.contact?.phone,
    result.id
  ];

  for (const value of values) {
    if (isPhoneChatId(value)) {
      return extractPhone(value);
    }

    const digits = extractPhone(value);

    if (digits.length >= 10 && digits.length <= 15) {
      return digits;
    }
  }

  return "";
}

async function resolveSenderPhone({ payload, session }) {
  if (isPhoneChatId(payload?.from)) {
    return { phone: extractPhone(payload.from), source: "from-c.us" };
  }

  if (isLidChatId(payload?.from)) {
    try {
      const resolved = await resolveLidToPhone({ lid: payload.from, session });
      const resolvedPhone = pickResolvedPhoneCandidate(resolved);

      if (resolvedPhone) {
        return { phone: resolvedPhone, source: "resolved-lid" };
      }
    } catch (error) {
      console.error("Falha ao resolver LID:", error.response?.data || error.message);
    }
  }

  return { phone: extractBestPhone(payload), source: "payload-fallback" };
}

function mergeDraft(base, patch) {
  const next = { ...(base || {}) };

  for (const [key, value] of Object.entries(patch || {})) {
    if (typeof value === "boolean") {
      next[key] = value;
      continue;
    }

    if (value !== null && value !== undefined && value !== "") {
      next[key] = value;
    }
  }

  // Se o usuario quer corrigir o nome, limpa os dados de nome do draft
  if (patch?.name_confirmed === false) {
    delete next.name;
    delete next.name_confirmed;
  }

  return next;
}

function normalizeValue(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function findLocationByName(name, locations) {
  const normalized = normalizeValue(name);
  return locations.find((location) => normalizeValue(location.name) === normalized) || null;
}

function findLocationFuzzy(name, locations) {
  let best = null;

  for (const location of locations) {
    const a = normalizeValue(name);
    const b = normalizeValue(location.name);

    let score = 0;

    if (a === b) {
      score = 100;
    } else if (b.startsWith(a) || a.startsWith(b)) {
      score = 90;
    } else if (b.includes(a) || a.includes(b)) {
      score = 75;
    }

    if (!best || score > best.score) {
      best = { location, score };
    }
  }

  return best && best.score >= 70 ? best.location : null;
}

function resolveLocation(locationName, locations) {
  if (!locationName) {
    return null;
  }

  return findLocationByName(locationName, locations) || findLocationFuzzy(locationName, locations);
}

function hasMeaningfulExtraction(extracted) {
  return Boolean(
    extracted?.name ||
      extracted?.matricula ||
      extracted?.title ||
      extracted?.description ||
      extracted?.category ||
      extracted?.priority ||
      extracted?.location_name ||
      extracted?.name_confirmed === true
  );
}

async function persistConversation(phone, state, context) {
  await upsertConversation({ phoneNumber: phone, state, context });
}

async function sendReply({ session, chatId, messageId, text }) {
  await sendSeen({ session, chatId, messageIds: [messageId] });
  await sendText({ session, chatId, text, replyTo: messageId });
}

async function handleIncomingMessage(event) {
  if (event?.event !== "message") {
    return { ignored: true, reason: "unsupported-event" };
  }

  const payload = event.payload || {};
  const messageId = payload.id;

  if (!messageId) {
    return { ignored: true, reason: "missing-message-id" };
  }

  if (isDuplicate(messageId)) {
    return { ignored: true, reason: "duplicate-message" };
  }

  rememberMessage(messageId);

  if (payload.fromMe) {
    return { ignored: true, reason: "outgoing-message" };
  }

  if (!isDirectChat(payload.from)) {
    return { ignored: true, reason: "non-direct-chat" };
  }

  const session = event.session || "default";

  // Verificacao antecipada de human_handoff (precisa so do phone)
  const phoneResolution = await resolveSenderPhone({ payload, session });
  const phone = phoneResolution.phone;

  const messageType = payload.type || payload._data?.type || "chat";
  const isAudio = messageType === "ptt" || messageType === "audio";

  let message = payload.body || "";

  if (isAudio && hasGroqConfig()) {
    console.log("[bot] audio payload media:", JSON.stringify({
      type: messageType,
      body: payload.body ? payload.body.substring(0, 100) : null,
      media: payload.media || null,
      hasFile: payload._data?.filePath || payload._data?.fileUrl || null,
      mediaUrl: payload._data?.mediaUrl || null,
    }));

    try {
      let audioBuffer = null;

      // Caso 1: body já é base64 data URL
      if (payload.body && payload.body.startsWith("data:")) {
        const base64 = payload.body.split(",")[1];
        audioBuffer = Buffer.from(base64, "base64");
      }
      // Caso 2: payload.media.url
      else if (payload.media?.url) {
        audioBuffer = await downloadAudio(payload.media.url, require("./config").wahaApiKey);
      }
      // Caso 3: endpoint de download do WAHA
      else {
        const audioUrl = await getAudioUrl({
          session,
          messageId: payload.id,
          wahaBaseUrl: require("./config").wahaBaseUrl,
          wahaApiKey: require("./config").wahaApiKey
        });
        if (audioUrl) {
          audioBuffer = await downloadAudio(audioUrl);
        }
      }

      if (audioBuffer) {
        const transcription = await transcribeAudio(audioBuffer);
        if (transcription) {
          message = transcription;
          console.log("[bot] audio transcrito:", transcription);
        }
      }
    } catch (error) {
      console.error("[bot] erro ao transcrever audio:", error.message);
    }
  }

  if (!message && isAudio) {
    const reply = "Nao consegui entender o audio. Pode digitar sua mensagem?";
    await sendReply({ session, chatId: payload.from, messageId: payload.id, text: reply });
    return { ignored: false, chatId: payload.from, reply };
  }

  const profile = {
    phone,
    whatsapp_name: payload.pushName || payload.notifyName || payload._data?.notifyName || payload._data?.pushName || null
  };

  const [conversation, locations, deviceTypes] = await Promise.all([
    getConversation(phone),
    getTicketLocations(),
    getDeviceTypes().catch((err) => {
      console.warn("[bot] falha ao buscar device types:", err.message);
      return [];
    })
  ]);

  if (conversation?.state === "human_handoff") {
    const lastActivity = conversation.last_message_at
      ? new Date(conversation.last_message_at).getTime()
      : 0;
    const elapsed = Date.now() - lastActivity;

    if (elapsed < HANDOFF_TIMEOUT_MS) {
      console.log("[bot] human_handoff ativo, ignorando mensagem de", phone);
      return { ignored: true, reason: "human-handoff-active" };
    }

    // Timeout expirado: retoma o bot e continua processando esta mensagem
    console.log("[bot] human_handoff expirado apos", Math.round(elapsed / 1000), "s — retomando bot para", phone);
    const timeoutReply = "O atendente nao esta disponivel no momento. Posso te ajudar por aqui. Como posso te ajudar?";
    await upsertConversation({ phoneNumber: phone, state: "idle", context: { draft: {}, last_reply: null } });
    await sendReply({ session, chatId: payload.from, messageId: payload.id, text: timeoutReply });
    return { ignored: false, chatId: payload.from, reply: timeoutReply };
  }

  let requester = await getRequesterByPhone(phone);

  const prevState = conversation?.state || null;
  let draft = prevState === "ticket_opened" ? {} : conversation?.context?.draft || {};
  const lastReply = conversation?.context?.last_reply || null;

  console.log(
    "[bot] incoming",
    JSON.stringify({
      phone,
      source: phoneResolution.source,
      requesterFound: Boolean(requester),
      requesterMatricula: requester?.matricula || null,
      prevState,
      draftKeys: Object.keys(draft)
    })
  );

  if (!hasMistralConfig()) {
    const reply = "Assistente nao configurado. Contate o administrador.";
    await sendReply({ session, chatId: payload.from, messageId: payload.id, text: reply });
    return { ignored: false, chatId: payload.from, reply };
  }

  const { action, reply, extracted } = await decideNextStep({
    message,
    profile,
    requester,
    draft,
    locations,
    deviceTypes,
    lastReply
  });

  console.log("[bot] llm decision", JSON.stringify({ action, extracted }));

  if (prevState === "collecting" && !hasMeaningfulExtraction(extracted) && action === "OPEN_TICKET") {
    const safeReply = "Ola! Como posso te ajudar?";

    await persistConversation(phone, "idle", {
      draft: {},
      last_reply: safeReply
    });

    await sendReply({
      session,
      chatId: payload.from,
      messageId: payload.id,
      text: safeReply
    });

    return { ignored: false, chatId: payload.from, reply: safeReply };
  }

  draft = mergeDraft(draft, {
    name: extracted.name,
    name_confirmed: extracted.name_confirmed,
    matricula: extracted.matricula,
    title: extracted.title,
    description: extracted.description,
    category: extracted.category,
    priority: extracted.priority,
    location_name: extracted.location_name,
    asset_tag: extracted.asset_tag,
    device_name: extracted.device_name
  });

  if (draft.location_name) {
    const resolved = resolveLocation(draft.location_name, locations);
    draft.location_name = resolved ? resolved.name : null;
  }

  if (!draft.title && draft.description) {
    const generatedTitle = await generateTitle(draft.description);
    draft.title = generatedTitle || draft.description.substring(0, 80);
  }

  if (!requester && draft.name && draft.name_confirmed === true && draft.matricula) {
    requester = await upsertRequesterProfile({
      matricula: draft.matricula,
      fullName: draft.name,
      phone,
      whatsappPhone: phone
    });

    console.log(
      "[bot] requester registered",
      JSON.stringify({
        id: requester?.id,
        matricula: requester?.matricula
      })
    );
  } else if (requester && !requester.matricula && draft.matricula) {
    requester = await upsertRequesterProfile({
      matricula: draft.matricula,
      fullName: requester.full_name,
      phone: requester.phone || phone,
      whatsappPhone: requester.whatsapp_phone || phone
    });
  }

  if (action === "TRANSFER_TO_HUMAN") {
    await persistConversation(phone, "human_handoff", {
      draft,
      last_reply: reply
    });

    await sendReply({
      session,
      chatId: payload.from,
      messageId: payload.id,
      text: reply
    });

    console.log("[bot] transferido para atendente humano:", phone);
    return { ignored: false, chatId: payload.from, reply };
  }

  if (action === "OPEN_TICKET") {
    const location = resolveLocation(draft.location_name, locations);
    const effectiveMatricula = requester?.matricula || draft.matricula;
    const hasConfirmedRequester = Boolean(requester || (draft.name && draft.name_confirmed === true));

    const isHardware = (draft.category || "").toUpperCase() === "HARDWARE";
    const needsDeviceName = isHardware && !draft.device_name;

    const isReady = Boolean(
      location &&
        draft.title &&
        draft.description &&
        draft.priority &&
        effectiveMatricula &&
        hasConfirmedRequester &&
        !needsDeviceName
    );

    if (!isReady) {
      let collectReply;
      if (!hasConfirmedRequester && draft.name) {
        collectReply = `Seu nome e ${draft.name}, correto?`;
      } else if (!hasConfirmedRequester) {
        collectReply = "Qual e o seu nome?";
      } else if (!effectiveMatricula) {
        collectReply = "Pode me informar sua matricula?";
      } else if (!draft.description) {
        collectReply = "Qual e o problema que esta enfrentando?";
      } else if (!location) {
        collectReply = "Em qual setor voce esta?";
      } else if (needsDeviceName) {
        collectReply = "Qual equipamento esta com problema?";
      } else if (!draft.priority) {
        collectReply = "Isso esta te impedindo de trabalhar agora?";
      } else {
        collectReply = "Faltam algumas informacoes. Pode me dizer em qual setor voce esta?";
      }

      await persistConversation(phone, "collecting", {
        draft,
        last_reply: collectReply
      });

      await sendReply({
        session,
        chatId: payload.from,
        messageId: payload.id,
        text: collectReply
      });

      return { ignored: false, chatId: payload.from, reply: collectReply };
    }

    const PRIORITY_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
    const llmPriority = draft.priority || DEFAULT_PRIORITY;
    const autoPriority = inferPriority(location.name, draft.description);
    const effectivePriority =
      autoPriority && (PRIORITY_RANK[autoPriority] > PRIORITY_RANK[llmPriority])
        ? autoPriority
        : llmPriority;

    if (autoPriority && autoPriority !== llmPriority) {
      console.log("[bot] prioridade elevada automaticamente:", llmPriority, "→", effectivePriority, "| setor:", location.name);
    }

    const ticketPayload = {
      matricula: effectiveMatricula,
      requester_name:
        requester?.full_name ||
        (draft.name_confirmed === true ? draft.name : null) ||
        "Nao informado",
      requester_email: requester?.email || "",
      requester_phone: requester?.phone || phone,
      requester_whatsapp_phone: requester?.whatsapp_phone || phone,
      title: draft.title,
      description: draft.description,
      category: draft.category || DEFAULT_CATEGORY,
      priority: effectivePriority,
      location_name: location.name,
      asset_tag: draft.asset_tag || "",
      device_name: draft.device_name || (isHardware ? "" : "Outro")
    };

    const result = await openTicket(ticketPayload);
    const ticket = result.ticket;

    await persistConversation(phone, "ticket_opened", {
      draft,
      ticket
    });

    const finalReply = `${reply}\n\nNumero: ${ticket.ticket_number}. Status: ${ticket.status}.`;
    await sendReply({
      session,
      chatId: payload.from,
      messageId: payload.id,
      text: finalReply
    });

    return { ignored: false, chatId: payload.from, reply: finalReply };
  }

  const nextState = action === "OUT_OF_SCOPE" ? "idle" : "collecting";

  await persistConversation(phone, nextState, {
    draft,
    last_reply: reply
  });

  await sendReply({
    session,
    chatId: payload.from,
    messageId: payload.id,
    text: reply
  });

  return { ignored: false, chatId: payload.from, reply };
}

async function resumeStaleHandoffs({ session }) {
  const stale = await getStaleHandoffConversations(HANDOFF_TIMEOUT_MS);

  for (const conv of stale) {
    const phone = conv.phone_number;
    const chatId = `${phone}@c.us`;

    try {
      await upsertConversation({ phoneNumber: phone, state: "idle", context: { draft: {}, last_reply: null } });
      await sendText({ session, chatId, text: "O atendente nao esta disponivel no momento. Posso te ajudar por aqui. Como posso te ajudar?" });
      console.log("[bot] handoff expirado retomado automaticamente para", phone);
    } catch (error) {
      console.error("[bot] erro ao retomar handoff para", phone, error.message);
    }
  }

  return stale.length;
}

module.exports = {
  handleIncomingMessage,
  resumeStaleHandoffs
};
