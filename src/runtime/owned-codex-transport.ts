/** Selective R4.22 process/close semantics; no controller or recovery import. */
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {requireLaunchCapability} from '../execution/launch-controller.ts';
import type {WorkerStartInput} from '../worker-adapter/contracts.ts';
import type {JsonlConnection} from '../integrations/codex/rpc.ts';
import {controlNoLinks} from '../execution/control-source-boundary.ts';
export type RuntimeIdentity={format:'xdev-codex-runtime-identity-1';executable:string;sha256:string;version:string;argv:string[];runtime_id:string;valid_until:string;owner_ack:'FREEZE_EXACT_CODEX_RUNTIME_FOR_SEPARATELY_AUTHORIZED_EXECUTION';};
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
export function resolveTrustedCodexRuntime():RuntimeIdentity{
 if(arguments.length)throw Error('PRODUCTION_RESOLVER_ARGUMENTS_REJECTED');
 const root=process.env.LOCALAPPDATA;if(!root||!isAbsolute(root))throw Error('TRUSTED_RUNTIME_NOT_ESTABLISHED');
 const path=join(root,'XDev','installation-trust','v1','codex-runtime.json');controlNoLinks(path);
 const r=JSON.parse(readFileSync(path,'utf8')) as RuntimeIdentity;
 if(r.format!=='xdev-codex-runtime-identity-1'||r.owner_ack!=='FREEZE_EXACT_CODEX_RUNTIME_FOR_SEPARATELY_AUTHORIZED_EXECUTION'||!r.runtime_id||!r.version.startsWith('codex-cli ')||r.valid_until<=new Date().toISOString()||JSON.stringify(r.argv)!=='["app-server"]'||!isAbsolute(r.executable)||resolve(r.executable)!==r.executable)throw Error('TRUSTED_RUNTIME_IDENTITY_INVALID');
 controlNoLinks(r.executable);if(!lstatSync(r.executable).isFile()||realpathSync(r.executable)!==r.executable||sha(readFileSync(r.executable))!==r.sha256)throw Error('HOST_EXECUTABLE_IDENTITY_CHANGED');
 return Object.freeze(structuredClone(r));
}
export class OwnedJsonlConnection implements JsonlConnection{
 readonly evidence_scope:'PRODUCTION'|'TEST_ONLY_TRANSPORT';readonly processEvidence:{event:string;at:string;detail:unknown}[]=[];
 private readonly child:ChildProcessWithoutNullStreams;private readonly data=new Set<(v:Uint8Array|string)=>void>();private readonly failures=new Set<(v:string)=>void>();private early:Buffer[]=[];private earlyBytes=0;private failed:string|null=null;private closed=false;private stderr=Buffer.alloc(0);private stderrTotal=0;private closePromise:Promise<void>|null=null;
 private readonly closeMs:number;private wireGuard:((frame:string)=>void)|null=null;
 private constructor(executable:string,args:string[],cwd:string,scope:'PRODUCTION'|'TEST_ONLY_TRANSPORT',closeMs:number){
   this.closeMs=closeMs;
   if(!isAbsolute(cwd)||resolve(cwd)!==cwd||closeMs<20||closeMs>5000)throw Error('OWNED_PROCESS_SCOPE_INVALID');this.evidence_scope=scope;
   this.child=spawn(executable,args,{cwd,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,CODEX_HOME:scope==='TEST_ONLY_TRANSPORT'?undefined:process.env.CODEX_HOME}});this.record('SPAWN_REQUEST',{executable,args,cwd,shell:false,stdio:'pipe',windowsHide:true,evidence_scope:scope});
   this.child.stdout.on('data',(b:Buffer)=>{if(this.data.size)for(const f of this.data)f(b);else{this.earlyBytes+=b.length;if(this.earlyBytes>1024*1024)this.fail('STDOUT_BEFORE_SUBSCRIBE_LIMIT');else this.early.push(Buffer.from(b));}});
   this.child.stderr.on('data',(b:Buffer)=>{this.stderrTotal+=b.length;this.stderr=Buffer.concat([this.stderr,b]).subarray(-4096);});
   this.child.on('error',e=>this.fail('HOST_PROCESS_ERROR:'+e.message));this.child.stdin.on('error',e=>this.fail('HOST_STDIN_ERROR:'+e.message));
   this.child.on('exit',(code,signal)=>{this.record('EXIT',{code,signal});this.fail('HOST_PROCESS_EXITED:'+code+':'+signal);});
   this.child.on('close',(code,signal)=>{this.closed=true;this.record('CLOSE',{code,signal,stderr:this.stderr.toString('utf8'),stderr_bytes:this.stderrTotal,truncated:this.stderrTotal>4096});});
 }
 private record(event:string,detail:unknown){this.processEvidence.push({event,at:new Date().toISOString(),detail});}
 private fail(s:string){if(this.failed)return;this.failed=s;for(const f of this.failures)f(s);}
 private bind(input:WorkerStartInput){const cap=requireLaunchCapability(input);this.wireGuard=frame=>{const m=JSON.parse(frame).method;if(m==='thread/start')cap.consumeWire('CONTAINER');else if(m==='turn/start')cap.consumeWire('OPERATION');else if(!['initialize','initialized','thread/read'].includes(m))throw Error('HOST_METHOD_NOT_AUTHORIZED');};return this;}
 static production(runtime:RuntimeIdentity,cwd:string,input:WorkerStartInput){requireLaunchCapability(input);const current=resolveTrustedCodexRuntime();if(JSON.stringify(current)!==JSON.stringify(runtime))throw Error('HOST_EXECUTABLE_IDENTITY_CHANGED');return new OwnedJsonlConnection(current.executable,current.argv,cwd,'PRODUCTION',5000).bind(input);}
 static testOnly(cwd:string,mode:string,closeMs=300,input?:WorkerStartInput){if(!['ok','rpc-error','early-exit','timeout','empty','stderr','hold-open','turn-timeout','malformed'].includes(mode))throw Error('TEST_CHILD_MODE_INVALID');const fixture=fileURLToPath(new URL('../../tests/fixtures/s4a-owned-child.cjs',import.meta.url));const connection=new OwnedJsonlConnection(process.execPath,[fixture,mode],cwd,'TEST_ONLY_TRANSPORT',closeMs);return input?connection.bind(input):connection;}
 write(frame:string){if(this.failed||this.closed)throw Error(this.failed??'TRANSPORT_CLOSED');this.wireGuard?.(frame);this.child.stdin.write(frame);}
 onData(fn:(bytes:Uint8Array|string)=>void){this.data.add(fn);for(const b of this.early)fn(b);this.early=[];return()=>{this.data.delete(fn);};}
 onFailure(fn:(message:string)=>void){this.failures.add(fn);if(this.failed)fn(this.failed);return()=>{this.failures.delete(fn);};}
 diagnostics(){return{events:structuredClone(this.processEvidence),stderr:this.stderr.toString('utf8'),stderr_bytes:this.stderrTotal,stderr_truncated:this.stderrTotal>4096,remote_worker_stopped:false as const};}
 close():Promise<void>{if(this.closePromise)return this.closePromise;this.closePromise=new Promise((done,reject)=>{if(this.closed){done();return;}let ended=false;const finish=()=>{if(ended)return;ended=true;clearTimeout(force);clearTimeout(deadline);done();};this.child.once('close',finish);this.child.stdin.end();const force=setTimeout(()=>{this.record('FORCE_CLOSE',{owned_child_only:true});this.child.kill();},Math.max(10,Math.floor(this.closeMs/2)));const deadline=setTimeout(()=>{if(ended)return;ended=true;this.record('CLOSE_DEADLINE',{});this.child.kill('SIGKILL');reject(Error('OWNED_PROCESS_CLOSE_TIMEOUT'));},this.closeMs);});return this.closePromise;}
}
