const BUILD_ID = new URL(self.location.href).searchParams.get("build") || "development";
const CACHE_NAME = `streampay-shell-${BUILD_ID}`;

function isCacheableStaticAsset(value) {
  const url = new URL(value, self.location.origin);
  return (
    url.origin === self.location.origin &&
    (url.pathname === "/offline" ||
      (url.pathname.startsWith("/_next/static/") &&
        /\.(?:css|js)$/.test(url.pathname)))
  );
}

function isSensitiveRequest(request, url) {
  return (
    request.headers.has("Authorization") ||
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/.well-known" ||
    url.pathname.startsWith("/.well-known/")
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const offline = await fetch("/offline");
      if (!offline.ok) throw new Error("Unable to precache offline page");
      if (isCacheableStaticAsset("/offline")) {
        await cache.put("/offline", offline);
      }

      const shell = await fetch("/");
      if (!shell.ok) throw new Error("Unable to read app shell assets");
      const html = await shell.text();
      const assets = new Set([
        ...Array.from(html.matchAll(/href=["']([^"']+\.css(?:\?[^"']*)?)["']/g), (match) => match[1]),
        ...Array.from(html.matchAll(/src=["']([^"']+\.js(?:\?[^"']*)?)["']/g), (match) => match[1]),
      ]);
      await Promise.all(
        [...assets].map(async (asset) => {
          const url = new URL(asset, self.location.origin);
          if (!isCacheableStaticAsset(url.href)) return;
          const response = await fetch(url.href);
          if (response.ok && isCacheableStaticAsset(url.href)) {
            await cache.put(url.href, response);
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("streampay-shell-") && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isSensitiveRequest(request, url)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        let timer;
        try {
          const response = await Promise.race([
            fetch(request),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("Navigation timed out")), 3000);
            }),
          ]);
          return response;
        } catch {
          return (await caches.match("/offline")) || Response.error();
        } finally {
          clearTimeout(timer);
        }
      })()
    );
    return;
  }

  if (!isCacheableStaticAsset(url.href)) return;
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && isCacheableStaticAsset(url.href)) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(url.href, response.clone());
      }
      return response;
    })()
  );
});
