/* DIDICOST · service worker
   Guarda só os arquivos do app para abrir sem internet.
   Os lançamentos ficam no próprio aparelho (localStorage) e nunca passam por aqui. */
var CACHE = 'didicost-v4';
var ARQUIVOS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon.svg',
  './apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ARQUIVOS); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (nomes) {
      return Promise.all(nomes.filter(function (n) { return n.indexOf('didicost-') === 0 && n !== CACHE; })
        .map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  /* Página do app: tenta a versão nova na rede; sem internet, usa a guardada */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copia = res.clone();
          caches.open(CACHE).then(function (c) { c.put('./index.html', copia); });
        }
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (r) { return r || caches.match('./'); });
      })
    );
    return;
  }

  /* Ícones e manifesto: usa o guardado e busca na rede só se faltar */
  e.respondWith(
    caches.match(req).then(function (r) { return r || fetch(req); })
  );
});
