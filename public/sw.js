// PWA Service Worker：静态资源离线缓存（stale-while-revalidate）
// 仅缓存同源 GET 请求；Supabase API / 认证等跨域请求不拦截。
const CACHE = 'drumscore-v1';

self.addEventListener('install', () => {
  self.skipWaiting(); // 新版本立即接管，避免用户停留在旧版
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      // 清掉旧版本缓存
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 跨域（Supabase 等）不缓存
  e.respondWith(
    caches.match(req).then((cached) => {
      const fetching = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached); // 离线且无缓存时报错交给页面处理
      // 先回缓存（秒开），后台同步更新
      return cached || fetching;
    })
  );
});
