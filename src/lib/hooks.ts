"use client";

import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// Hook genérico com cache SWR
export function useApi<T>(url: string | null) {
  const { data, error, isLoading, mutate } = useSWR<T>(url, fetcher, {
    revalidateOnFocus: false, // Não recarrega ao focar na janela
    revalidateOnReconnect: true, // Recarrega se voltar a conexão
    dedupingInterval: 10000, // Deduplica requests por 10s
    errorRetryCount: 2,
  });

  return {
    data,
    error,
    isLoading,
    mutate,
  };
}

// Hook para dados do dashboard
export function useDashboard() {
  return useApi<{
    userName: string;
    org: { id: string; name: string; slug: string; status: string };
    kpis: {
      revenue: number;
      completed: number;
      ticket: number;
      newCustomers: number;
      todayAppointments: number;
      openOpportunities: number;
    };
    statusGroups: Array<{ status: string; count: number }>;
    noShowRate: number;
    cancelled: number;
    upcoming: Array<{
      id: string;
      startAt: string;
      customerName: string;
      barberName: string;
      status: string;
    }>;
    topServices: Array<{ serviceId: string; count: number; revenue: number }>;
    topBarbers: Array<{ barberId: string; count: number; revenue: number }>;
    serviceNames: Array<{ id: string; name: string }>;
    barberNames: Array<{ id: string; name: string }>;
    topOpportunities: Array<{
      id: string;
      title: string;
      suggestedAction: string;
      priority: string;
      type: string;
    }>;
    returnDue: number;
    riskAppts: number;
    pending: Array<{ label: string; href: string }>;
    customers: number;
    barbers: number;
    services: number;
  }>("/api/dashboard");
}
