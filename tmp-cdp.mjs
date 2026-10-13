const PORT='9444';
const list = await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();
const shell = list.find(t=>t.url.includes('shell.html'));
const ws = new WebSocket(shell.webSocketDebuggerUrl);
let id=0;const p=new Map();
const send=(m,pa)=>new Promise(r=>{const i=++id;p.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:pa}));});
ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});
await new Promise(r=>ws.addEventListener('open',r));
const e=await send('Runtime.evaluate',{expression:`(()=>{
  const b=document.createElement('div');b.style.position='fixed';b.style.left='-9999px';
  const it=document.createElement('div');it.className='ck-skill-item';
  const d=document.createElement('div');d.className='ck-skill-desc';d.textContent='x';it.appendChild(d);b.appendChild(it);document.body.appendChild(b);
  const cs=getComputedStyle(d);
  const o={transition:cs.transition,transitionDelay:cs.transitionDelay,maxHeight:cs.maxHeight,opacity:cs.opacity};
  b.remove();return o;
})()`,returnByValue:true});
console.log(JSON.stringify(e.result.result?e.result.result.value:e.result,null,2));ws.close();
