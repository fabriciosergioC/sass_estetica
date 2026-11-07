# Diagnóstico do Problema WhatsApp

## Problema Identificado

O seu arquivo `.env` tem:
```env
WHATSAPP_PROVIDER="baileys"
```

Mas no banco de dados, **todas as organizações têm `provider: "DEV"`**:

| Organização | Provider no Banco | Status |
|-------------|-------------------|--------|
| Barbearia Navalha de Ouro | DEV | DISCONNECTED |
| Studio Barber Club | DEV | DISCONNECTED |
| Dom Barber House | DEV | DISCONNECTED |
| Barbearia Imperial | DEV | CONNECTED |
| Test WhatsApp Org | DEV | CONNECTED |

## Por que as mensagens não chegam no número real?

1. **O provedor DEV apenas SIMULA** o envio - retorna `ok: true` mas não envia nada para o WhatsApp real
2. **O código lê o provider do banco** (`conn?.provider`), não da variável de ambiente
3. **O menu do WhatsApp** usa a API `/api/whatsapp/test` que cria mensagem + job → processa com provider DEV → marca como SENT (falso positivo)

## Como o fluxo funciona

```
Menu WhatsApp → POST /api/whatsapp/test
  → Cria WhatsAppMessage (status: QUEUED)
  → enqueueJob(type: "send_whatsapp")
  → processJobs() roda handleSendWhatsapp()
  → getWhatsAppProvider(conn.provider) → pega "DEV" do banco
  → DevProvider.sendMessage() → simula envio
  → Atualiza status para SENT (mas não enviou nada!)
```

## Soluções

### Opção 1: Usar Baileys (WhatsApp Web real) ✅ RECOMENDADO
Para cada organização que quiser enviar mensagens reais:

1. Atualizar o provider no banco para `"baileys"`
2. Conectar via interface web: POST `/api/whatsapp` com `{ action: "connect" }`
3. Escanear QR Code com o WhatsApp do celular
4. Aguardar status `CONNECTED`

### Opção 2: Manter DEV apenas para testes
- Mensagens pelo menu mostrarão como "enviadas" no painel
- Mas **não chegam no WhatsApp real**
- Útil apenas para desenvolvimento/teste de templates

### Opção 3: Usar outro provedor (Evolution, Meta Cloud, Z-API)
- Configurar variáveis no `.env`
- Atualizar provider no banco
- Requer conta/integração externa

## Script de Correção

Execute este script para atualizar a Barbearia Imperial para Baileys:

```typescript
// scripts/switch-to-baileys.ts
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

await db.whatsAppConnection.update({
  where: { orgId: "cmuqps9by0001w6uovq91q77x" },
  data: { provider: "baileys", status: "DISCONNECTED" }
});
console.log("✅ Provider alterado para baileys");
```

Depois conecte via API ou interface web.