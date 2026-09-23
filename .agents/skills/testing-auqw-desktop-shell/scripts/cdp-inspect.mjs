const expr = process.argv[2] ?? '1+1';
const targets = await (await fetch('http://127.0.0.1:9330/json/list')).json();
const t = targets.find(x => x.type === 'node' || x.url?.includes('electron')) ?? targets[0];
if (!t) { console.log('NO TARGET', JSON.stringify(targets.map(x=>[x.type,x.title,x.url]))); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
const done = new Promise((resolve) => {
  ws.onopen = () => ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:expr,awaitPromise:true,returnByValue:true}}));
  ws.onmessage = (ev)=>{const m=JSON.parse(ev.data); if(m.id===1) resolve(m);};
});
console.log(JSON.stringify(await done,null,1).slice(0,3000));
ws.close(); process.exit(0);
