// Offline: Netz zuerst, sonst Cache. / 오프라인 지원: 네트워크 우선, 실패하면 캐시.
// App-Dateien werden immer beim Server nachgefragt (cache: 'no-cache'): GitHub Pages erlaubt sonst 10 Minuten
// alte Kopien, und die installierte App zeigt nach dem Neustart noch die alte Version.
// 앱 파일은 매번 서버에 "바뀌었나요?"를 물어봄. GitHub Pages의 10분 저장 표시 때문에 홈 화면 앱이
// 껐다 켜도 예전 화면을 보여 주는 일을 막음.
const CACHE = 'travel-v10';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'firebase-config.js', 'maps-config.js', 'notion-sync.js'])));
  self.skipWaiting();
});
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('travel-v') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', e => {
  // Nur die App selbst, die Firebase-Bibliothek und die Schrift; Daten (Firestore, Anmeldung, Wechselkurs) bleiben unberührt.
  // 앱 파일, Firebase 라이브러리, 글꼴만 처리. 데이터 연결(Firestore, 로그인, 환율)은 건드리지 않음.
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || (u.origin !== location.origin && !['https://www.gstatic.com', 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'].includes(u.origin))) return;
  const own = u.origin === location.origin;
  e.respondWith(
    (own ? fetch(u.href, { cache: 'no-cache' }) : fetch(e.request)).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: own }))
  );
});
