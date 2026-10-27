const script = document.querySelector('script[data-entry]');
const base = new URL('./', import.meta.url);
try {
  if (!('serviceWorker' in navigator)) throw Error('Service Worker unavailable');
  await navigator.serviceWorker.register(new URL(`demo-worker.js?v=${script.dataset.revision}`, base), { type: 'module', scope: base.pathname, updateViaCache: 'none' });
  await Promise.race([
    new Promise(resolve => {
      const controlled = () => {
        const worker = navigator.serviceWorker.controller;
        if (worker && new URL(worker.scriptURL).pathname === new URL('demo-worker.js', base).pathname) {
          navigator.serviceWorker.removeEventListener('controllerchange', controlled);
          resolve();
        }
      };
      navigator.serviceWorker.addEventListener('controllerchange', controlled);
      controlled();
    }),
    new Promise((_, reject) => setTimeout(() => reject(Error('Demo startup timed out')), 30000))
  ]);
  await import(script.dataset.entry);
} catch (error) {
  document.getElementById('root').textContent = '演示启动失败，请刷新或使用支持 Service Worker 的浏览器（HTTPS）。Demo could not start. Reload or use a browser with Service Worker support over HTTPS. デモを開始できません。ページを再読み込みしてください。';
  console.error(error);
}
