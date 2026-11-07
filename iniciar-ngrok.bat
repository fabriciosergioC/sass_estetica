@echo off
title Ngrok - SaaS Barbearia
echo Iniciando tunel ngrok para a porta 3001...
echo Certifique-se de que o servidor local (npm run dev) ja esta rodando!
echo.
ngrok http 3001
pause
