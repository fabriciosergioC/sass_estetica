"use client";

import { usePathname } from "next/navigation";
import { isBookingPreview } from "@/lib/nav";

export function AppLayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Sem sidebar, sem reconto do `ml-64` — as duas coisas precisam da mesma regra.
  const isBooking = isBookingPreview(pathname);

  return (
    <main className={`px-4 py-6 lg:px-8 ${isBooking ? "" : "lg:ml-64"}`}>
      {children}
    </main>
  );
}
