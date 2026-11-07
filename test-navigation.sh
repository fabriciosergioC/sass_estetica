#!/bin/bash

echo "==================================================="
echo "  TESTE DE NAVEGAÇÃO - SaaS Barbearia"
echo "==================================================="
echo ""

BASE_URL="http://localhost:3001"
ROUTES=(
  "/"
  "/login"
  "/app"
  "/app/agenda"
  "/app/clientes"
  "/app/barbeiros"
  "/app/servicos"
  "/app/oportunidades"
  "/app/configuracoes"
)

echo "Testando rotas (múltiplas requisições para medir cache):"
echo ""

for route in "${ROUTES[@]}"; do
  echo "--- Rota: $route ---"

  # Primeira requisição (cold cache)
  time1=$(curl -s -o /dev/null -w "%{time_total}" "$BASE_URL$route" 2>/dev/null)

  # Segunda requisição (warm cache)
  time2=$(curl -s -o /dev/null -w "%{time_total}" "$BASE_URL$route" 2>/dev/null)

  # Terceira requisição (hot cache)
  time3=$(curl -s -o /dev/null -w "%{time_total}" "$BASE_URL$route" 2>/dev/null)

  echo "  1ª (cold): ${time1}s"
  echo "  2ª (warm): ${time2}s"
  echo "  3ª (hot):  ${time3}s"

  # Calcular melhoria
  if [ $(echo "$time1 > 0" | bc) -eq 1 ] && [ $(echo "$time3 > 0" | bc) -eq 1 ]; then
    improvement=$(echo "scale=1; (($time1 - $time3) / $time1) * 100" | bc)
    echo "  Melhoria: ${improvement}%"
  fi

  echo ""
done

echo "==================================================="
echo "  TESTE DE API (com SWR cache)"
echo "==================================================="
echo ""

# Teste da API do dashboard
echo "--- API Dashboard ---"
for i in {1..5}; do
  time_api=$(curl -s -o /dev/null -w "%{time_total}" "$BASE_URL/api/dashboard" 2>/dev/null)
  echo "  Requisição $i: ${time_api}s"
done

echo ""
echo "Teste concluído!"
