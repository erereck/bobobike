// Tiny static server for local preview: node tools/serve.mjs . 5179
// Fragment pages (dev/index.html) are wrapped in a document skeleton; full documents are served as-is.
// Add ?timer to the URL to drive the game loop with setTimeout (useful when the tab is in the background).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 5179);
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const TIMER_SHIM = '<script>window.requestAnimationFrame=(cb)=>setTimeout(()=>cb(performance.now()),16);</script>';

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.resolve(root, '.' + p);
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (!p.endsWith('.html')) return res.end(data);
    const html = String(data);
    const shim = req.url.includes('timer') ? TIMER_SHIM : '';
    if (/^\s*<!doctype/i.test(html)) return res.end(html.replace('<head>', '<head>' + shim));
    res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
      '<style>[hidden]{display:none!important}body{margin:0}</style>' + shim + '</head><body>' + html + '</body></html>');
  });
}).listen(port, () => console.log('serving on http://localhost:' + port));
