@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ===================================================
echo   TESTE DE PERFORMANCE - SaaS Barbearia
echo ===================================================
echo.

set BASE_URL=http://localhost:3001

echo Testando rotas (5 requisicoes cada):
echo.

echo --- HOME (/) ---
for /L %%i in (1,1,5) do (
    curl -s -o nul -w "Req %%i: %%{time_total}s\n" %BASE_URL%/
)

echo.
echo --- LOGIN (/login) ---
for /L %%i in (1,1,5) do (
    curl -s -o nul -w "Req %%i: %%{time_total}s\n" %BASE_URL%/login
)

echo.
echo --- DASHBOARD (/app) ---
for /L %%i in (1,1,5) do (
    curl -s -o nul -w "Req %%i: %%{time_total}s\n" %BASE_URL%/app
)

echo.
echo --- AGENDA (/app/agenda) ---
for /L %%i in (1,1,5) do (
    curl -s -o nul -w "Req %%i: %%{time_total}s\n" %BASE_URL%/app/agenda
)

echo.
echo --- CLIENTES (/app/clientes) ---
for /L %%i in (1,1,5) do (
    curl -s -o nul -w "Req %%i: %%{time_total}s\n" %BASE_URL%/app/clientes
)

echo.
echo --- BARBEIROS (/app/barbeiros) ---
for /L %%i in (1,1,5) do (
    curl -s -o nul -w "Req %%i: %%{time_total}s\n" %BASE_URL%/app/barbeiros
)

echo.
echo --- SERVICOS (/app/servicos) ---
for /L %%i in (1,1,5) do (
    curl -s -o nul -w "Req %%i: %%{time_total}s\n" %BASE_URL%/app/servicos
)

echo.
echo --- API DASHBOARD (/api/dashboard) ---
for /L %%i in (1,1,5) do (
    curl -s -o nul -w "Req %%i: %%{time_total}s\n" %BASE_URL%/api/dashboard
)

echo.
echo ===================================================
echo   TESTE CONCLUIDO
echo ===================================================
pause
