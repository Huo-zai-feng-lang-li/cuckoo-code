
import fs from 'node:fs';
const [,, titleSub, codeFile, exFlag, exSub, idxStr] = process.argv;
const list = await (await fetch('http://127.0.0.1:9444/json/list')).json();
const candidates = list.filter(x => x.type === 'page' && x.title.includes(titleSub) && !(exFlag === '--exclude' && exSub && x.title.includes(exSub)));
const idx = parseInt(idxStr || '0', 10) || 0;
const t = candidates[idx];
if (!t) { console.log('NOT_FOUND candidates=' + candidates.length); process.exit(2); }
const code = fs.readFileSync(codeFile, 'utf-8');
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise(r => ws.addEventListener('open', r));
function send(method, params) { const i = ++id; return new Promise(res => { pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }); }
const r = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(r.result && r.result.result ? r.result.result.value : r.result, null, 1));
if (r.result && r.result.exceptionDetails) console.log('EXCEPTION: ' + JSON.stringify(r.result.exceptionDetails).slice(0,500));
ws.close();
process.exit(0);
