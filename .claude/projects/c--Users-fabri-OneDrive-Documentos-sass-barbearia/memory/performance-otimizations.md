---
name: performance-otimizations
description: Otimizações de performance implementadas para navegação mais rápida
metadata:
  type: project
---

## Otimizações de Performance Implementadas

### Problema Identificado
- Navegação lenta entre páginas
- Layout fazendo queries ao banco a cada navegação
- Dashboard com 15+ queries paralelas
- Carregamento pesado sem cache

### Soluções Implementadas

#### 1. Cache Inteligente no Cliente com SWR
- Biblioteca SWR instalada para cache automático de dados
- Hook `useDashboard()` criado em [[src/lib/hooks.ts]]
- Dados cacheados no navegador por 10 segundos (dedupingInterval)
- Não recarrega ao focar na janela (revalidateOnFocus: false)
- Recarrega automaticamente se conexão voltar (revalidateOnReconnect: true)

#### 2. Arquitetura Cliente-Servidor Moderna
- Dashboard transformado de Server Component para Client Component
- API Route criada: [[src/app/api/dashboard/route.ts]]
- Separação clara entre dados (API) e UI (componente cliente)
- Carregamento não-bloqueante com skeleton loading

#### 3. Cache de Sessão JWT
- Adicionados campos `cachedOrgName` e `cachedMemberships` na sessão
- Login atualizado para cachear memberships
- Switch-org usa cache quando disponível
- Layout não faz queries ao banco se tiver cache

#### 4. Otimizações do Next.js
- [[next.config.ts]] configurado com:
  - `optimizePackageImports` para date-fns, zod, swr
  - Cache mais agressivo (60 minutos)
  - Compressão habilitada
  - Strict mode habilitado

#### 5. Script de Inicialização Simplificado
- [[iniciar.bat]] agora executa automaticamente sem menu
- Verifica Node.js, dependências, banco e inicia
- Basta clicar duas vezes para rodar o projeto

### Arquivos Modificados/Criados

**Criados:**
- [[src/app/api/dashboard/route.ts]] - API do dashboard
- [[src/lib/hooks.ts]] - Hooks com SWR para cache
- [[src/app/api/dashboard/route.ts]] - Endpoint otimizado

**Modificados:**
- [[src/app/app/page.tsx]] - Agora usa SWR e carrega assincronamente
- [[src/app/app/layout.tsx]] - Usa cache da sessão
- [[src/lib/auth/session.ts]] - Campos de cache adicionados
- [[src/app/api/auth/login/route.ts]] - Cacheia dados na sessão
- [[src/app/api/auth/switch-org/route.ts]] - Usa cache quando disponível
- [[next.config.ts]] - Otimizações de performance
- [[iniciar.bat]] - Execução automática

### Resultado Esperado
- **Navegação instantânea** entre páginas (cache no cliente)
- **Primeira carga rápida** (dados cacheados na sessão)
- **Dashboard responsivo** (skeleton loading + carregamento assíncrono)
- **Menor carga no banco** (cache em múltiplas camadas)

### Como Testar
1. Execute `iniciar.bat`
2. Faça login no sistema
3. Navegue entre as páginas - deve estar muito mais rápido
4. O dashboard mostrará skeleton loading e carregará os dados em background
5. Navegue para outras páginas e volte - dados já estarão cacheados

### Próximas Otimizações Possíveis
- Implementar React Query como alternativa ao SWR (mais recursos)
- Adicionar Service Worker para cache offline
- Implementar paginação virtual em listas longas
- Otimizar imagens com Next.js Image component
- Adicionar indexes no banco de dados para queries frequentes
