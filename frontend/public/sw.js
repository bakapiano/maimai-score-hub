const CACHE_NAME = "maimai-score-hub-app-v1";
const APP_SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.png",
  "/pwa-192x192.png",
  "/pwa-512x512.png",
  "/avatar-placeholder.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_URLS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/maimai-mobile/img/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const responseCopy = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put("/index.html", responseCopy));
          return response;
        })
        .catch(() => caches.match("/index.html")),
    );
    return;
  }

  const shouldCache =
    url.pathname.startsWith("/assets/") ||
    ["font", "image", "manifest", "script", "style"].includes(
      request.destination,
    );

  if (!shouldCache) return;

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(request).then((response) => {
        if (response.ok) {
          const responseCopy = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, responseCopy));
        }
        return response;
      });
    }),
  );
});
