// 网页推送：收到推送就弹一条通知；点通知打开对应的页面
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'mydash', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'mydash', { body: d.body || '', icon: '/static/icon-180.png', badge: '/static/icon-180.png', data: { url: d.link || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const same = list.find(c => c.url === url);
    return same ? same.focus() : self.clients.openWindow(url);
  }));
});
