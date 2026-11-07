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

    const services = await db.service.findMany({
      where: { orgId, active: true },
      select: { id: true, name: true, durationMin: true, priceCents: true, category: true },
      orderBy: { name: "asc" },
    });

    // Adapta o formato para o frontend estático (o booking-wizard espera 'duration' e 'price')
    const adaptedServices = services.map(s => ({
      id: s.id,
      name: s.name,
      description: s.name, // Usando o nome como descrição padrão
      duration: s.durationMin,
      price: s.priceCents / 100, // Converte centavos para reais
      promoPrice: null, // Não há promoções no momento
      category: s.category,
      image: "/assets/img/placeholders/service.jpg" // Imagem placeholder
    }));

    return NextResponse.json(adaptedServices, { status: 200, headers: corsHeaders });
  } catch (err) {
    return handleApiError(err, corsHeaders);
  }
}
