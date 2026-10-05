const fs=require('node:fs');
const path=require('node:path');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function observe(port,directory,done,untrusted=false) {
 let socket, pending=new Map(),serial=0;
 const call=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));
 });
 try{
  const deadline=Date.now()+60000;
  while(Date.now()<deadline&&!done.finished){
   try{
    const pages=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    const page=pages.find(p=>p.type==='page'&&p.url.includes('workbench'));
    if(page){socket=new WebSocket(page.webSocketDebuggerUrl);break;}
   }catch{}
   await delay(200);
  }
  if(!socket)throw new Error('Renderer debugger unavailable');
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',event=>{const m=JSON.parse(event.data);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}});
  if(untrusted){
   const until=Date.now()+20000;
   while(Date.now()<until){
    const result=await call('Runtime.evaluate',{returnByValue:true,expression:"document.body.innerText"});
    if((result.result.value||'').includes('Restricted Mode')&&(result.result.value||'').includes('Mognitio')){
     await delay(1500);
     fs.writeFileSync(path.join(directory,'untrusted-observed'),'Restricted Mode with Mognitio file association');
     return;
    }
    await delay(100);
   }
   throw new Error('Restricted editor did not activate lexical support');
  }
  for(const phase of ['on','off']){
   const until=Date.now()+40000;let passed=false;
   while(Date.now()<until&&!done.finished){
    if(fs.existsSync(path.join(directory,phase))){
     const result=await call('Runtime.evaluate',{returnByValue:true,expression:"JSON.stringify([...document.querySelectorAll('.monaco-editor .view-line span')].filter(e=>e.childElementCount===0&&e.textContent.includes('value')).map(e=>getComputedStyle(e).color))"});
     const colors=JSON.parse(result.result.value||'[]');
     if(colors.length&&(phase==='on'?colors.includes('rgb(255, 0, 255)'):!colors.includes('rgb(255, 0, 255)'))){
      const shot=await call('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(directory,phase+'.png'),Buffer.from(shot.data,'base64'));
      fs.writeFileSync(path.join(directory,phase+'-observed'),JSON.stringify(colors));passed=true;break;
     }
    }
    await delay(100);
   }
   if(!passed)throw new Error('Semantic paint observation failed: '+phase);
  }
 }finally{socket?.close();}
}
module.exports={observe};
