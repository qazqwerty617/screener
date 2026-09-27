"use strict";
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname,'../../node-server');
const express = require(path.join(root,'node_modules/express'));
const { createEventsHub } = require(path.join(root,'eventsHub'));
const app = express();
const hub = createEventsHub({filePath: path.join(__dirname,'preview-events.json'), translate: async()=>null});
app.get('/api/events', (req,res)=>res.json(hub.snapshot()));
app.get('/api/events/stream',(req,res)=>{res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.write(': preview\n\n');const unsubscribe=hub.subscribe(()=>res.write('event: update\ndata: {}\n\n'));res.on('close',unsubscribe)});
app.get('/', (req,res)=>{
 const html = fs.readFileSync(path.join(root,'public/index.html'),'utf8');
 const section = html.match(/<section id="events-view"[\s\S]*?<\/section>/)[0].replace('display:none','display:block');
 res.send(`<!doctype html><html lang="ru"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Проверка событий Obsidian</title><link rel="stylesheet" href="/css/fonts.css"><link rel="stylesheet" href="/css/app.css"><link rel="stylesheet" href="/css/events.css"><body><main style="width:100%;height:100vh">${section}</main><script src="/js/events.js"></script><script>ObsidianEvents.activate();</script></body></html>`);
});
app.use(express.static(path.join(root,'public')));
app.listen(3099,'127.0.0.1',()=>console.log('Read-only events preview on port 3099'));
hub.refreshNews().then(()=>console.log(JSON.stringify({news:hub.snapshot().news.length,developing:hub.snapshot().developing.length,announcements:hub.snapshot().announcements.length,sources:hub.snapshot().sources})));
