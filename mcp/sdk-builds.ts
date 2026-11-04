/** Closed SDK byte identities and response contracts. An entry is not formal
 * qualification; callers must retain the matching actual quality evidence. */
export const LEGACY_RELATED_BUILD='0dba41f04f7c5b9fe4f47b5525d21fe082f0695d3be7406ab7a3e80739e8b98c';
export const BETA04_BUILD='54e0a021eb8947ba4e656f98b9503921740d272a52bb498416f9a665679b286a';
export const SOURCE02_BUILD='a4a3e1d98344a3afe75183a3bd075c2c7da6399ed6c10267941146c1ffd9aab2';
export { PHYSICAL_BUILD, UNIFIED_BUILD, COMMUNITY_XMEM_BUILD, isUnifiedBuild, E7_NATIVE_BUILD } from '../src/host-surface/project-memory-boundary.ts';
import { PHYSICAL_BUILD, UNIFIED_BUILD, COMMUNITY_XMEM_BUILD, isUnifiedBuild, E7_NATIVE_BUILD } from '../src/host-surface/project-memory-boundary.ts';
import type { FileRef, LocalConfig } from './configure.ts';
export const E7_NODE_SHA256='5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5';
export const SDK_MEMBERS=Object.freeze({[BETA04_BUILD]:{js:36,runtime:38},[SOURCE02_BUILD]:{js:36,runtime:38},[PHYSICAL_BUILD]:{js:37,runtime:39,physical:'PHYSICAL_CLOSED_V1'},[UNIFIED_BUILD]:{js:46,runtime:48,physical:'PHYSICAL_CLOSED_V1'},[COMMUNITY_XMEM_BUILD]:{js:46,runtime:48,physical:'PHYSICAL_CLOSED_V1'},[E7_NATIVE_BUILD]:{js:47,runtime:50,physical:'PHYSICAL_CLOSED_V1'}});
export const ENGINEERING_CONTRACTS:Readonly<Record<string,'xmem-engineering/1'|'xmem-engineering/2'>>=Object.freeze({[BETA04_BUILD]:'xmem-engineering/1',[SOURCE02_BUILD]:'xmem-engineering/2',[PHYSICAL_BUILD]:'xmem-engineering/2',[UNIFIED_BUILD]:'xmem-engineering/2',[COMMUNITY_XMEM_BUILD]:'xmem-engineering/2',[E7_NATIVE_BUILD]:'xmem-engineering/2'});
export const RELATED_BUILDS:readonly string[]=Object.freeze([LEGACY_RELATED_BUILD,BETA04_BUILD,SOURCE02_BUILD,PHYSICAL_BUILD,UNIFIED_BUILD,COMMUNITY_XMEM_BUILD,E7_NATIVE_BUILD]);
export const sdkCompanionContract=(build:string)=>isUnifiedBuild(build)||build===E7_NATIVE_BUILD?'xmem-companion/3':'xmem-companion/2';
export const sdkOrdinaryToolCount=(build:string)=>isUnifiedBuild(build)||build===E7_NATIVE_BUILD?9:7;

export { nativeOrdinaryAllowed } from '../src/host-surface/project-memory-boundary.ts';

/** Exact joint opt-in. The shared permission flags authorize engineering only
 * for this build. Ordinary entry points refuse the build separately. */
export function nativeJointQuery(c:LocalConfig):FileRef|null {
 const m=c.memory_bridge,e=m?.engineering,r=m?.related;
 if(!m||e?.enabled!==true||e.build_id!==E7_NATIVE_BUILD||r?.enabled!==true||r.build_id!==E7_NATIVE_BUILD)return null;
 const permissions=m.permissions;
 if(!m.required_context||m.current_facts!==undefined||m.dependencies!==undefined||m.node.sha256!==E7_NODE_SHA256||
    !permissions.recall||!permissions.capture||!permissions.reconcile||permissions.checkpoint)return null;
 const [request]=c.approved_requests??[];
 if(c.approved_requests?.length!==1||request?.path!==e.request.path||request.sha256!==e.request.sha256)return null;
 if(r.deployment.path!==m.deployment.path||r.deployment.sha256!==m.deployment.sha256||r.approved_queries.length!==1)return null;
 return r.approved_queries[0]!;
}
