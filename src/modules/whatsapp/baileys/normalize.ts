import { extractMessageContent, jidNormalizedUser, proto } from "@whiskeysockets/baileys";
import { toWhatsAppDigits } from "@/lib/phone";
import type { DeliveryStatus, MessageType, NormalizedMessage } from "../types";

/**
 * Tradução do formato cru do WhatsApp Web (proto.IWebMessageInfo) para o vocabulário
 * canônico da integração (§11, §16).
 *
 * Fica num arquivo separado porque é usado por dois lados: pelo socket (que recebe a
 * mensagem e entrega ao serviço) e pelo `BarielsAdapter.normalizeRaw` (que precisa
 * normalizar um payload que chegou por fora, ex.: replay de webhook). Nenhum dos dois
 * pode conhecer o formato do outro provider — é isso que permite trocar de API depois.
 */

/**
 * Texto real da mensagem.
 * O Baileys só desempacota future-proof/view-once/efêmera dentro de `extractMessageContent`;
 * mensagem sincronizada entre os aparelhos da conta vem dentro de `deviceSentMessage.message`,
 * e ler direto dava undefined — por isso toda mensagem aparecia como "[Mídia]" no histórico.
 */
export function bodyFromMessage(message: proto.IWebMessageInfo): string {
  const raw = message.message as any;
  const content = extractMessageContent(
    raw?.deviceSentMessage?.message ? raw.deviceSentMessage.message : raw
  ) as any;
  if (!content) return "[Mensagem sem conteúdo]";

  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    content.listMessage?.description ??
    content.buttonsResponseMessage?.selectedDisplayText ??
    content.templateButtonReplyMessage?.selectedId ??
    null;
  if (text) return text;

  const LABELS: Record<string, string> = {
    imageMessage: "[Foto]",
    videoMessage: "[Vídeo]",
    audioMessage: "[Áudio]",
    stickerMessage: "[Figinha]",
    documentMessage: "[Documento]",
    locationMessage: "[Localização]",
    contactMessage: "[Contato]",
    reactionMessage: "[Reação]",
    protocolMessage: "[Atualização]",
  };
  const tipo = Object.keys(content).find((k) => LABELS[k]);
  return tipo ? LABELS[tipo] : "[Mensagem]";
}

/** Tipo canônico da mensagem + metadados de mídia, quando houver. */
export function typeFromMessage(message: proto.IWebMessageInfo): {
  messageType: MessageType;
  media?: NormalizedMessage["media"];
} {
  const raw = message.message as any;
  const content = extractMessageContent(
    raw?.deviceSentMessage?.message ? raw.deviceSentMessage.message : raw
  ) as any;

  const map: [string, MessageType][] = [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["audioMessage", "audio"],
    ["documentMessage", "document"],
    ["stickerMessage", "sticker"],
    ["locationMessage", "location"],
  ];

  for (const [key, kind] of map) {
    const node = content?.[key];
    if (!node) continue;
    return {
      messageType: kind,
      media: {
        kind,
        // O anexo fica cifrado no servidor; a URL aparece aqui quando o WhatsApp já a
        // baixou para o aparelho (directPath). Sem ela, a tela mostra o tipo e nada mais.
        url: node.url ?? null,
        mimeType: node.mimetype ?? null,
        fileName: node.fileName ?? null,
        sizeBytes: typeof node.fileLength === "number" ? node.fileLength : null,
      },
    };
  }

  if (content?.conversation || content?.extendedTextMessage) return { messageType: "text" };
  return { messageType: "unknown" };
}

/**
 * Mensagem do WhatsApp Web → evento normalizado.
 *
 * `@lid` é tratado com cuidado deliberado: desde a migração para usernames, contatos fora
 * da agenda chegam mascarados como `<id>@lid`, e aqueles dígitos NÃO são telefone. Criar
 * cliente com eles foi o que gerou cadastro lixo no ambiente de teste.
 *
 * `remoteJidAlt` é a outra metade dessa história: quando o WhatsApp endereça a conversa por
 * um domínio, ele costuma trazer o outro no mesmo `key`. Aproveitar isso é o que permite
 * reconhecer a mesma pessoa em `@lid` e `@s.whatsapp.net` — sem esse campo o par fica
 * órfão e a tela abre uma segunda conversa para o mesmo cliente. Ler de `key` como `any`
 * porque o tipo oficial da rc14 não expõe o campo; se ele não vier, seguimos como antes.
 */
export function normalizeWebMessage(message: proto.IWebMessageInfo): NormalizedMessage | null {
  const jid = message.key?.remoteJid;
  if (!jid || !message.key?.id) return null;

  // Mensagens de protocolo (troca de chaves, edição, exclusão) não são conversa: viravam
  // linhas "[Atualização]" enviadas por engano nos indicadores ("Enviadas hoje"/entrega).
  // O WhatsApp reenvia várias delas ao sincronizar o histórico — por isso eram 12 de uma vez.
  const rawContent = message.message as any;
  const protocolContent = extractMessageContent(
    rawContent?.deviceSentMessage?.message ? rawContent.deviceSentMessage.message : rawContent
  ) as any;
  if (protocolContent?.protocolMessage) return null;

  const altJid = (message.key as any)?.remoteJidAlt as string | undefined;
  // Preferimos o número real como identidade; o @lid fica guardado à parte no contato.
  const pnJid =
    jid.endsWith("@lid") && altJid && altJid.endsWith("@s.whatsapp.net")
      ? altJid
      : jid.endsWith("@s.whatsapp.net")
      ? jid
      : null;

  const masked = jid.endsWith("@lid");
  const phone = pnJid ? toWhatsAppDigits(jidNormalizedUser(pnJid).replace(/\D/g, "")) : null;
  const { messageType, media } = typeFromMessage(message);

  return {
    jid,
    altJid: altJid ?? null,
    phone,
    masked,
    direction: message.key.fromMe ? "outgoing" : "incoming",
    messageType,
    text: bodyFromMessage(message),
    providerMsgId: message.key.id,
    timestampSec: message.messageTimestamp
      ? Number(
          typeof (message.messageTimestamp as any).toNumber === "function"
            ? (message.messageTimestamp as any).toNumber()
            : message.messageTimestamp
        )
      : undefined,
    pushName: message.pushName ?? null,
    media,
  };
}

/**
 * ACK do WhatsApp → status que gravamos na mensagem.
 * "SENT" aqui significa apenas que o SERVIDOR do WhatsApp aceitou o texto (SERVER_ACK).
 * Só vira DELIVERED quando o celular do destinatário confirma o recebimento. Confundir os
 * dois esconde problemas reais (número sem conta, destinatário bloqueando, sessão em review).
 *
 * PENDING = "o frame saiu do nosso socket, mas o servidor não devolveu <ack>" — é exatamente
 * o caso que passou meses disfarçado de "enviada".
 */
export const ACK_TO_STATUS: Record<string, DeliveryStatus> = {
  ERROR: "failed",
  PENDING: "pending",
  SERVER_ACK: "sent",
  DELIVERY_ACK: "delivered",
  READ: "read",
  PLAYED: "read",
};

/** O Baileys devolve o status como enum numérico ou como string, dependendo do caminho. */
export function normalizeAck(status: unknown): string | null {
  if (status == null) return null;
  if (typeof status === "string") return status.toUpperCase();
  if (typeof status === "number") {
    const names: Record<number, string> = {
      0: "ERROR",
      1: "PENDING",
      2: "SERVER_ACK",
      3: "DELIVERY_ACK",
      4: "READ",
      5: "PLAYED",
    };
    return names[status] ?? null;
  }
  return null;
}

/** ACK → status canônico; null quando não reconhecemos o valor. */
export function statusFromAck(status: unknown): DeliveryStatus | null {
  const ack = normalizeAck(status);
  return ack ? (ACK_TO_STATUS[ack] ?? null) : null;
}
