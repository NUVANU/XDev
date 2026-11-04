import { canonical } from '../src/job-runtime/storage-identity.ts';

// Only errors created here can supply numeric preflight diagnostics. Messages
// and lookalike properties on arbitrary exceptions are not evidence of a size.
const kinds=new Set(['PROJECT_ID','PATH','REQUEST','ENTRY','MANIFEST','SOURCE_PATH','CONTRACT','JOB','RECORD','RECOVERY_REQUEST']);
type Measurement={code:string;encoded_bytes:number;limit_bytes:number;excess_bytes:number};
const measurements=new WeakMap<object,Readonly<Measurement>>();

export function capacity(value:unknown,limit:number,kind:string):void {
  const encoded_bytes=Buffer.byteLength(canonical(value),'utf8')+1;
  if(encoded_bytes<=limit)return;
  const code='MCP_CAPACITY_UNSUPPORTED:'+kind,error=Error(code),excess_bytes=encoded_bytes-limit;
  if(kinds.has(kind)&&[encoded_bytes,limit,excess_bytes].every(Number.isSafeInteger)&&limit>=0&&excess_bytes>0)
    measurements.set(error,Object.freeze({code,encoded_bytes,limit_bytes:limit,excess_bytes}));
  throw error;
}

export function capacityActual(error:unknown,code:string):string|undefined {
  if(error===null||typeof error!=='object')return undefined;
  const measured=measurements.get(error);
  if(!measured||measured.code!==code)return undefined;
  return 'metric=canonical_utf8_plus_lf; encoded_bytes='+measured.encoded_bytes+'; limit_bytes='+measured.limit_bytes+'; excess_bytes='+measured.excess_bytes;
}
