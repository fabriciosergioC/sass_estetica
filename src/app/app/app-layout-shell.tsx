"use client";

import { usePathname } from "next/navigation";
import { isBookingPreview } from "@/lib/nav";

export function AppLayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Sem sidebar, sem reconto do `ml-64` — as duas coisas precisam da mesma regra.
  const isBooking = isBookingPreview(pathname);

  return (
    <main className={`px-4 py-6 lg:px-8 print:ml-0 print:px-0 print:py-0 ${isBooking ? "" : "lg:ml-64"}`}>
      {children}
    </main>
  );
}
