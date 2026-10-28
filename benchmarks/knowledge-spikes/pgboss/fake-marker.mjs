// A stand-in for the Marker service: answers after ?seconds=N, like a slow conversion.
import console from 'node:console';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { URL } from 'node:url';
import http from 'node:http';
const port = Number(process.argv[2] ?? 18099);
http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const seconds = Number(url.searchParams.get('seconds') ?? 1);
    const timer = setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, pages: ['{0}', 'page'] }));
    }, seconds * 1000);
    req.on('close', () => clearTimeout(timer));
  })
  .listen(port, '127.0.0.1', () => console.log(`fake marker on ${port}`));
