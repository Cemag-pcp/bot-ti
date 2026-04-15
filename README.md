# Bot local com WAHA

Projeto base para rodar um bot de WhatsApp localmente usando WAHA como gateway HTTP, um servidor Node.js para processar webhooks e a API da Mistral para responder mensagens.

## O que este projeto entrega

- WAHA rodando em Docker na porta `3000`
- bot Node.js rodando localmente na porta `3001`
- respostas via Mistral para mensagens recebidas
- persistencia em PostgreSQL para contatos, historico e notas
- endpoints HTTP para inserir e editar dados do cliente

## Requisitos

- Node.js 18+
- Docker Desktop com `docker-compose`
- acesso ao PostgreSQL configurado no `.env`

## Instalacao

1. Copie o arquivo de ambiente:

```powershell
Copy-Item .env.example .env
```

2. Ajuste no `.env`:

- `MISTRAL_API_KEY`
- `MISTRAL_MODEL`
- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `DB_SCHEMA`

3. Instale as dependencias:

```powershell
npm install
```

4. Suba o WAHA:

```powershell
docker-compose up -d
```

5. Inicie o bot:

```powershell
npm start
```

6. Em outro terminal, crie ou atualize a sessao do WAHA:

```powershell
npm run setup:session
```

7. Abra o QR code no navegador e faca o pareamento:

```text
http://localhost:3000/api/screenshot?session=default
```

## Como funciona o banco

O bot grava:

- contato por `chat_id`
- mensagem recebida
- mensagem enviada
- notas do cliente

A Mistral recebe junto:

- notas salvas do contato
- historico recente da conversa
- mensagem atual

## Endpoints locais

- `GET http://localhost:3001/health`
- `POST http://localhost:3001/webhook/waha`
- `GET http://localhost:3001/api/db/contacts/:chatId`
- `GET http://localhost:3001/api/db/contacts/:chatId/messages?limit=20`
- `GET http://localhost:3001/api/db/contacts/:chatId/notes`
- `POST http://localhost:3001/api/db/contacts/:chatId/notes`
- `PUT http://localhost:3001/api/db/notes/:id`

## Exemplos de input e edit no banco

Criar uma nota:

```powershell
curl.exe -X POST "http://localhost:3001/api/db/contacts/63453846831218@lid/notes" `
  -H "Content-Type: application/json" `
  -d "{\"title\":\"Cliente VIP\",\"content\":\"Prefere atendimento rapido e quer proposta comercial.\"}"
```

Editar uma nota:

```powershell
curl.exe -X PUT "http://localhost:3001/api/db/notes/1" `
  -H "Content-Type: application/json" `
  -d "{\"content\":\"Cliente VIP. Quer proposta comercial ainda hoje.\"}"
```

Consultar historico:

```powershell
curl.exe "http://localhost:3001/api/db/contacts/63453846831218@lid/messages?limit=10"
```

## Observacoes

- o bot responde apenas a conversas diretas e ignora mensagens enviadas pela propria sessao
- o schema do banco e criado automaticamente na subida
- as tabelas sao criadas automaticamente na primeira execucao
