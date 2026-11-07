# Script de Teste de Performance - PowerShell
# Executa testes de performance nas rotas do sistema

$baseUrl = "http://localhost:3001"
$routes = @(
    @{Path="/"; Name="Home"; Type="public"},
    @{Path="/login"; Name="Login"; Type="public"},
    @{Path="/app"; Name="Dashboard"; Type="protected"},
    @{Path="/app/agenda"; Name="Agenda"; Type="protected"},
    @{Path="/app/clientes"; Name="Clientes"; Type="protected"},
    @{Path="/app/barbeiros"; Name="Barbeiros"; Type="protected"},
    @{Path="/app/servicos"; Name="Serviços"; Type="protected"},
    @{Path="/app/oportunidades"; Name="Oportunidades"; Type="protected"},
    @{Path="/app/configuracoes"; Name="Configurações"; Type="protected"},
    @{Path="/api/dashboard"; Name="API Dashboard"; Type="api"}
)

Write-Host "===================================================" -ForegroundColor Yellow
Write-Host "  TESTE DE PERFORMANCE - SaaS Barbearia" -ForegroundColor Yellow
Write-Host "===================================================" -ForegroundColor Yellow
Write-Host ""

$results = @()

foreach ($route in $routes) {
    Write-Host "Testando: $($route.Name) ($($route.Path))" -ForegroundColor Cyan

    $times = @()
    $status = "OK"

    # Executar 5 requisições para cada rota
    for ($i = 1; $i -le 5; $i++) {
        try {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $response = Invoke-WebRequest -Uri "$baseUrl$($route.Path)" -UseBasicParsing -TimeoutSec 10
            $sw.Stop()

            $times += $sw.ElapsedMilliseconds
            $statusCode = $response.StatusCode

            Write-Host "  Requisição $i`: $($sw.ElapsedMilliseconds)ms (Status: $statusCode)" -ForegroundColor Gray
        }
        catch {
            $sw.Stop()
            $times += $sw.ElapsedMilliseconds
            $status = "ERROR"
            Write-Host "  Requisição $i`: $($sw.ElapsedMilliseconds)ms (Erro: $($_.Exception.Message))" -ForegroundColor Red
        }

        Start-Sleep -Milliseconds 100
    }

    $avg = ($times | Measure-Object -Average).Average
    $min = ($times | Measure-Object -Minimum).Minimum
    $max = ($times | Measure-Object -Maximum).Maximum

    $result = [PSCustomObject]@{
        Route = $route.Path
        Name = $route.Name
        Type = $route.Type
        Times = $times
        Average = [math]::Round($avg, 2)
        Minimum = $min
        Maximum = $max
        Status = $status
    }

    $results += $result

    $color = if ($avg -lt 500) { "Green" } elseif ($avg -lt 1000) { "Yellow" } else { "Red" }
    Write-Host "  Média: $([math]::Round($avg, 2))ms | Min: ${min}ms | Max: ${max}ms" -ForegroundColor $color
    Write-Host ""
}

# Resumo
Write-Host "===================================================" -ForegroundColor Yellow
Write-Host "  RESUMO GERAL" -ForegroundColor Yellow
Write-Host "===================================================" -ForegroundColor Yellow
Write-Host ""

$successful = $results | Where-Object { $_.Status -eq "OK" }
$failed = $results | Where-Object { $_.Status -eq "ERROR" }
$slow = $results | Where-Object { $_.Average -gt 1000 }

$overallAvg = if ($successful.Count -gt 0) {
    [math]::Round(($successful | Measure-Object -Property Average -Average).Average, 2)
} else { 0 }

$fastest = $successful | Sort-Object Average | Select-Object -First 1
$slowest = $successful | Sort-Object Average -Descending | Select-Object -First 1

Write-Host "Tempo Médio Geral: ${overallAvg}ms" -ForegroundColor Cyan
Write-Host "Rotas Testadas: $($results.Count)"
Write-Host "Sucesso: $($successful.Count)" -ForegroundColor Green
Write-Host "Falhas: $($failed.Count)" -ForegroundColor Red
Write-Host ""

Write-Host "Rota Mais Rápida: $($fastest.Name) - $($fastest.Average)ms" -ForegroundColor Green
Write-Host "Rota Mais Lenta: $($slowest.Name) - $($slowest.Average)ms" -ForegroundColor Red
Write-Host ""

if ($slow.Count -gt 0) {
    Write-Host "Rotas Lentas (>1s):" -ForegroundColor Yellow
    $slow | ForEach-Object {
        Write-Host "  - $($_.Name): $($_.Average)ms" -ForegroundColor Yellow
    }
    Write-Host ""
}

Write-Host "Por Tipo de Rota:" -ForegroundColor Cyan
@("public", "protected", "api") | ForEach-Object {
    $type = $_
    $typeRoutes = $successful | Where-Object { $_.Type -eq $type }
    $typeAvg = if ($typeRoutes.Count -gt 0) {
        [math]::Round(($typeRoutes | Measure-Object -Property Average -Average).Average, 2)
    } else { 0 }

    Write-Host "  $type`: $($typeRoutes.Count) rotas, média ${typeAvg}ms"
}

Write-Host ""
Write-Host "Teste concluído em: $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Gray
