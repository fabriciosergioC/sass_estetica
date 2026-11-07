import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ session: null });
  return NextResponse.json({
    session: {
      userId: session.userId,
      name: session.name,
      email: session.email,
      activeOrgId: session.activeOrgId,
      role: session.role,
      isSuperAdmin: session.isSuperAdmin,
    },
  });
}
