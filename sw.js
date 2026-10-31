/**
 * Master Cockpit & Fleet Sentinel — Service Worker (`pwa/sw.js`)
 *
 * セキュリティ ＆ サブパス両対応設計:
 * - 相対パス (`./`, `./index.html`, `./manifest.json`, `./sw.js`, `./icons/*.png`) を採用し、
 *   Cloudflare Workers ルート配信 (`https://<worker>.workers.dev/`) と
 *   GitHub Pages サブパス配信 (`https://<user>.github.io/<repo>/`) の双方で 100% 同一動作する。
 * - アプリケーションシェルとネイティブアイコンのみをオフラインキャッシュし、
 *   電波不安定なモバイル回線（5G/4G）でも即座にフルスクリーン復号UIを起動可能にする。
 * - `/api/` エンドポイントおよび `encrypted_vault_bundle.json` は一切キャッシュせず、
 *   常に最新のネットワーク応答 (`cache: "no-store"`) を取得する。
 */

const CACHE_NAME = "master-cockpit-shell-v1.12.0";
const IS_LOCAL_LOOPBACK_SW =
  self.location.hostname === "127.0.0.1" || self.location.hostname === "localhost";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./sw.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  if (IS_LOCAL_LOOPBACK_SW) {
    event.waitUntil(self.skipWaiting());
    return;
  }
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => IS_LOCAL_LOOPBACK_SW || key !== CACHE_NAME)
            .map((oldKey) => caches.delete(oldKey))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // ローカル閉域 (127.0.0.1 / localhost)、POSTリクエスト、/api/ パス、暗号化ボールトは
  // Service Worker キャッシュを一切使わず必ずネットワーク (fetch(event.request)) へ直接パススルーする
  if (
    IS_LOCAL_LOOPBACK_SW ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    req.method !== "GET" ||
    url.pathname.includes("/api/") ||
    url.pathname.endsWith("encrypted_vault_bundle.json")
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 外出先公開PWAのシェルアセット・アイコンのみ Network-First (オフライン時のみキャッシュフォールバック)
  event.respondWith(
    fetch(event.request)
      .then((networkResp) => {
        if (networkResp && networkResp.status === 200 && url.origin === self.location.origin) {
          const clone = networkResp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return networkResp;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("./index.html")))
  );
});

// RFC 8291 / RFC 8292 Web Push 受信リスナー（高優先度アラート・バイブレーション表示）
self.addEventListener("push", (event) => {
  let payload = {
    title: "🛡️ Master Cockpit & Fleet Sentinel",
    body: "システム監視アラートを受信しました。アプリを開いて状態を確認してください。",
    level: "WARNING",
    url: "./?tab=0",
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      if (parsed && typeof parsed === "object") {
        payload = { ...payload, ...parsed };
      }
    } catch {
      const txt = event.data.text();
      if (txt) {
        payload.body = txt;
      }
    }
  }

  const isCritical = String(payload.level || "").toUpperCase() === "CRITICAL";
  const options = {
    body: String(payload.body || ""),
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: String(payload.tag || (isCritical ? "cockpit-critical-alert" : "cockpit-sentinel-notice")),
    renotify: true,
    requireInteraction: isCritical,
    vibrate: isCritical ? [300, 120, 300, 120, 420] : [200, 100, 200],
    data: {
      url: String(payload.url || "./?tab=0"),
      level: String(payload.level || "INFO"),
      ts_ms: payload.ts_ms || Date.now(),
    },
  };

  event.waitUntil(self.registration.showNotification(String(payload.title || "Master Cockpit"), options));
});

// 通知タップ時のフォーカス復帰または対象タブオープン（同一オリジン・HTTP/HTTPS スキーム強制）
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const scopeUrl = new URL(self.registration.scope);
  const relUrl = (event.notification.data && event.notification.data.url) || "./?tab=0";
  let targetUrl = scopeUrl.href;
  try {
    const parsedTarget = new URL(String(relUrl), scopeUrl.href);
    if (
      parsedTarget.origin === scopeUrl.origin &&
      (parsedTarget.protocol === "https:" || parsedTarget.protocol === "http:")
    ) {
      targetUrl = parsedTarget.href;
    }
  } catch {
    targetUrl = scopeUrl.href;
  }

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url && client.url.startsWith(self.registration.scope) && "focus" in client) {
          return client.focus().then((focused) => {
            if (focused && "navigate" in focused) {
              return focused.navigate(targetUrl).catch(() => focused);
            }
            return focused;
          });
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return null;
    })
  );
});
