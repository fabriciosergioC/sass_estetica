// Regras de cadastro de cliente que precisam ser as MESMAS em qualquer entrada do CRM
// (tela de Clientes, portal do cliente, agendamento online, painel do WhatsApp).
// Nada aqui conhece a interface: fala só com o Prisma.
import { db } from "@/lib/db";
import { phoneKey } from "@/lib/phone";

export type PhoneConflict = { id: string; name: string; phone: string };

/**
 * Procura um cliente da barbearia com o mesmo número de WhatsApp/telefone, ignorando
 * pontuação e o DDI 55 (`+55 (31) 98770-7962` === `31987707962`).
 *
 * `exceptId` existe para a edição: o cliente pode continuar com o próprio número.
 *
 * Por que varremos os telefones da org em vez de usar `where: { phone }`: os números foram
 * gravados em formatos diferentes por caminhos diferentes (ver `phoneKey`), então uma busca
 * por igualdade deixaria passar o duplicado que estamos justamente tentando evitar. A varredura
 * lê três colunas de uma tabela que, em barbearia, tem centenas de linhas — se um dia passar de
 * dezenas de milhares de clientes, o caminho certo é gravar uma coluna `phoneKey` indexada no
 * cadastro, não continuar varrendo.
 */
export async function findCustomerByPhone(
  orgId: string,
  raw: string | null | undefined,
  opts: { exceptId?: string } = {}
): Promise<PhoneConflict | null> {
  const key = phoneKey(raw);
  if (!key) return null;

  const rows = await db.customer.findMany({
    where: { orgId },
    select: { id: true, name: true, phone: true },
  });

  for (const row of rows) {
    if (row.id === opts.exceptId) continue;
    if (phoneKey(row.phone) === key) return row;
  }
  return null;
}

/** Mensagem que vai para a tela: diz QUEM já está com aquele número, não só "é duplicado". */
export function phoneConflictMessage(conflict: PhoneConflict): string {
  return `Este número de WhatsApp já está cadastrado para ${conflict.name}. Edite o cliente existente em vez de criar outro.`;
}
