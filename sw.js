/*!
 * 피클볼 오픈플레이 로테이션 v2.0.0
 * 복식 오픈플레이 대진 배정 · 점수 기록 · 순위 집계
 *
 * (c) 2026 David Doyun Lee <doyundoyun@gmail.com>
 * MIT License
 */
const CACHE = "pb-v2.0.3";   // 배포마다 버전 올릴 것
const ASSETS = ["./", "./index.html", "./engine.js", "./manifest.json",
                "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
