const { Pool } = require("pg");
const config = require("./config");

const pool = new Pool({
  host: config.dbHost,
  port: config.dbPort,
  database: config.dbName,
  user: config.dbUser,
  password: config.dbPassword,
  ssl: {
    rejectUnauthorized: false
  }
});

function q(name) {
  return `"${String(name).replace(/"/g, "\"\"")}"`;
}

function publicTable(name) {
  return `${q(config.dbSchema || "public")}.${q(name)}`;
}

async function query(text, params = []) {
  return pool.query(text, params);
}

async function initDatabase() {
  const requiredTables = [
    { schema: config.dbSchema || "public", name: "accounts_requesterprofile" },
    { schema: config.dbSchema || "public", name: "tickets_location" },
    { schema: config.dbSchema || "public", name: "tickets_whatsappconversation" },
    { schema: config.dbSchema || "public", name: "tickets_ticket" }
  ];

  for (const item of requiredTables) {
    const result = await query(
      `
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name = $2
      `,
      [item.schema, item.name]
    );

    if (result.rowCount === 0) {
      throw new Error(`Tabela obrigatoria ausente: ${item.schema}.${item.name}`);
    }
  }
}

function extractPhone(chatId) {
  return String(chatId || "").replace(/\D/g, "");
}

function findPhoneCandidates(value, results = new Set()) {
  if (value == null) {
    return results;
  }

  if (typeof value === "string") {
    const digits = value.replace(/\D/g, "");

    if (digits.length >= 10 && digits.length <= 15) {
      results.add(digits);
    }

    return results;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      findPhoneCandidates(item, results);
    }

    return results;
  }

  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      findPhoneCandidates(item, results);
    }
  }

  return results;
}

function extractBestPhone(payload) {
  const prioritySources = [
    payload?.sender,
    payload?.participant,
    payload?.author,
    payload?.chatId,
    payload?.chat?.id
  ];

  for (const source of prioritySources) {
    if (typeof source === "string" && source.endsWith("@lid")) {
      continue;
    }

    const digits = String(source || "").replace(/\D/g, "");

    if (digits.length >= 10 && digits.length <= 15) {
      return digits;
    }
  }

  const sanitizedPayload = JSON.parse(
    JSON.stringify(payload || {}, (key, value) => {
      if (typeof value === "string" && value.endsWith("@lid")) {
        return null;
      }

      return value;
    })
  );

  const candidates = Array.from(findPhoneCandidates(sanitizedPayload));

  const prioritized =
    candidates.find((item) => item.startsWith("55") && item.length >= 12) ||
    candidates.find((item) => item.length >= 12) ||
    candidates.find((item) => item.length >= 10) ||
    "";

  return prioritized;
}

async function getRequesterByPhone(phone) {
  const normalizedPhone = String(phone || "").replace(/\D/g, "");

  const result = await query(
    `
      SELECT *
      FROM ${publicTable("accounts_requesterprofile")}
      WHERE
        regexp_replace(coalesce(whatsapp_phone, ''), '\D', '', 'g') = $1
        OR regexp_replace(coalesce(phone, ''), '\D', '', 'g') = $1
        OR regexp_replace(coalesce(whatsapp_phone, ''), '\D', '', 'g') LIKE '%' || $1
        OR regexp_replace(coalesce(phone, ''), '\D', '', 'g') LIKE '%' || $1
        OR $1 LIKE '%' || regexp_replace(coalesce(whatsapp_phone, ''), '\D', '', 'g')
        OR $1 LIKE '%' || regexp_replace(coalesce(phone, ''), '\D', '', 'g')
      ORDER BY
        CASE
          WHEN regexp_replace(coalesce(whatsapp_phone, ''), '\D', '', 'g') = $1 THEN 1
          WHEN regexp_replace(coalesce(phone, ''), '\D', '', 'g') = $1 THEN 2
          WHEN regexp_replace(coalesce(whatsapp_phone, ''), '\D', '', 'g') LIKE '%' || $1 THEN 3
          WHEN regexp_replace(coalesce(phone, ''), '\D', '', 'g') LIKE '%' || $1 THEN 4
          ELSE 5
        END
      LIMIT 1
    `,
    [normalizedPhone]
  );

  return result.rows[0] || null;
}

async function upsertRequesterProfile({ matricula, fullName, email, phone, whatsappPhone }) {
  const safeName = String(fullName || "").trim() || `Solicitante ${whatsappPhone || phone || ""}`.trim();
  const safeEmail = String(email || "").trim();
  const safePhone = String(phone || whatsappPhone || "").trim();
  const safeWhatsappPhone = String(whatsappPhone || phone || "").trim();

  const existing = await getRequesterByPhone(safeWhatsappPhone || safePhone);

  if (existing) {
    const result = await query(
      `
        UPDATE ${publicTable("accounts_requesterprofile")}
        SET
          matricula = COALESCE($1, matricula),
          full_name = COALESCE(NULLIF($2, ''), full_name),
          email = COALESCE(NULLIF($3, ''), email),
          phone = COALESCE(NULLIF($4, ''), phone),
          whatsapp_phone = COALESCE(NULLIF($5, ''), whatsapp_phone),
          updated_at = NOW()
        WHERE id = $6
        RETURNING *
      `,
      [matricula || null, safeName, safeEmail, safePhone, safeWhatsappPhone, existing.id]
    );

    return result.rows[0] || null;
  }

  const result = await query(
    `
      INSERT INTO ${publicTable("accounts_requesterprofile")} (
        matricula,
        full_name,
        email,
        phone,
        whatsapp_phone,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      RETURNING *
    `,
    [
      matricula,
      safeName,
      safeEmail,
      safePhone,
      safeWhatsappPhone
    ]
  );

  return result.rows[0] || null;
}

async function getTicketLocations() {
  const result = await query(
    `
      SELECT id, name, description
      FROM ${publicTable("tickets_location")}
      WHERE is_active = TRUE
      ORDER BY name
    `
  );

  return result.rows;
}

async function getConversation(phoneNumber) {
  const result = await query(
    `
      SELECT *
      FROM ${publicTable("tickets_whatsappconversation")}
      WHERE phone_number = $1
      LIMIT 1
    `,
    [phoneNumber]
  );

  return result.rows[0] || null;
}

async function upsertConversation({ phoneNumber, state, context }) {
  const result = await query(
    `
      INSERT INTO ${publicTable("tickets_whatsappconversation")} (
        phone_number,
        state,
        context,
        last_message_at,
        created_at
      )
      VALUES ($1, $2, $3::jsonb, NOW(), NOW())
      ON CONFLICT (phone_number) DO UPDATE SET
        state = EXCLUDED.state,
        context = EXCLUDED.context,
        last_message_at = NOW()
      RETURNING *
    `,
    [phoneNumber, state, JSON.stringify(context || {})]
  );

  return result.rows[0] || null;
}

async function getStaleHandoffConversations(thresholdMs) {
  const result = await query(
    `
      SELECT *
      FROM ${publicTable("tickets_whatsappconversation")}
      WHERE state = 'human_handoff'
        AND last_message_at < NOW() - ($1 || ' milliseconds')::interval
    `,
    [String(thresholdMs)]
  );

  return result.rows;
}

module.exports = {
  extractBestPhone,
  extractPhone,
  getConversation,
  getRequesterByPhone,
  getStaleHandoffConversations,
  getTicketLocations,
  initDatabase,
  upsertRequesterProfile,
  upsertConversation
};
