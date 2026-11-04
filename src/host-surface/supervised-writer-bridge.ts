// Fixed local-IPC ownership bridge shared verbatim by production and the
// deterministic VM lifecycle test. No configurable code, business messages,
// lease expiry or host dispatch. All bind/release bounds live in the caller.
export const supervisedWriterBridge=String.raw`
const {workerData}=require('node:worker_threads');const net=require('node:net');
const state=new Int32Array(workerData.state),end=Date.now()+5000;
let active=null,stopped=false,acked=false;
function notify(i,v){Atomics.store(state,i,v);Atomics.notify(state,i);}
function closed(){if(!acked){acked=true;notify(2,1);}}
function attempt(){
 if(stopped)return;
 if(Atomics.load(state,1)){stopped=true;closed();return;}
 const server=net.createServer(socket=>socket.destroy());
 const owner={server,bound:false,closing:false,retired:false};active=owner;
 function closeOnce(){
  if(owner!==active||owner.retired||owner.closing)return;
  owner.closing=true;
  const release=()=>{
   if(owner!==active||owner.retired)return;
   try{server.close(error=>{
    if(owner!==active||owner.retired)return;
    if(error){notify(0,-2);return;}
    owner.retired=true;active=null;stopped=true;closed();
   });}catch{notify(0,-2);}
  };
  // A guard error must not release exclusion while the parent can still be
  // between its last ownership assertion and the atomic journal replacement.
  if(Atomics.load(state,1))release();else Promise.resolve(Atomics.waitAsync(state,1,0).value).then(release);
 }
 function failed(error){
  if(owner!==active||owner.retired||stopped)return;
  if(owner.bound){notify(0,-2);closeOnce();return;}
  owner.retired=true;active=null;
  if(error.code==='EADDRINUSE'&&Date.now()<end&&!Atomics.load(state,1)){setTimeout(attempt,10);return;}
  stopped=true;notify(0,error.code==='EADDRINUSE'?-1:-2);closed();
 }
 server.on('error',failed);
 try{server.listen(workerData.endpoint,()=>{
  if(owner!==active||owner.retired||stopped)return;
  owner.bound=true;notify(0,1);
  if(Atomics.load(state,1))closeOnce();else Promise.resolve(Atomics.waitAsync(state,1,0).value).then(closeOnce);
 });}catch(error){failed(error);}
}
try{attempt();}catch{notify(0,-2);if(active===null){stopped=true;closed();}}
`;
