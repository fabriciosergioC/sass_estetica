@echo off
setlocal EnableExtensions
chcp 65001 >nul
title SaaS Barbearia - TESTE
cd /d "%~dp0"

echo.
echo ============================================
echo   SaaS Barbearia - TESTE DE EXECUCAO
echo ============================================
echo.

echo [1/5] Verificando Node.js...
where npm >nul 2>nul
if errorlevel 1 (
    echo ERRO: Node.js nao encontrado.
    goto :fim
)
echo OK
echo.

echo [2/5] Instalando dependencias...
echo (pulando - este eh um teste rapido)
timeout /t 1 /nobreak >nul
echo OK
echo.

echo [3/5] Sincronizando banco...
echo (pulando - teste)
timeout /t 1 /nobreak >nul
echo OK
echo.

echo [4/5] Gerando Prisma Client...
echo (pulando - teste)
timeout /t 1 /nobreak >nul
echo OK
echo.

echo [5/5] Iniciando servidor...
echo (pulando - teste)
timeout /t 1 /nobreak >nul

echo.
echo ============================================
echo   TESTE CONCLUIDO COM SUCESSO
echo ============================================

:fim
echo.
echo Pressione qualquer tecla para fechar esta janela...
pause >nul
endlocal
