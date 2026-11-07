@echo off
title SaaS Barbearia - Servidor
cd /d "%~dp0"
echo ============================================
echo   SaaS Barbearia - Iniciando Servidor...
echo ============================================
echo.
echo Servidor iniciando em http://localhost:3000
echo Pressione Ctrl+C para encerrar.
echo.
npm run dev
if errorlevel 1 (
    echo.
    echo Ocorreu um erro ao iniciar o servidor.
    pause
)

rem Adicionado para manter a janela aberta caso o npm run dev saia inesperadamente.
pause
