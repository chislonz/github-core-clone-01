import { createApp } from './app.ts';
const base=(process.env.MAKEFUN_ENV_URL||'').replace(/\/+$/,'');
if(!base){console.error('MAKEFUN_ENV_URL is required');process.exit(1);}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const server=createApp();
await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'0.0.0.0',resolve);});
const address=server.address();
if(!address||typeof address==='string')throw Error('No TCP address');
for(let attempt=0;;attempt++){
 try{const res=await fetch(base+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({port:address.port}),signal:AbortSignal.timeout(30000)});if(res.status===200||res.status===409)break;if(res.status===400||res.status===405){console.error('Registration rejected');process.exit(1);}}catch{}
 await sleep(Math.min(2000,250*2**Math.min(attempt,3)));
}
for(;;){try{const res=await fetch(base+'/done',{signal:AbortSignal.timeout(30000)});if(res.ok&&(await res.json()).done===true)break;}catch{}await sleep(250);}
server.close();server.closeAllConnections();process.exit(0);
