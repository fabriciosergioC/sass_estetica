/*
 * Service worker do PWA (painel de gestão).
 *
 * Estratégia deliberadamente conservadora: o painel é autenticado e multiempresa, então
 * NUNCA guardamos HTML de página nem resposta de /api. Se a rede cair, a navegação mostra
 * a página offline — e não a agenda (possivelmente de outra pessoa) congelada em cache.
 *
 * - Navegação: rede primeiro; sem rede, /offline.html.
 * - Arquivos estáticos (chunks do Next, ícones, fontes, imagens): cache primeiro, com
 *   atualização em segundo plano. Os chunks têm hash no nome, então não ficam velhos.
 * - /api e requisições não-GET passam direto.
 */

const VERSION = "v1";
const STATIC_CACHE = `gestao-static-${VERSION}`;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // `cache: "reload"` ignora o cache HTTP e garante a versão nova a cada deploy.
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

const STATIC_RE = /\.(?:css|js|mjs|png|jpe?g|svg|webp|avif|ico|woff2?|ttf|otf)$/i;

function isStaticAsset(url) {
  return url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || STATIC_RE.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(STATIC_CACHE);
          const offline = await cache.match(OFFLINE_URL);
          return offline ?? new Response("Sem conexão.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
      })()
    );
    return;
  }

  if (!isStaticAsset(url)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === "basic") cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);
      return cached ?? (await network) ?? new Response("", { status: 504 });
    })()
  );
});
