import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../src/job-runtime/store.ts';
import { bytes, hash, noLinks } from './configure.ts';
import type { FileRef } from './configure.ts';
import { memoryCheck, memoryJson } from './xmem-client.ts';

export type MemoryIntent={format:'xdev-memory-operation-1';id:string;kind:'capture'|'checkpoint';scope_sha256:string;source:FileRef;content_sha256:string;memory_key:string|null};
export type MemoryConfirmation={format:'xdev-memory-confirmation-1';intent_sha256:string;revision_id:string|null;record_id:string|null;source_id:string|null;package_id:string|null;payload_sha256:string;source_content_sha256:string};
function paths(control:string,id:string) {memoryCheck(/^[a-f0-9]{64}$/.test(id),'MEMORY_OPERATION_ID_INVALID');noLinks(control);const root=join(control,'xmem-operations');noLinks(root);return{root,intent:join(root,id+'.json'),confirmation:join(root,id+'-confirmation.json')};}
function immutable(file:string,text:string) {
  noLinks(file);const fd=openSync(file,'wx',0o600);try{writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}
}
/** Only commitments and receipt identifiers: no memory body or execution/Job state. */
export function beginMemoryOperation(control:string,intent:MemoryIntent):{created:boolean;intent_sha256:string;confirmation:MemoryConfirmation|null} {
  const p=paths(control,intent.id),text=canonical(intent)+'\n',digest=hash(text);
  memoryCheck(Buffer.byteLength(text)<=8192,'MEMORY_OPERATION_BOUND');
  if(!existsSync(p.root)){try{mkdirSync(p.root,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}noLinks(p.root);}
  let created=false;
  try{immutable(p.intent,text);created=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;memoryCheck(bytes(p.intent,8192).equals(Buffer.from(text)),'MEMORY_EVENT_CONTENT_OR_SCOPE_CONFLICT');}
  let confirmation:MemoryConfirmation|null=null;
  if(existsSync(p.confirmation)){confirmation=memoryJson(bytes(p.confirmation,4096).toString('utf8'));memoryCheck(confirmation?.format==='xdev-memory-confirmation-1'&&confirmation.intent_sha256===digest&&confirmation.source_content_sha256===intent.content_sha256,'MEMORY_CONFIRMATION_DRIFT');}
  return{created,intent_sha256:digest,confirmation};
}
export function inspectMemoryOperation(control:string,intent:MemoryIntent) {
  const p=paths(control,intent.id);memoryCheck(existsSync(p.intent),'MEMORY_OPERATION_NOT_STARTED');const text=canonical(intent)+'\n';
  memoryCheck(bytes(p.intent,8192).equals(Buffer.from(text)),'MEMORY_EVENT_CONTENT_OR_SCOPE_CONFLICT');
  const confirmation=existsSync(p.confirmation)?memoryJson(bytes(p.confirmation,4096).toString('utf8')):null;
  if(confirmation)memoryCheck(confirmation.format==='xdev-memory-confirmation-1'&&confirmation.intent_sha256===hash(text)&&confirmation.source_content_sha256===intent.content_sha256,'MEMORY_CONFIRMATION_DRIFT');
  return{created:false,intent_sha256:hash(text),confirmation:confirmation as MemoryConfirmation|null};
}
function nativeCaptureStart(control:string,intent:MemoryIntent) {
  const {root}=paths(control,intent.id),state=inspectMemoryOperation(control,intent);
  const file=join(root,intent.id+'-native-capture-start.json');
  const text=canonical({format:'xdev-native-engineering-capture-start-1',intent_sha256:state.intent_sha256})+'\n';
  return{state,file,text};
}
/** A partial file also consumes the only native capture start. */
export function reserveNativeCaptureStart(control:string,intent:MemoryIntent) {
  const {state,file,text}=nativeCaptureStart(control,intent);
  memoryCheck(!state.confirmation,'MEMORY_NATIVE_CAPTURE_ALREADY_CONFIRMED');
  try{immutable(file,text);}catch(e){
    if((e as NodeJS.ErrnoException).code==='EEXIST')memoryCheck(false,'MEMORY_NATIVE_CAPTURE_START_CONSUMED');
    throw e;
  }
}
export function requireNativeCaptureStart(control:string,intent:MemoryIntent) {
  const {state,file,text}=nativeCaptureStart(control,intent);
  memoryCheck(existsSync(file)&&bytes(file,4096).equals(Buffer.from(text)),'MEMORY_NATIVE_CAPTURE_START_REQUIRED');
  return state;
}
export function confirmMemoryOperation(control:string,intent:MemoryIntent,value:MemoryConfirmation) {
  const state=inspectMemoryOperation(control,intent),p=paths(control,intent.id);memoryCheck(value.intent_sha256===state.intent_sha256&&value.source_content_sha256===intent.content_sha256,'MEMORY_CONFIRMATION_BINDING');
  if(state.confirmation){for(const key of ['revision_id','record_id','source_id','package_id','source_content_sha256'] as const)memoryCheck(state.confirmation[key]===value[key],'MEMORY_CONFIRMATION_CONFLICT');return state.confirmation;}
  const text=canonical(value)+'\n';try{immutable(p.confirmation,text);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;memoryCheck(bytes(p.confirmation,4096).equals(Buffer.from(text)),'MEMORY_CONFIRMATION_CONFLICT');}return value;
}
