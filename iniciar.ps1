<#
.SYNOPSIS
    Inicia o servidor de desenvolvimento do SaaS Barbearia
.DESCRIPTION
    Verifica dependencias, sincroniza banco e inicia Next.js com hot reload
#>

$ErrorActionPreference = "Stop"

# Cores
$green = [ConsoleColor]::Green
$yellow = [ConsoleColor]::Yellow
$red = [ConsoleColor]::Red
$cyan = [ConsoleColor]::Cyan
$reset = [ConsoleColor]::Gray

function Write-Color($msg, $color) {
    $original = $Host.UI.RawUI.ForegroundColor
    $Host.UI.RawUI.ForegroundColor = $color
    Write-Host $msg
    $Host.UI.RawUI.ForegroundColor = $original
}

Write-Color "===========================================" $cyan
Write-Color "  SaaS Barbearia - Servidor de Desenvolvimento" $cyan
Write-Color "===========================================" $cyan
Write-Host ""

# Verificar Node.js
try {
    $nodeVersion = node --version 2>$null
    Write-Color "[OK] Node.js $nodeVersion encontrado" $green
} catch {
    Write-Color "[ERRO] Node.js/npm nao encontrado." $red
    Write-Host "Instale o Node.js 20+ em https://nodejs.org"
    Read-Host "Pressione Enter para sair"
    exit 1
}

# Verificar .env
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Write-Color "[INFO] Criando .env a partir de .env.example..." $yellow
        Copy-Item ".env.example" ".env" -Force
    } else {
        Write-Color "[ERRO] Arquivo .env nao encontrado e .env.example nao existe." $red
        Read-Host "Pressione Enter para sair"
        exit 1
    }
} else {
    Write-Color "[OK] Arquivo .env encontrado" $green
}

# Verificar/Instalar dependencias
if (-not (Test-Path "node_modules")) {
    Write-Color "[INFO] Instalando dependencias (npm install)..." $yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Color "[ERRO] Falha no npm install." $red
        Read-Host "Pressione Enter para sair"
        exit 1
    }
} else {
    Write-Color "[OK] Dependencias ja instaladas" $green
}

# Banco de dados: o CRM grava no Postgres do Supabase, e o iniciador NAO mexe nele por conta
# propria. Antes, quando o banco era um arquivo local, este bloco rodava
# `prisma db push --accept-data-loss` sempre que `dev.db` nao existia -- e como o arquivo real e
# `prisma\dev.db`, o teste era sempre falso, entao o push acontecia a cada start. Apontando no
# Supabase isso viraria drop de coluna no banco da nuvem sem ninguem pedir.
#
# Hoje: so confere se as duas connection strings estao no .env. Para aplicar migrations, rode
# `npx prisma migrate deploy` conscientemente (ou defina DB_AUTOSYNC=1 quando quiser isso no boot).
$dbUrl = $null
$directUrl = $null
if (Test-Path ".env") {
    foreach ($line in Get-Content ".env") {
        if ($line -match '^\s*DATABASE_URL\s*=\s*"?(.*?)"?\s*$') { $dbUrl = $Matches[1] }
        if ($line -match '^\s*DIRECT_URL\s*=\s*"?(.*?)"?\s*$') { $directUrl = $Matches[1] }
    }
}

if (-not $dbUrl -or -not $directUrl) {
    Write-Color "[ERRO] DATABASE_URL e/ou DIRECT_URL vazios no .env." $red
    Write-Host "Pegue as duas em Project Settings -> Database -> Connection string (veja SUPABASE.md)."
    Read-Host "Pressione Enter para sair"
    exit 1
}
Write-Color "[OK] .env aponta para um Postgres (DATABASE_URL + DIRECT_URL preenchidos)" $green

if ($env:DB_AUTOSYNC -eq "1") {
    Write-Color "[INFO] DB_AUTOSYNC=1 -> aplicando migrations pendentes (prisma migrate deploy)..." $yellow
    npx prisma migrate deploy
    if ($LASTEXITCODE -ne 0) {
        Write-Color "[ERRO] Falha ao aplicar migrations." $red
        Read-Host "Pressione Enter para sair"
        exit 1
    }
}

# Gerar Prisma Client se ainda nao existir
if (-not (Test-Path "node_modules\.prisma\client\index.js")) {
    Write-Color "[INFO] Gerando Prisma Client..." $yellow
    npx prisma generate
    if ($LASTEXITCODE -ne 0) {
        Write-Color "[ERRO] Falha ao gerar Prisma Client." $red
        Read-Host "Pressione Enter para sair"
        exit 1
    }
    Write-Color "[OK] Prisma Client gerado" $green
} else {
    Write-Color "[OK] Prisma Client pronto" $green
}

Write-Host ""
Write-Color "===========================================" $cyan
Write-Color "[OK] Tudo pronto! Iniciando servidor..." $green
Write-Color "===========================================" $cyan
Write-Host ""
Write-Color "Servidor rodando em: http://localhost:3000" $yellow
Write-Color "Prisma Studio:       http://localhost:5555 (execute 'npx prisma studio' em outro terminal)" $yellow
Write-Host ""
Write-Color "Hot Reload: ATIVO - Alteracoes reiniciam automaticamente" $cyan
Write-Color "Para parar: Ctrl+C" $cyan
Write-Host ""

# Iniciar Next.js dev server (ja tem hot reload nativo)
npm run dev

Write-Host ""
Write-Color "[INFO] Servidor encerrado." $red
Read-Host "Pressione Enter para sair"