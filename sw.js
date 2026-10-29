/* Service worker: guarda o aplicativo no aparelho para abrir sem internet.
   Os dados NÃO passam por aqui — ficam no IndexedDB e vão ao servidor pela fila. */
const VERSAO = 'co-v1.3.0';
const ARQUIVOS = [
  './', 'index.html', 'app.js', 'theme.js', 'manifest.webmanifest',
  'xlsx.bundle.js', 'chart.umd.js', 'icon-192.png', 'icon-512.png'
];

self.addEventListener('install', (e) => {
  // cache: 'reload' garante que a versão nova dos arquivos seja baixada (e não uma cópia antiga do navegador)
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', (e) => { if (e.data === 'ativar') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                              // API (POST) vai direto à rede
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;               // nada de terceiros
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('index.html').then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req)));
});
