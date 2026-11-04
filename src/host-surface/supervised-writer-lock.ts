import { createHash,randomUUID } from 'node:crypto';
import { existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,readlinkSync,renameSync,rmdirSync,statfsSync,unlinkSync,writeFileSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { canonical } from '../job-runtime/storage-identity.ts';
import { parseD1UniqueJson } from '../job-runtime/contracts.ts';
import { supervisedWriterBridge } from './supervised-writer-bridge.ts';

function need(ok:unknown,reason:string):asserts ok {if(!ok)throw Error(reason);}
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const held=new Set<string>(),windowsIdentities=new Map<string,{machine:string;boot:string;volume:string}>();
function noLinks(path:string):void {const parent=dirname(path);if(parent!==path)noLinks(parent);if(existsSync(path))need(!lstatSync(path).isSymbolicLink(),'SUPERVISED_WRITER_LINK_REJECTED');}
function identity(path:string){noLinks(path);const s=lstatSync(path,{bigint:true});need(s.isDirectory(),'SUPERVISED_WRITER_STORAGE_INVALID');return{dev:String(s.dev),ino:String(s.ino)};}
function domain(root:string){
  const rootIdentity=identity(root);let local:{machine:string;boot:string;volume:string;pid_namespace?:string};
  if(process.platform==='linux'){
    // Explicit local filesystem admission. Network/unknown filesystems stay blocked.
    const localTypes=new Set([0xef53,0x58465342,0x9123683e,0x01021994,0x794c7630,0xf2f52010,0x858458f6,0x2fc12fc1]);
    need(localTypes.has(statfsSync(root).type>>>0),'SUPERVISED_WRITER_LOCAL_FILESYSTEM_REQUIRED');
    const boot=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),net=readlinkSync('/proc/self/ns/net'),pid=readlinkSync('/proc/self/ns/pid');
    need(/^[0-9a-f-]{36}$/.test(boot)&&/^net:\[\d+\]$/.test(net)&&/^pid:\[\d+\]$/.test(pid),'SUPERVISED_WRITER_DOMAIN_UNAVAILABLE');
    local={machine:boot,boot,volume:net,pid_namespace:pid};
  }else if(process.platform==='win32'){
    need(/^[A-Za-z]:\\/.test(root)&&!root.startsWith('\\\\'),'SUPERVISED_WRITER_LOCAL_FILESYSTEM_REQUIRED');
    // Machine/boot identity is process-local; fixed-drive admission is cached
    // per drive/device rather than per Job inode. Root dev/inode is still in
    // the domain and is revalidated on every ownership assertion.
    const cacheKey=canonical({drive:root.slice(0,3).toUpperCase(),dev:rootIdentity.dev});let cached=windowsIdentities.get(cacheKey);
    if(!cached){
      // Fixed read-only query, no policy changes, compiler or injected command text.
      const code="$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:XDEV_FINAL_LOCK_ROOT));$v=New-Object System.IO.DriveInfo([IO.Path]::GetPathRoot($p));if(-not $v.IsReady -or [int]$v.DriveType -ne 3){throw 'LOCAL_FIXED_DRIVE_REQUIRED'};$m=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\\Microsoft\\Cryptography').GetValue('MachineGuid');$b=(Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString('o');@{machine=[string]$m;boot=$b;volume=$v.Name.ToUpperInvariant()}|ConvertTo-Json -Compress";
      const result=spawnSync(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',code],{shell:false,windowsHide:true,timeout:8000,maxBuffer:8192,encoding:'utf8',env:{...process.env,XDEV_FINAL_LOCK_ROOT:Buffer.from(root).toString('base64')}});
      need(!result.error&&result.status===0&&result.signal===null,'SUPERVISED_WRITER_DOMAIN_UNAVAILABLE');
      let value:any;try{value=JSON.parse(result.stdout.trim());}catch{throw Error('SUPERVISED_WRITER_DOMAIN_UNAVAILABLE');}
      need(Object.keys(value).sort().join(',')==='boot,machine,volume'&&typeof value.machine==='string'&&/^[0-9a-f-]{36}$/i.test(value.machine)&&typeof value.boot==='string'&&Number.isFinite(Date.parse(value.boot))&&value.volume===root.slice(0,3).toUpperCase(),'SUPERVISED_WRITER_DOMAIN_UNAVAILABLE');
      cached={machine:value.machine.toLowerCase(),boot:value.boot,volume:value.volume};windowsIdentities.set(cacheKey,cached);
    }
    local=cached;
  }else throw Error('SUPERVISED_WRITER_PLATFORM_UNSUPPORTED');
  return{format:'xdev-supervised-local-domain-1',platform:process.platform,...local,root,...rootIdentity};
}

function kernelGuard<T>(key:string,fn:(assertKernel:()=>void)=>T):T {
  need(!held.has(key),'SUPERVISED_WRITER_REENTRY');
  const state=new Int32Array(new SharedArrayBuffer(12)),endpoint=process.platform==='win32'?'\\\\.\\pipe\\xdev-supervised-final-'+key:'\0xdev-supervised-final-'+key;
  const worker=new Worker(supervisedWriterBridge,{eval:true,execArgv:[],workerData:{state:state.buffer,endpoint}});
  worker.on('error',()=>{Atomics.store(state,0,-2);Atomics.notify(state,0);});worker.unref();
  try{
    Atomics.wait(state,0,0,6500);
    need(Atomics.load(state,0)===1,Atomics.load(state,0)===-1?'SUPERVISED_WRITER_BUSY':'SUPERVISED_WRITER_GUARD_UNAVAILABLE');
    held.add(key);return fn(()=>need(Atomics.load(state,0)===1&&Atomics.load(state,2)===0,'SUPERVISED_WRITER_GUARD_LOST'));
  }finally{
    held.delete(key);Atomics.store(state,1,1);Atomics.notify(state,1);
    if(Atomics.load(state,2)!==1)Atomics.wait(state,2,0,5000);
    if(Atomics.load(state,2)!==1){void worker.terminate().catch(()=>{});throw Error('SUPERVISED_WRITER_GUARD_CLOSE_UNKNOWN');}
  }
}
function ownerAt(lock:string){
  noLinks(lock);const names=readdirSync(lock);need(names.length===1&&names[0]==='owner.json','SUPERVISED_WRITER_OWNER_UNKNOWN');
  const path=join(lock,'owner.json');noLinks(path);const stat=lstatSync(path);need(stat.isFile()&&stat.nlink===1&&stat.size<=8192,'SUPERVISED_WRITER_OWNER_UNKNOWN');
  const bytes=readFileSync(path,'utf8');let value:any;try{value=parseD1UniqueJson(bytes);}catch{throw Error('SUPERVISED_WRITER_OWNER_UNKNOWN');}
  need(canonical(value)+'\n'===bytes,'SUPERVISED_WRITER_OWNER_UNKNOWN');return value;
}
/** PID absence is an additional necessary gate, never sufficient by itself.
 * A worker thread can die while the original parent still owns its transaction. */
function originalParentAbsent(pid:number):void {
  let absent=false;try{process.kill(pid,0);}catch(error){absent=(error as NodeJS.ErrnoException).code==='ESRCH';}
  need(absent,'SUPERVISED_WRITER_ORIGINAL_PARENT_ALIVE_OR_UNKNOWN');
}
/** Read-only capability admission. No Store/claim, lock directory, abandoned
 * rename or owner file is created. A missing store is checked at its nearest
 * existing ancestor; actual QA repeats against the already-created Job root. */
export function inspectSupervisedWriterCapability(root:string,id?:string) {
  let checkedRoot=root;
  try{
    while(!existsSync(checkedRoot)){const parent=dirname(checkedRoot);need(parent!==checkedRoot,'SUPERVISED_WRITER_STORAGE_INVALID');checkedRoot=parent;}
    const d=domain(checkedRoot);
    if(id!==undefined){
      need(checkedRoot===root&&/^job:[0-9a-f-]{36}$/.test(id),'SUPERVISED_WRITER_JOB_INVALID');
      const key=digest(canonical({domain:d,job_id:id})),lock=join(root,id.slice(4)+'.lock');
      kernelGuard(key,assertKernel=>{
        assertKernel();need(canonical(domain(root))===canonical(d),'SUPERVISED_WRITER_DOMAIN_CHANGED');
        if(existsSync(lock)){
          const before=identity(lock),old=ownerAt(lock),fields=['domain','format','job_id','lock_dev','lock_ino','nonce','owner_pid'];
          need(Object.keys(old).sort().join(',')===fields.sort().join(',')&&old.format==='xdev-supervised-writer-lock-1'&&old.domain===key&&old.job_id===id&&old.lock_dev===before.dev&&old.lock_ino===before.ino&&typeof old.nonce==='string'&&/^[0-9a-f-]{36}$/.test(old.nonce)&&Number.isSafeInteger(old.owner_pid)&&old.owner_pid>0,'SUPERVISED_WRITER_OWNER_UNKNOWN');
          originalParentAbsent(old.owner_pid);
          need(canonical(identity(lock))===canonical(before)&&canonical(ownerAt(lock))===canonical(old),'SUPERVISED_WRITER_OWNERSHIP_LOST');
        }
      });
    }
    return{status:'SUPPORTED' as const,platform:process.platform,checked_root:checkedRoot,scope:checkedRoot===root?'EXACT_ROOT':'EXISTING_ANCESTOR',job_lock_checked:id!==undefined,read_only:true as const};
  }catch(error){return{status:'UNSUPPORTED' as const,platform:process.platform,checked_root:checkedRoot,code:error instanceof Error?error.message:String(error),job_lock_checked:id!==undefined,read_only:true as const};}
}
/** New final writers only. Legacy/unknown locks are preserved. Reclamation
 * requires kernel exclusion AND exact same-domain ownership AND parent absence. */
export function withSupervisedWriterLock<T>(root:string,id:string,fn:(assertHeld:()=>void)=>T):T {
  need(/^job:[0-9a-f-]{36}$/.test(id),'SUPERVISED_WRITER_JOB_INVALID');
  const d=domain(root),key=digest(canonical({domain:d,job_id:id})),lock=join(root,id.slice(4)+'.lock');
  return kernelGuard(key,assertKernel=>{
    const assertDomain=()=>{assertKernel();need(canonical(domain(root))===canonical(d),'SUPERVISED_WRITER_DOMAIN_CHANGED');};
    assertDomain();
    if(existsSync(lock)){
      const before=identity(lock),old=ownerAt(lock),expected=['domain','format','job_id','lock_dev','lock_ino','nonce','owner_pid'];
      need(Object.keys(old).sort().join(',')===expected.sort().join(',')&&old.format==='xdev-supervised-writer-lock-1'&&old.domain===key&&old.job_id===id&&old.lock_dev===before.dev&&old.lock_ino===before.ino&&typeof old.nonce==='string'&&/^[0-9a-f-]{36}$/.test(old.nonce)&&Number.isSafeInteger(old.owner_pid)&&old.owner_pid>0,'SUPERVISED_WRITER_OWNER_UNKNOWN');
      originalParentAbsent(old.owner_pid);
      need(canonical(identity(lock))===canonical(before)&&canonical(ownerAt(lock))===canonical(old),'SUPERVISED_WRITER_OWNERSHIP_LOST');
      // Kernel exclusion alone is insufficient: original parent absence was
      // separately required above. Keep abandoned metadata as evidence.
      renameSync(lock,lock+'.abandoned-'+randomUUID());
    }
    mkdirSync(lock,{mode:0o700});const ownIdentity=identity(lock);
    const own={format:'xdev-supervised-writer-lock-1',domain:key,job_id:id,lock_dev:ownIdentity.dev,lock_ino:ownIdentity.ino,nonce:randomUUID(),owner_pid:process.pid};
    // Death before this exclusive write leaves UNKNOWN and is intentionally blocked.
    writeFileSync(join(lock,'owner.json'),canonical(own)+'\n',{flag:'wx',mode:0o600});
    const assertHeld=()=>{assertDomain();need(canonical(identity(lock))===canonical(ownIdentity)&&canonical(ownerAt(lock))===canonical(own),'SUPERVISED_WRITER_OWNERSHIP_LOST');};
    try{assertHeld();return fn(assertHeld);}finally{assertHeld();unlinkSync(join(lock,'owner.json'));rmdirSync(lock);}
  });
}
