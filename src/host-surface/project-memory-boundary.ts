/** Explicit J01 storage boundary. Functions perform bounded IO; no SDK loads at import. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonical } from '../job-runtime/storage-identity.ts';
import { parseD1UniqueJson } from '../job-runtime/contracts.ts';

export const PHYSICAL_BUILD='31a9132b6d99124b8b282d21f56299f6186d6fff25400d3604d020e9b72f2b4a';
/** TEST_ONLY diagnostic successor build; not a released or qualified runtime. */
export const UNIFIED_BUILD='83cb3e28899687faaf5e04e8f53ef0d6437d32205dde9dca857172c68b7b2eff';
export const E7_NATIVE_BUILD='0832c4e414d53da6d1b09c9fa694e542d62b8b0c43fa67ed9b0404b62417810d';
const E7_NATIVE_HELPER='dist/src/xmem-win-physical.exe';
const E7_NATIVE_HELPER_SHA='63dd9f3c445ab43a075c0cc4487d7cdc2a7b60de3d67fe491a8528bf62329851';
export const LAYOUT_HASH='a0b9376a101f956c9d30f2fcaa89876b6eeb19dc0ea2b58c5ba4ea81582da06c';
/** Closed exact identities. Additional entries require actual frozen producer
 * artifacts; no path, runtime claim or caller input can register a build. */
export const BOUNDARY_BUILDS:Readonly<Record<string,{js:number;runtime:number;layout:string}>>=Object.freeze({[PHYSICAL_BUILD]:{js:37,runtime:39,layout:LAYOUT_HASH},[UNIFIED_BUILD]:{js:46,runtime:48,layout:LAYOUT_HASH},[E7_NATIVE_BUILD]:{js:47,runtime:50,layout:LAYOUT_HASH}});
export const STATIC_SLOTS=['PROJECT_CONFIG','STANDALONE_POLICY','STORAGE_LOCATION','SHARING_POLICY','CUSTOM_IDENTITY'] as const;
export type BoundaryRef={path:string;sha256:string};
export type Boundary={format:'xdev-project-memory-boundary-1';xdev_project_id:string;project_root:string;project_id:string;workspace_id:string;role:'developer';mode:'PROJECT_LOCAL'|'CUSTOM_LOCAL';storage_root:string;location_hash:string;policy_hash:string;static_files:Record<typeof STATIC_SLOTS[number],{presence:'PRESENT'|'ABSENT';sha256:string|null}>;layout_contract_sha256:string;sdk_build_id:string;deployment:BoundaryRef};
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const hex=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function check(x:unknown,code:string):asserts x {if(!x)throw Error('MEMORY_BOUNDARY_'+code);}
function exact(x:any,keys:readonly string[]){check(x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join('|')===[...keys].sort().join('|'),'SHAPE');}
export function boundaryWithin(root:string,path:string){const r=relative(root,path);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));}
function safe(path:string){
 check(typeof path==='string'&&isAbsolute(path)&&resolve(path)===path,'PATH');
 const ancestors:string[]=[];for(let p=path;;p=dirname(p)){check(isAbsolute(p)&&resolve(p)===p,'PATH');ancestors.push(p);if(dirname(p)===p)break;}
 let deepest:string|undefined,failure:unknown;
 for(const p of ancestors.reverse()){
  let s;try{s=lstatSync(p);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;failure=error;break;}
  check(!s.isSymbolicLink(),'LINK');deepest=p;
 }
 // Native resolution validates the entire existing prefix, including its case
 // and short-name spelling. Missing descendants never hide an ancestor link.
 // Resolve before propagating a later lstat error, as the old ancestor walk did.
 if(deepest!==undefined)check(realpathSync.native(deepest).toLowerCase()===deepest.toLowerCase(),'LINK');
 if(failure!==undefined)throw failure;
}
function leaf(path:string,limit=2*1024*1024){safe(path);const s=lstatSync(path);check(s.isFile()&&s.nlink===1&&s.size<=limit,'FILE');return readFileSync(path);}
export function readBoundaryRef(ref:BoundaryRef){exact(ref,['path','sha256']);check(hex(ref.sha256),'REF');const b=leaf(ref.path);check(sha(b)===ref.sha256,'SOURCE_DRIFT');return parseD1UniqueJson(b.toString('utf8')) as any;}
export function locationHash(project_id:string,mode:Boundary['mode'],storage_root:string){return sha(JSON.stringify({schema_version:1,project_id,mode,storage_root}));}
export function boundaryDeployment(b:Boundary){
 const qualified=BOUNDARY_BUILDS[b.sdk_build_id];check(qualified,'BUILD_UNSUPPORTED');
 const inv=readBoundaryRef(b.deployment);exact(inv,['format','runtime_root','count','files']);
 check(inv.format==='XMEM_DEPLOYED_FILE_INVENTORY_NOT_LOADED_PROCESS_IDENTITY'&&inv.count===qualified.runtime&&Array.isArray(inv.files)&&inv.files.length===qualified.runtime,'DEPLOYMENT');safe(inv.runtime_root);
 const members=new Map<string,string>(),expected=new Map<string,{bytes:number;sha256:string}>();for(const f of inv.files){exact(f,['path','bytes','sha256']);check(typeof f.path==='string'&&!f.path.includes('\\')&&!f.path.includes(':')&&f.path.split('/').every((s:string)=>s!==''&&s!=='.'&&s!=='..')&&hex(f.sha256)&&Number.isSafeInteger(f.bytes)&&f.bytes>=0&&!members.has(f.path),'DEPLOYMENT_MEMBER');const p=resolve(inv.runtime_root,f.path);check(boundaryWithin(inv.runtime_root,p),'DEPLOYMENT_ESCAPE');members.set(f.path,f.sha256);expected.set(f.path,{bytes:f.bytes,sha256:f.sha256});}
 const sourceDir=join(inv.runtime_root,'dist/src');safe(sourceDir);const names=readdirSync(sourceDir).filter(n=>n.endsWith('.js')).sort();
 const extra=b.sdk_build_id===E7_NATIVE_BUILD?[E7_NATIVE_HELPER]:[];
 if(extra.length)check(members.get(E7_NATIVE_HELPER)===E7_NATIVE_HELPER_SHA,'NATIVE_HELPER_PIN');
 check(names.length===qualified.js&&canonical([...members.keys()].sort())===canonical([...names.map(n=>'dist/src/'+n),'package.json','npm-shrinkwrap.json',...extra].sort()),'DEPLOYMENT_SET');
 let packageData:Buffer|undefined;
 const actual:string[]=[];
 const canonicalLeaves=process.platform==='win32'&&process.arch==='x64';
 const visit=(dir:string)=>{
  safe(dir);
  for(const n of readdirSync(dir)){
   const p=join(dir,n),st=lstatSync(p);
   if(p===join(inv.runtime_root,'node_modules')){safe(p);check(lstatSync(p).isDirectory(),'DEPENDENCY_ROOT');continue;}
   const rel=relative(inv.runtime_root,p).split(sep).join('/');
   if(st.isDirectory()){check(['dist','dist/src'].includes(rel),'DEPLOYMENT_SET');visit(p);continue;}
   // The fixed Windows inventories verify each directory on entry and exit.
   // Check every leaf's live canonical path and metadata before hashing it.
   if(canonicalLeaves){
    check(realpathSync.native(p).toLowerCase()===p.toLowerCase(),'LINK');
    const leafStat=b.sdk_build_id===PHYSICAL_BUILD?lstatSync(p):st;
    check(leafStat.isFile()&&!leafStat.isSymbolicLink()&&leafStat.nlink===1&&leafStat.size<=2*1024*1024,'FILE');
   }
   const data=canonicalLeaves?readFileSync(p):leaf(p),pin=expected.get(rel);
   check(pin&&data.length===pin.bytes&&sha(data)===pin.sha256,'DEPLOYMENT_DRIFT');
   if(rel==='package.json')packageData=data;
   actual.push(rel);check(actual.length<=qualified.runtime,'DEPLOYMENT_SET');
  }
  if(canonicalLeaves)safe(dir);
 };
 visit(inv.runtime_root);
 check(canonical(actual.sort())===canonical([...members.keys()].sort()),'DEPLOYMENT_SET');
 check(sha(JSON.stringify({files:names.map(name=>({name,sha256:members.get('dist/src/'+name)})),package_sha256:members.get('package.json'),lock_sha256:members.get('npm-shrinkwrap.json')}))===b.sdk_build_id,'BUILD_DRIFT');
 check(packageData,'DEPLOYMENT_SET');const pkg=parseD1UniqueJson(packageData.toString('utf8')) as any;check(pkg.name==='xmem'&&pkg.exports?.['.']==='./dist/src/index.js'&&pkg.exports?.['./standalone']==='./dist/src/standalone.js'&&pkg.exports?.['./engineering-memory']==='./dist/src/engineering-memory.js'&&pkg.exports?.['./shared-memory']==='./dist/src/shared-memory.js','EXPORTS');return inv;
}
function validatedBoundaryData(ref:BoundaryRef,subject?:{projectRoot:string;projectId:string;controlRoot?:string}) {
 const b=readBoundaryRef(ref) as Boundary;exact(b,['format','xdev_project_id','project_root','project_id','workspace_id','role','mode','storage_root','location_hash','policy_hash','static_files','layout_contract_sha256','sdk_build_id','deployment']);
 check(b.format==='xdev-project-memory-boundary-1'&&b.role==='developer'&&['PROJECT_LOCAL','CUSTOM_LOCAL'].includes(b.mode)&&Object.hasOwn(BOUNDARY_BUILDS,b.sdk_build_id)&&b.layout_contract_sha256===BOUNDARY_BUILDS[b.sdk_build_id]!.layout,'CONTRACT');
 if(b.sdk_build_id===E7_NATIVE_BUILD)check(process.platform==='win32'&&process.arch==='x64','E7_NATIVE_WINDOWS_X64_REQUIRED');
 for(const x of [b.xdev_project_id,b.project_id,b.workspace_id])check(typeof x==='string'&&x.trim().length>0&&x.length<=256&&!/[\x00-\x1f]/.test(x),'IDENTITY');
 check(hex(b.location_hash)&&hex(b.policy_hash),'HASH');safe(b.project_root);safe(b.storage_root);check(lstatSync(b.project_root).isDirectory()&&lstatSync(b.storage_root).isDirectory(),'ROOT');
 if(subject){check(b.project_root===subject.projectRoot&&b.xdev_project_id===subject.projectId,'SUBJECT');if(subject.controlRoot)check(!boundaryWithin(subject.controlRoot,b.storage_root)&&!boundaryWithin(b.storage_root,subject.controlRoot),'CONTROL_OVERLAP');}
 check(b.mode==='PROJECT_LOCAL'?b.storage_root===join(b.project_root,'.xmem'):!boundaryWithin(b.project_root,b.storage_root)&&!boundaryWithin(b.storage_root,b.project_root),'MODE');
 exact(b.static_files,STATIC_SLOTS);const paths=[...['config.json','standalone-v1.json','storage-location-v1.json','sharing-v1.json'].map(n=>join(b.project_root,'.xmem',n)),join(b.storage_root,'xmem-storage-identity-v1.json')];let total=0;const staticData:Buffer[]=[];
 for(const [i,name] of STATIC_SLOTS.entries()){const c=b.static_files[name];exact(c,['presence','sha256']);check(c.presence==='PRESENT'&&hex(c.sha256)||c.presence==='ABSENT'&&c.sha256===null,'STATIC_COMMIT');check((i<3||i===4&&b.mode==='CUSTOM_LOCAL')?c.presence==='PRESENT':true,'STATIC_REQUIRED');check(i!==4||b.mode!=='PROJECT_LOCAL'||c.presence==='ABSENT','CUSTOM_IDENTITY');check(existsSync(paths[i]!)===(c.presence==='PRESENT'),'STATIC_PRESENCE');if(c.presence==='PRESENT'){const data=leaf(paths[i]!);total+=data.length;check(total<=2*1024*1024&&sha(data)===c.sha256,'STATIC_DRIFT');staticData[i]=data;}}
 const config=parseD1UniqueJson(staticData[0]!.toString('utf8')) as any;exact(config,['schema_version','project_id','root']);check(config.schema_version===1&&config.project_id===b.project_id&&config.root===b.project_root,'PROJECT_IDENTITY');
 const policy=parseD1UniqueJson(staticData[1]!.toString('utf8')) as any;check(sha(canonical(policy))===b.policy_hash&&policy.schema_version===1&&policy.mode==='SEMI_AUTO'&&policy.enabled===true&&policy.workspace_id===b.workspace_id&&policy.default_role==='developer'&&canonical(policy.allowed_roles)===canonical(['developer']),'POLICY');
 const loc=parseD1UniqueJson(staticData[2]!.toString('utf8'));check(canonical(loc)===canonical({schema_version:1,project_id:b.project_id,mode:b.mode,storage_root:b.storage_root})&&locationHash(b.project_id,b.mode,b.storage_root)===b.location_hash,'LOCATION');
 if(b.mode==='CUSTOM_LOCAL'){const id=parseD1UniqueJson(staticData[4]!.toString('utf8')) as any;exact(id,['schema_version','project_id']);check(id.schema_version===1&&id.project_id===b.project_id,'CUSTOM_IDENTITY');}
 const deployment=boundaryDeployment(b);return{boundary:b,deployment,dynamic:inspectBoundaryLayout(b)};
}
export function validateBoundary(ref:BoundaryRef,subject?:{projectRoot:string;projectId:string;controlRoot?:string}):Boundary {return validatedBoundaryData(ref,subject).boundary;}
/** Every entry is bounded and checked; only canonical data leaves are omitted from code digest. */
function inspectLayout(b:Boundary,observe?:{directory:(p:string)=>void;file:(p:string,data:Buffer)=>void}){
 const dynamic=new Set<string>();let count=0;
 const walk=(dir:string,storage:boolean,parts:string[]=[])=>{safe(dir);observe?.directory(dir);for(const name of readdirSync(dir).sort()){check(++count<=4096,'MEMBER_LIMIT');const p=join(dir,name),rel=[...parts,name],s=lstatSync(p);safe(p);if(storage){const r=rel.join('/'),active=boundaryWithin(b.storage_root,p),staticName=(active&&b.mode==='CUSTOM_LOCAL'?['xmem-storage-identity-v1.json']:['config.json','standalone-v1.json','storage-location-v1.json','sharing-v1.json']).includes(r);const db=active&&/^xmem\.sqlite(?:-wal|-shm|-journal)?$/.test(r),artifact=active&&/^artifacts\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(r);if(s.isDirectory()){check(active&&(r==='artifacts'||/^artifacts\/[a-f0-9]{2}$/.test(r)),'UNKNOWN_DIRECTORY');walk(p,true,rel);continue;}check(staticName||db||artifact,'UNKNOWN_MEMBER');check(s.isFile()&&s.nlink===1,'DATA_FILE');if(db){check(s.size<=8*1024*1024,'DATABASE_SIZE');dynamic.add(p);}if(artifact){check(rel[1]===name.slice(0,2)&&sha(leaf(p))===name,'ARTIFACT');dynamic.add(p);}if(staticName){const data=leaf(p);observe?.file(p,data);}}else{if(p===join(b.project_root,'.xmem')){check(s.isDirectory(),'XMEM_DIRECTORY');walk(p,true);continue;}if(s.isDirectory())walk(p,false,rel);else{const data=leaf(p);observe?.file(p,data);}}}};
 walk(b.project_root,false);if(b.mode==='CUSTOM_LOCAL')walk(b.storage_root,true);return dynamic;
}
export function inspectBoundaryLayout(b:Boundary){return inspectLayout(b);}
/** Private synchronous handoff only. No caller can supply validated data. */
function composeBoundaryManifest(data:ReturnType<typeof validatedBoundaryData>){
 const {boundary:b,dynamic}=data,root=b.project_root,out:{path:string;sha256:string}[]=[],directories=new Map<string,{dev:number;ino:number}>();
 const remember=(dir:string)=>{safe(dir);const s=lstatSync(dir);check(s.isDirectory(),'DIRECTORY');directories.set(dir,{dev:s.dev,ino:s.ino});};
 const visit=(dir:string)=>{remember(dir);for(const n of readdirSync(dir).sort()){const p=join(dir,n);if(lstatSync(p).isDirectory())visit(p);else if(!dynamic.has(p))out.push({path:relative(root,p).split(sep).join('/'),sha256:sha(leaf(p))});}};
 visit(root);if(b.mode==='CUSTOM_LOCAL')remember(b.storage_root);
 const paths=[...['config.json','standalone-v1.json','storage-location-v1.json','sharing-v1.json'].map(n=>join(root,'.xmem',n)),join(b.storage_root,'xmem-storage-identity-v1.json')],staticPins=new Map<string,string>();
 for(const [i,name] of STATIC_SLOTS.entries()){const pin=b.static_files[name];check(existsSync(paths[i]!)===(pin.presence==='PRESENT'),'STATIC_PRESENCE');if(pin.presence==='PRESENT')staticPins.set(paths[i]!,pin.sha256!);}
 const finalFiles:{path:string;sha256:string}[]=[],finalDirectories=new Set<string>(),seenStatic=new Set<string>();
 inspectLayout(b,{directory:(dir)=>{const s=lstatSync(dir);check(s.isDirectory(),'DIRECTORY');const previous=directories.get(dir);if(previous){check(s.dev===previous.dev&&s.ino===previous.ino,'DIRECTORY_REPLACED');finalDirectories.add(dir);}else if(boundaryWithin(root,dir))check(boundaryWithin(join(root,'.xmem','artifacts'),dir),'DIRECTORY_SET');},file:(p,bytes)=>{const digest=sha(bytes),pin=staticPins.get(p);if(pin!==undefined){check(digest===pin,'STATIC_DRIFT');seenStatic.add(p);}if(boundaryWithin(root,p))finalFiles.push({path:relative(root,p).split(sep).join('/'),sha256:digest});}});
 for(const p of staticPins.keys())check(seenStatic.has(p),'STATIC_PRESENCE');
 for(const dir of directories.keys())check(finalDirectories.has(dir),'DIRECTORY_SET');
 const sort=(members:{path:string;sha256:string}[])=>members.sort((a,c)=>a.path.localeCompare(c.path,'en'));
 check(canonical(sort(finalFiles))===canonical(sort(out)),'MANIFEST_DRIFT');return out;
}
export function boundaryManifest(root:string,ref:BoundaryRef,projectId?:string){return composeBoundaryManifest(validatedBoundaryData(ref,{projectRoot:root,projectId:projectId??readBoundaryRef(ref).xdev_project_id}));}
export function boundaryOptions(b:Boundary,deadline:number,payload=16384){const remaining=deadline-Date.now();check(Number.isSafeInteger(deadline)&&remaining>0&&remaining<=10000,'DEADLINE');check(Number.isSafeInteger(payload)&&payload>=0&&payload<=16384,'PAYLOAD');return{storage_read_profile:'PHYSICAL_CLOSED_V1',expected:{project_id:b.project_id,workspace_id:b.workspace_id,role:b.role,mode:b.mode,canonical_storage_root:b.storage_root,location_hash:b.location_hash,policy_hash:b.policy_hash,static_files:b.static_files},payload_budget_bytes:payload,deadline_unix_ms:deadline};}
export function checkBoundaryHealth(b:Boundary,value:any,payload=16384){exact(value,['ok','contract','profile','status','binding','source_image','storage','reason_codes']);check(Buffer.byteLength(JSON.stringify(value))<=payload&&value.contract==='xmem-physical-readonly-preflight/1'&&value.profile==='PHYSICAL_CLOSED_V1'&&typeof value.ok==='boolean'&&Array.isArray(value.reason_codes),'HEALTH_ENVELOPE');check(value.ok===true&&['CHECKED_CLOSED_IMAGE','NOT_CREATED'].includes(value.status),'HEALTH_'+String(value.status));check(canonical(value.binding)===canonical({project_id:b.project_id,workspace_id:b.workspace_id,role:b.role,mode:b.mode,location_hash:b.location_hash,policy_hash:b.policy_hash}),'HEALTH_BINDING');if(value.status==='NOT_CREATED')check(value.source_image===null&&value.storage?.status==='NOT_CREATED'&&value.storage.sqlite_check==='NOT_RUN','HEALTH_NOT_CREATED');else check(hex(value.source_image?.sha256)&&Number.isSafeInteger(value.source_image.byte_length)&&value.source_image.byte_length>0&&value.source_image.byte_length<=8*1024*1024&&value.storage?.status==='OK'&&String(value.storage.schema_version)==='9'&&value.storage.sqlite_check==='PASS','HEALTH_IMAGE');return value;}
function genericDoctorBoundary(ref:BoundaryRef){
 check(readBoundaryRef(ref)?.sdk_build_id!==E7_NATIVE_BUILD,'E7_RELATED_ONLY');
 return validatedBoundaryData(ref);
}
/** Native ordinary consumption requires its own closed v4 boundary. Any
 * ordinary dependency still passes the independent registration guards. */
export function nativeOrdinaryAllowed(c:any,build:unknown):boolean {
 const m=c?.memory_bridge;
 return build===E7_NATIVE_BUILD&&m?.node?.sha256==='5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5'&&
  m.engineering?.enabled!==true&&m.related?.enabled!==true&&
  (m.dependencies===undefined||Object.keys(m.dependencies).every(k=>k==='ordinary'))&&
  c.approved_requests?.length===1;
}
function doctorBoundary(ref:BoundaryRef,nativeOrdinaryConfig?:BoundaryRef){
 if(nativeOrdinaryConfig===undefined)return genericDoctorBoundary(ref);
 const c=readBoundaryRef(nativeOrdinaryConfig);
 check(c?.format==='xdev-local-mcp-1'&&c.memory_bridge?.node?.path===process.execPath,'NATIVE_ORDINARY_CONFIG');
 const selected=selectBoundaryData(c);
 check(selected&&nativeOrdinaryAllowed(c,selected.boundary.sdk_build_id)&&canonical(selected.ref)===canonical(ref),'NATIVE_ORDINARY_BOUNDARY');
 return selected.data;
}
export function boundaryHealth(ref:BoundaryRef,deadline:number,node=process.execPath,payload=16384,nativeOrdinaryConfig?:BoundaryRef){
 const {boundary:b}=doctorBoundary(ref,nativeOrdinaryConfig);
 check(sha(leaf(node,128*1024*1024))==='5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5','NODE_PIN');
 const options=boundaryOptions(b,deadline,payload),child=fileURLToPath(import.meta.url);
 const format=nativeOrdinaryConfig?'xdev-boundary-doctor-native-ordinary-1':'xdev-boundary-doctor-1';
 const out=spawnSync(node,['--experimental-strip-types',child],{input:Buffer.from(JSON.stringify({format,boundary:ref,options,...(nativeOrdinaryConfig?{config:nativeOrdinaryConfig}:{})}),'utf8'),encoding:'buffer',windowsHide:true,shell:false,timeout:Math.max(1,deadline-Date.now()),maxBuffer:65536});
 check(!out.error&&!out.signal&&out.status===0&&out.stderr.length<=8192&&Date.now()<deadline,'HEALTH_TRANSPORT');
 const value=parseD1UniqueJson(out.stdout.toString('utf8'));
 doctorBoundary(ref,nativeOrdinaryConfig);
 return checkBoundaryHealth(b,value,payload);
}
/** Unique approved v4 selection; invalid approved sources never disappear during filtering. */
function selectBoundaryData(c:any) {
 const matches:{ref:BoundaryRef;request:any}[]=[];for(const approved of c.approved_requests??[]){check(boundaryWithin(c.input_root,approved.path),'INPUT_ROOT');const r=readBoundaryRef(approved);if(r.format==='xdev-supervised-request-4'&&r.memory_boundary!==null){check(boundaryWithin(c.input_root,r.memory_boundary?.path),'INPUT_ROOT');matches.push({ref:r.memory_boundary,request:r});}}
 check(matches.length<=1,'AMBIGUOUS_APPROVAL');if(!matches.length){check(c.memory_bridge?.storage_root!==join(c.project_root,'.xmem'),'APPROVAL_REQUIRED');return null;}
 const selected=matches[0]!,data=validatedBoundaryData(selected.ref,{projectRoot:c.project_root,projectId:c.project_id,controlRoot:c.control_root}),b=data.boundary,m=c.memory_bridge;
 if(m)check(b.project_id===m.project_id&&b.workspace_id===m.workspace_id&&b.storage_root===m.storage_root&&b.location_hash===m.location_hash&&b.policy_hash===m.policy_hash&&canonical(b.deployment)===canonical(m.deployment),'CONFIG_BINDING');
 return{...selected,boundary:b,data};
}
export function selectMemoryBoundary(c:any):{ref:BoundaryRef;boundary:Boundary;request:any}|null {const selected=selectBoundaryData(c);return selected?{ref:selected.ref,boundary:selected.boundary,request:selected.request}:null;}
/** Fresh deployment bytes were checked by this same synchronous selection. */
export function selectMemoryBoundaryWithDeployment(c:any,includeManifest=false){
 const selected=selectBoundaryData(c);
 return selected?{ref:selected.ref,boundary:selected.boundary,request:selected.request,
  deployment:selected.data.deployment,manifest:includeManifest?composeBoundaryManifest(selected.data):null}:null;
}
/** Late phase entry: reread every approved request, validate once, immediately
 * compose, then discard all private phase data before returning the manifest. */
export function selectMemoryBoundaryManifest(c:any){const selected=selectBoundaryData(c);return selected?composeBoundaryManifest(selected.data):null;}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{check(process.argv.length===2&&process.versions.node==='24.20.0','EXACT_NODE');const buf=Buffer.alloc(16385);let used=0,n=0;while(used<buf.length&&(n=readSync(0,buf,used,buf.length-used,null))>0)used+=n;check(used<buf.length,'INPUT_BOUND');const input=parseD1UniqueJson(buf.subarray(0,used).toString('utf8')) as any;const nativeOrdinary=input.format==='xdev-boundary-doctor-native-ordinary-1';check(nativeOrdinary||input.format==='xdev-boundary-doctor-1','CHILD_FORMAT');exact(input,['format','boundary','options',...(nativeOrdinary?['config']:[])]);const {boundary:b,deployment:inv}=doctorBoundary(input.boundary,nativeOrdinary?input.config:undefined),expected=boundaryOptions(b,input.options.deadline_unix_ms,input.options.payload_budget_bytes);check(canonical(input.options)===canonical(expected),'OPTIONS');const sdk=await import(pathToFileURL(join(inv.runtime_root,'dist/src/index.js')).href);const value=sdk.doctorProject(b.project_root,expected);doctorBoundary(input.boundary,nativeOrdinary?input.config:undefined);check(Date.now()<expected.deadline_unix_ms,'DEADLINE');process.stdout.write(JSON.stringify(value)+'\n');}catch{process.exitCode=1;}
}
