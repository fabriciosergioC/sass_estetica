# Upgrade do Baileys 6.7.24 → 7.x (patch preparado, ainda NÃO aplicado)

Documento de migração verificado contra o tarball real `@whiskeysockets/baileys@7.0.0-rc14`
(baixado com `npm pack` em pasta temporária, sem tocar no `node_modules` do projeto).
O projeto continua em `^6.7.24` — nada aqui foi instalado.

## Por que subir para a 7

1. **LID/número de usuário.** Desde 2025 o WhatsApp identifica conta por `@lid`, não por
   `@s.whatsapp.net`. A linha 6.x (`legacy` no npm) não trata isso direito: o eco das
   mensagens que o barbeiro manda pelo celular chega com o nosso próprio `@lid` e o
   `process-message` quebra com `Cannot read properties of null (reading 'toString')`
   (visto em `iniciar.log:173`, dentro de `@cacheable/node-cache` 1.7.6). Por isso temos
   `shouldIgnoreJid` ignorando o próprio LID e `WHATSAPP_USE_LID=0` desligado — são
   contornos, não correção. Na 7 o envio/decodificação em `@lid` é caminho nativo
   (`WAUSync`, `companion-reg-client-utils`, `identity-change-handler`).
2. **Dependência de git removida.** A 6.x puxa `libsignal` por
   `git+https://github.com/whiskeysockets/libsignal-node`; a 7 usa
   `whatsapp-rust-bridge@0.5.4` do registry.
3. **Deriva de dependência.** A 6.x declara `@cacheable/node-cache: ^1.4.0` e aqui está
   instalado **1.7.6** — é exatamente onde o crash acima acontece. Na 7 o range é o mesmo,
   então o pin continua sendo uma boa ideia (ver "Pin opcional" abaixo).

## O que muda (e o que NÃO muda) para o nosso código

Fui conferir item por item os 9 nomes que `src/modules/whatsapp/baileys/provider.ts` importa:

| Símbolo usado | Existe na 7.0.0-rc14? | Observação |
|---|---|---|
| `makeWASocket` | sim | continua nomeado **e** default |
| `WASocket` (type) | sim | `ReturnType<typeof makeWASocket>` |
| `useMultiFileAuthState` | sim | mesma assinatura: `{ state, saveCreds }` |
| `DisconnectReason` | sim | mesmos códigos: 401/408/411/428/440/500/503/515 |
| `fetchLatestBaileysVersion` | sim | agora aceita `options?: RequestInit`; o retorno é `{ version, isLatest, error? }` (sem `shouldReconnect`) |
| `proto` | sim | vem de `WAProto` |
| `delay` | sim | `Utils/generics` |
| `jidNormalizedUser` | sim | `WABinary/jid-utils` |
| `extractMessageContent` | sim | `Utils/messages` |

Configuração do socket usada por nós — `version`, `auth`, `logger`, `browser`,
`shouldIgnoreJid` — todos continuam em `SocketConfig`. Eventos usados (`connection.update`,
`creds.update`, `messages.upsert`, `messages.update`) estão no `BaileysEventMap` da 7.
Métodos usados (`sendMessage`, `onWhatsApp`, `logout`, `end`) também existem.

Pontos de atenção reais:

- `sock.end(error)` passou a exigir o argumento posicional. Já chamamos `end(undefined)` — **ok**.
- `onWhatsApp` na 7 tem tipo declarado `{ jid, exists }[]`; o campo `lid` que o runtime
  devolve não está no tipo. Nosso `resolveJid` já trata isso como `any`, então não quebra.
  Se a 7 tipar `lid`, vale remover o cast.
- `mobile` e `printQRInTerminal` estão `@deprecated` (removidos). Não usamos.
- `whatsapp-rust-bridge` é **ESM-only** e embute o `.wasm` em base64 dentro de
  `dist/index.js` (~2 MB). Não há compilação nativa nem `node-gyp`, então Windows não é
  problema — mas o `require()` de um módulo ESM só funciona bem em Node ≥ 22.12
  (aqui é Node 24.22.1, ok).

## Como aplicar (passo a passo, com rollback)

Não há git neste projeto, então o backup manual é obrigatório.

```bat
cd /d "C:\Users\fabri\OneDrive\Documentos\sass barbearia"

:: 1. App parado. Se estiver rodando pelo iniciar.bat, feche a janela antes.
:: 2. Backup do estado atual (só manifests; node_modules e baileys_auth_* ficam intactos)
copy package.json        "%TEMP%\pkg.json.bak"
copy package-lock.json   "%TEMP%\pkg-lock.json.bak"

:: 3. Upgrade
npm install @whiskeysockets/baileys@7.0.0-rc14

:: 4. typecheck (os erros conhecidos de scripts/diagnose-baileys.ts já existiam antes)
npx tsc --noEmit
```

Depois do `npm install`, confira `next.config.ts` — `whatsapp-rust-bridge` (e `sharp`,
`detect-libc`, `audio-decode`, `link-preview-js`, `libsignal`) **já estão** em
`serverExternalPackages` desde a correção de 27/10, então normalmente não há nada a mudar:

```ts
serverExternalPackages: [
  "@whiskeysockets/baileys", "whatsapp-rust-bridge", "sharp", "detect-libc",
  "audio-decode", "link-preview-js", "libsignal", "qrcode",
],
```

E só então ligue o caminho LID de verdade, no `.env`:

```
WHATSAPP_USE_LID=1
```

### Sessão pareada

`baileys_auth_<orgId>/creds.json` é só JSON em disco e é lido pela 7 sem conversão.
Mesmo assim, trate o teste como "pode precisar escanear QR de novo": se a 7 rejeitar a
credenzial da 6, o caminho é `POST /api/whatsapp { "action": "reconnect" }` (gera QR novo)
em vez de apagar a pasta na mão.

### Rollback

```bat
copy "%TEMP%\pkg.json.bak"      package.json
copy "%TEMP%\pkg-lock.json.bak" package-lock.json
npm install
```

Mantenha a pasta `baileys_auth_*` original copiada antes do teste; se a 7 reescrever
`keys.json` e você voltar para a 6, vale reconectar por QR.

## Pin opcional (vale para 6.x e 7.x)

```bat
npm install -E @cacheable/node-cache@1.4.0
```

Motivo: o range `^1.4.0` deixou subir 1.7.6, que é onde `NodeCache.formatKey` estoura com
chave nula no processamento de mensagem. Se preferir não pinar, o `shouldIgnoreJid` atual
já evita o caso específico do próprio LID.

## Checklist de validação (o que prova que funcionou)

1. `npm run dev` (ou `iniciar.bat`) → aparecem no log `[Worker] 🟢 Fila de jobs ativa…` e,
   do Baileys, `CONNECTED` com a sessão existente.
2. Mande uma mensagem pelo painel a um contato **salvo** e confira o log de envio:
   `[Baileys] 📤 enviada … (alvo=phone)` ou `(alvo=lid)`.
3. A prova de que o bug acabou é o recibo: `📩 recibo … → DELIVERED` (e depois `READ`).
   Só `SENT` sem `DELIVERED` = ainda tem número errado ou mapeamento de jid estranho.
4. O log novo de `resolveJid` imprime o array inteiro quando o WhatsApp responde uma
   entrada que não é o número consultado — isso encerra a dúvida se era chat errado ou
   mapeamento legítimo.

**Não rode** `scripts/diagnose-baileys.ts` nem `scripts/test-baileys-send.ts` com o
`npm run dev` ativo: um segundo socket na mesma pasta `baileys_auth_*` expulsa a sessão em
uso (`440 connectionReplaced`) e corrompe credencial.
