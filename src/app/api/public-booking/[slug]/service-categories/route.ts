import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handleApiError } from "@/lib/api";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;

    const organization = await db.organization.findUnique({ where: { slug }, select: { id: true } });
    if (!organization) {
      return NextResponse.json({ error: "Clínica não encontrada." }, { status: 404, headers: corsHeaders });
    }
    const orgId = organization.id;

    // Busca serviços para extrair as categorias únicas
    const services = await db.service.findMany({
      where: { orgId, active: true },
      select: { category: true },
    });

    const uniqueCategories = Array.from(new Set(services.map(s => s.category))).filter(Boolean);

    // Formata o padrão que o frontend espera (incluindo "Todos" como primeira opção)
    const categories = [
      { id: "todos", label: "Todos os serviços" },
      ...uniqueCategories.map(cat => ({
        id: cat,
        label: cat.charAt(0) + cat.slice(1).toLowerCase()
      }))
    ];

    return NextResponse.json(categories, { status: 200, headers: corsHeaders });
  } catch (err) {
    return handleApiError(err, corsHeaders);
  }
}
