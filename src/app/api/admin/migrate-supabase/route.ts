import { NextRequest, NextResponse } from "next/server";
import { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";

function topologicalModels() {
  const models = (Prisma as any).dmmf.datamodel.models as Array<{
    name: string;
    fields: Array<{ name: string; kind: string; type: string; relationFromFields?: string[] }>;
  }>;
  const names = new Set(models.map((model) => model.name));
  const dependencies = new Map<string, Set<string>>();

  for (const model of models) {
    const deps = new Set<string>();
    for (const field of model.fields) {
      if (field.kind === "object" && names.has(field.type) && (field.relationFromFields?.length ?? 0) > 0) {
        deps.add(field.type);
      }
    }
    dependencies.set(model.name, deps);
  }

  const result: string[] = [];
  const added = new Set<string>();
  while (result.length < models.length) {
    let progressed = false;
    for (const model of models) {
      if (added.has(model.name)) continue;
      if ([...(dependencies.get(model.name) ?? [])].every((dep) => added.has(dep))) {
        result.push(model.name);
        added.add(model.name);
        progressed = true;
      }
    }
    if (!progressed) {
      for (const model of models) if (!added.has(model.name)) result.push(model.name);
      break;
    }
  }
  return result;
}

export async function POST(req: NextRequest) {
  const expected = process.env.SUPABASE_MIGRATION_TOKEN;
  if (!expected || req.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const sourceUrl = process.env.SUPABASE_DATABASE_URL;
  if (!sourceUrl) {
    return NextResponse.json({ error: "SUPABASE_DATABASE_URL não configurada" }, { status: 400 });
  }

  const source = new PrismaClient({ datasourceUrl: sourceUrl });
  const counts: Record<string, number> = {};

  try {
    for (const modelName of topologicalModels()) {
      const delegateName = modelName.charAt(0).toLowerCase() + modelName.slice(1);
      const sourceDelegate = (source as any)[delegateName];
      const destinationDelegate = (db as any)[delegateName];
      if (!sourceDelegate || !destinationDelegate) continue;

      let copied = 0;
      let skipped = 0;
      while (true) {
        const rows = await sourceDelegate.findMany({
          take: 500,
          skip: skipped,
        });
        if (rows.length === 0) break;
        await destinationDelegate.createMany({ data: rows, skipDuplicates: true });
        copied += rows.length;
        skipped += rows.length;
      }
      counts[modelName] = copied;
    }

    return NextResponse.json({ ok: true, counts });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Falha na migração" }, { status: 500 });
  } finally {
    await source.$disconnect();
  }
}
