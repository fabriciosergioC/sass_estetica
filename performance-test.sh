#!/bin/bash

# Script de teste de performance de navegação
# Testa múltiplas requisições para medir cache e tempo de resposta

BASE_URL="http://localhost:3001"
RESULTS_FILE="performance-results.json"

echo "==================================================="
echo "  TESTE DE PERFORMANCE - SaaS Barbearia"
echo "==================================================="
echo ""
echo "Iniciando testes em: $(date)"
echo "URL Base: $BASE_URL"
echo ""

# Array de rotas para testar
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
  "/api/dashboard"
)

# Função para testar uma rota
test_route() {
  local route=$1
  local times=()
  local total=0

  echo "Testando: $route"

  # Fazer 5 requisições para cada rota
  for i in {1..5}; do
    start_time=$(date +%s%N)
    status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL$route" 2>/dev/null)
    end_time=$(date +%s%N)

    duration=$(echo "scale=3; ($end_time - $start_time) / 1000000" | bc)
    times+=($duration)
    total=$(echo "$total + $duration" | bc)

    echo "  Requisição $i: ${duration}ms (Status: $status)"
  done

  # Calcular estatísticas
  avg=$(echo "scale=3; $total / 5" | bc)
  min=$(printf '%s\n' "${times[@]}" | sort -n | head -n1)
  max=$(printf '%s\n' "${times[@]}" | sort -n | tail -n1)

  # Calcular desvio padrão
  sum_sq=0
  for t in "${times[@]}"; do
    diff=$(echo "$t - $avg" | bc)
    sq=$(echo "$diff * $diff" | bc)
    sum_sq=$(echo "$sum_sq + $sq" | bc)
  done
  stddev=$(echo "scale=3; sqrt($sum_sq / 5)" | bc)

  echo "  Média: ${avg}ms | Min: ${min}ms | Max: ${max}ms | StdDev: ${stddev}ms"
  echo ""

  # Retornar resultado em JSON
  echo "{\"route\":\"$route\",\"avg\":$avg,\"min\":$min,\"max\":$max,\"stddev\":$stddev,\"times\":[${times[*]}]}"
}

# Executar testes
echo "ROTAS PÚBLICAS E DE AUTENTICAÇÃO"
echo "-----------------------------------"
test_route "/"
test_route "/login"

echo ""
echo "ROTAS DO APLICATIVO (Requer Autenticação)"
echo "-------------------------------------------"
test_route "/app"
test_route "/app/agenda"
test_route "/app/clientes"
test_route "/app/barbeiros"
test_route "/app/servicos"
test_route "/app/oportunidades"
test_route "/app/configuracoes"

echo ""
echo "APIs (Com cache SWR)"
echo "--------------------"
test_route "/api/dashboard"

echo ""
echo "==================================================="
echo "  TESTE CONCLUÍDO"
echo "==================================================="
echo "Todos os testes finalizados em: $(date)"
