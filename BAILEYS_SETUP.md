# Configuração Baileys - SaaS Barbearia

## 📋 Visão Geral

O **Baileys** é uma biblioteca TypeScript/JavaScript para WhatsApp Web que permite conectar diretamente ao WhatsApp sem depender de APIs externas. É open source, gratuito e roda localmente no seu servidor.

### Vantagens:
- ✅ **Gratuito** - Sem custos de API
- ✅ **Sem servidor extra** - Roda direto no Next.js
- ✅ **Controle total** - Sua instância, seus dados
- ✅ **Multi-dispositivo** - Funciona com WhatsApp Web multi-device
- ✅ **Open Source** - Código transparente

---

## ⚙️ Configuração no SaaS Barbearia

### 1. Arquivo `.env` já configurado:

```env
WHATSAPP_PROVIDER="baileys"
# Baileys não precisa de mais configurações!
# A autenticação é salva localmente em ./baileys_auth_<orgId>/
```

### 2. Reiniciar o sistema:

```bash
# Pare com Ctrl+C e execute novamente
.\iniciar.bat
```

---

## 📱 Conectar WhatsApp (Primeira Vez)

### Via Painel Web:
1. Acesse: `http://localhost:3001/app/whatsapp`
2. Clique em **"Conectar"**
3. Um **QR Code** será exibido
4. Abra WhatsApp no celular → **Aparelhos conectados** → **Conectar aparelho**
5. Escaneie o QR Code
6. Pronto! Status muda para **"CONECTADO"**

### Via API (para automação):
```bash
# Iniciar conexão
curl -X POST http://localhost:3001/api/whatsapp \
  -H "Content-Type: application/json" \
  -d '{"action": "connect"}'

# Ver QR Code
curl http://localhost:3001/api/whatsapp/qr
```

---

## 🧪 Testar Envio

### Via Painel:
1. Acesse `/app/whatsapp`
2. Vá na aba **"Teste de Envio"**
3. Digite seu número (ex: `5511999999999`)
4. Digite uma mensagem
5. Clique em **"Enviar Teste"**

### Via API:
```bash
curl -X POST http://localhost:3001/api/whatsapp/test \
  -H "Content-Type: application/json" \
  -d '{"phone": "5511999999999", "message": "Teste Baileys!"}'
```

---

## 🔄 Como Funciona

### Fluxo de Envio:
```
1. Usuário envia mensagem (painel ou automação)
         ↓
2. Sistema cria registro no banco (status: QUEUED)
         ↓
3. Job assíncrono é agendado (enqueueJob)
         ↓
4. processJobs() executa (via after() ou /api/cron)
         ↓
5. Baileys envia via WhatsApp Web socket
         ↓
6. Status atualizado para SENT/FAILED
         ↓
7. Webhook interno atualiza banco
```

### Recebimento de Mensagens:
- Baileys mantém conexão WebSocket persistente
- Eventos `messages.upsert` capturam mensagens recebidas
- Mensagens salvas automaticamente no banco
- Clientes criados automaticamente se não existirem

---

## 📁 Estrutura de Arquivos

```
src/modules/whatsapp/
├── provider.ts              # Factory de provedores (proxy Baileys)
├── baileys/
│   └── provider.ts          # Implementação Baileys completa
├── messages.ts              # Templates e formatação
└── messages/                # Templates padrão
```

### Autenticação Persistente:
- Credenciais salvas em: `./baileys_auth_{orgId}/`
- **Não apague essa pasta** - contém sessão do WhatsApp
- Se apagar, precisa escanear QR Code novamente

---

## 🛠️ Comandos Úteis

### Verificar Status:
```bash
curl http://localhost:3001/api/whatsapp
```

### Desconectar:
```bash
curl -X POST http://localhost:3001/api/whatsapp \
  -H "Content-Type: application/json" \
  -d '{"action": "disconnect"}'
```

### Processar Jobs Pendentes:
```bash
curl -X POST http://localhost:3001/api/cron \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: seu-cron-secret-super-seguro-aqui"
```

### Ver Logs do Baileys:
No terminal onde roda `npm run dev`, procure por:
```
[Baileys] Versão: x.x.x, Latest: true
[Baileys] QR Code gerado - escaneie com WhatsApp
[Baileys] Conectado com sucesso!
```

---

## 🔧 Troubleshooting

### "Baileys não conectado"
1. Verifique se escaneou QR Code
2. Verifique logs no terminal
3. Tente desconectar e conectar novamente

### QR Code não aparece
1. Aguarde alguns segundos após clicar "Conectar"
2. Verifique console do navegador (F12)
3. Verifique logs do servidor

### Mensagens não chegam
1. Verifique se status é `CONNECTED`
2. Verifique número do telefone (formato: 5511999999999)
3. Verifique logs de erro no terminal

### Erro de autenticação
```bash
# Resetar autenticação (apaga sessão)
rm -rf ./baileys_auth_*
# Reconectar normalmente
```

### Conexão cai frequentemente
- Baileys reconecta automaticamente
- Verifique conexão com internet
- WhatsApp Web pode desconectar se celular sem internet

---

## ⚠️ Limitações Conhecidas

| Limitação | Detalhes |
|-----------|----------|
| **Uma instância por org** | Cada barbearia precisa de sua própria conexão |
| **Celular precisa estar online** | WhatsApp Web requer celular conectado |
| **Rate limiting** | WhatsApp pode bloquear envios em massa |
| **Sem API oficial** | Não é API oficial Meta, pode quebrar com updates |

---

## 🔒 Produção (Checklist)

- [ ] Use PM2 ou similar para manter processo rodando
- [ ] Configure backup da pasta `baileys_auth_*`
- [ ] Monitore logs de desconexão
- [ ] Configure restart automático em falhas
- [ ] Use Redis para fila de jobs em múltiplas instâncias
- [ ] Considere Evolution API para alta escala

---

## 📚 Recursos

- **GitHub Baileys**: https://github.com/WhiskeySockets/Baileys
- **Documentação**: https://baileys.wiki/
- **Exemplos**: https://github.com/WhiskeySockets/Baileys/tree/master/examples
- **Discord**: https://discord.gg/baileys

---

## 🚀 Próximos Passos

1. ✅ Baileys implementado e configurado
2. 🔲 Conectar WhatsApp (escanear QR)
3. 🔲 Testar envio/recebimento
4. 🔲 Configurar templates de mensagem
5. 🔲 Automatizar lembretes de agendamento
6. 🔲 Configurar webhook para receber mensagens (já funciona automaticamente)

---

## 📝 Notas Importantes

1. **Primeira conexão**: Pode demorar 10-30 segundos para gerar QR
2. **Reconexão**: Automática a cada 5 segundos se cair
3. **Multi-device**: Funciona com WhatsApp Web multi-dispositivo
4. **Dados locais**: Tudo fica no seu servidor, nenhum dado sai
5. **Sem custo**: Zero custos de API, apenas seu servidor

---

**Sistema pronto para usar Baileys nativamente!** 🎉

Basta executar `.\iniciar.bat`, acessar `/app/whatsapp` e escanear o QR Code.