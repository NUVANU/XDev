import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, parse, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytes, loadConfig, need, noLinks, within } from './configure.ts';
import type { LocalConfig } from './configure.ts';

// Local setup only: never creates a Job, approves a request, registers a host,
// writes project files, or removes/repairs an existing data directory.
const USAGE='node --experimental-strip-types mcp/local.ts init --project-root ABS_EXISTING_PROJECT --data-root ABS_NEW_DATA --project-id ID [--stage-inputs]';
function present(path:string) {try{lstatSync(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
function localPath(path:string) {
  // Init supports ordinary DOS drive paths only, never device/UNC/extended namespaces.
  if(process.platform==='win32')need(/^[A-Za-z]:\\/.test(path),'LOCAL_SETUP_WINDOWS_NAMESPACE_UNSUPPORTED');
  noLinks(path);
  if(process.platform==='win32')for(const part of path.slice(parse(path).root.length).split(/[\\/]/))
    need(part.length>0&&part.length<=255&&!/[<>:"|?*\x00-\x1f]/.test(part)&&!/[ .]$/.test(part)&&!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),'LOCAL_SETUP_WINDOWS_PATH_INVALID');
}
// Canonical names alone need not be unique. Bind each existing directory to
// its native resolved name AND a stable, nonzero physical file identity.
function directoryBinding(path:string) {
  const before=lstatSync(path,{bigint:true});need(before.isDirectory()&&before.ino>0n,'LOCAL_SETUP_PHYSICAL_IDENTITY_UNPROVEN');
  const physical=realpathSync.native(path);localPath(physical);
  const target=lstatSync(physical,{bigint:true}),after=lstatSync(path,{bigint:true});
  need(target.isDirectory()&&after.isDirectory()&&before.dev===target.dev&&before.ino===target.ino&&before.dev===after.dev&&before.ino===after.ino,'LOCAL_SETUP_PHYSICAL_IDENTITY_UNPROVEN');
  return {path:physical,dev:before.dev,ino:before.ino};
}
const sameNativeName=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
export function runLocalSetup(args:string[]) {
  const created:string[]=[];let mutationAttempted=false,dataRoot:string|null=null;
  try {
    need(args[0]==='init','LOCAL_SETUP_USAGE:'+USAGE);
    const values=new Map<string,string>();let stageInputs=false;
    for(let i=1;i<args.length;i++) {
      const key=args[i]!;
      if(key==='--stage-inputs'){need(!stageInputs,'LOCAL_SETUP_DUPLICATE_PARAMETER');stageInputs=true;continue;}
      need(['--project-root','--data-root','--project-id'].includes(key),'LOCAL_SETUP_UNKNOWN_PARAMETER');
      need(!values.has(key),'LOCAL_SETUP_DUPLICATE_PARAMETER');const value=args[++i];
      need(typeof value==='string'&&value.length>0&&!value.startsWith('--'),'LOCAL_SETUP_PARAMETER_VALUE_REQUIRED');values.set(key,value);
    }
    need(values.size===3,'LOCAL_SETUP_USAGE:'+USAGE);
    const projectRoot=values.get('--project-root')!,projectId=values.get('--project-id')!;dataRoot=values.get('--data-root')!;
    need(projectId.trim().length>0&&projectId.length<256,'LOCAL_SETUP_PROJECT_ID_INVALID');
    localPath(projectRoot);localPath(dataRoot);need(present(projectRoot)&&lstatSync(projectRoot).isDirectory(),'LOCAL_SETUP_EXISTING_PROJECT_DIRECTORY_REQUIRED');
    need(!within(projectRoot,dataRoot)&&!within(dataRoot,projectRoot),'LOCAL_SETUP_PROJECT_DATA_OVERLAP');
    need(!present(dataRoot),'LOCAL_SETUP_DATA_ALREADY_EXISTS');
    const parent=dirname(dataRoot);localPath(parent);need(present(parent)&&lstatSync(parent).isDirectory(),'LOCAL_SETUP_EXISTING_DATA_PARENT_REQUIRED');
    const projectBinding=directoryBinding(projectRoot),parentBinding=directoryBinding(parent),physicalData=join(parentBinding.path,basename(dataRoot));
    need(!within(projectBinding.path,physicalData)&&!within(physicalData,projectBinding.path)&&!(projectBinding.dev===parentBinding.dev&&projectBinding.ino===parentBinding.ino),'LOCAL_SETUP_PROJECT_DATA_PHYSICAL_OVERLAP');
    need(!present(physicalData),'LOCAL_SETUP_DATA_ALREADY_EXISTS');
    // Fail closed on alternate names (including resolved short/SUBST names).
    // Never grant the original lexical config an unverified physical binding.
    need(sameNativeName(projectRoot,projectBinding.path)&&sameNativeName(parent,parentBinding.path),'LOCAL_SETUP_PHYSICAL_PATH_ALIAS_UNSUPPORTED');
    const server=fileURLToPath(new URL('./server.ts',import.meta.url));bytes(server);noLinks(process.execPath);need(lstatSync(process.execPath).isFile(),'LOCAL_SETUP_NODE_EXECUTABLE_MISSING');
    const control=join(dataRoot,'control'),input=join(dataRoot,'input'),configPath=join(dataRoot,'local-config.json');
    const config:LocalConfig={format:'xdev-local-mcp-1',project_id:projectId,project_root:projectRoot,control_root:control,input_root:input,
      permissions:{stage_inputs:stageInputs,write_jobs:false,execute_qa:false},approved_requests:[]};
    // All predictable path/argument/binding checks precede this first mutation.
    // A later failure leaves observed artifacts intact and reports uncertainty.
    mutationAttempted=true;mkdirSync(dataRoot,{mode:0o700});created.push(dataRoot);
    mkdirSync(control,{mode:0o700});created.push(control);mkdirSync(input,{mode:0o700});created.push(input);
    const fd=openSync(configPath,'wx',0o600);created.push(configPath);
    try{writeFileSync(fd,JSON.stringify(config,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
    const local=loadConfig(configPath),stdio={command:process.execPath,args:['--experimental-strip-types',server,'--config',configPath]};
    return {exit_code:0,result:{format:'xdev-local-setup-result-1',status:'CONFIGURED',project_id:projectId,project_root:projectRoot,data_root:dataRoot,
      config:{path:configPath,sha256:local.configHash},permissions:local.config.permissions,approved_requests_count:0,stdio,
      codex_registration:{argv:['codex','mcp','add','xdev','--',stdio.command,...stdio.args],executed:false},created_paths:created,
      task_ready:false,execution_allowed:false,job_created:false,host_registered:false,configuration_only:true}};
  } catch(error) {
    return {exit_code:1,result:{format:'xdev-local-setup-result-1',status:mutationAttempted?'PARTIAL_OR_UNKNOWN':'REFUSED',
      code:error instanceof Error?error.message:String(error),data_root:dataRoot,created_paths:created,may_have_side_effects:mutationAttempted,
      operation_completion:mutationAttempted?'UNKNOWN':'NOT_STARTED',cleanup_performed:false,project_written:false,
      task_ready:false,execution_allowed:false,job_created:false,host_registered:false}};
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const outcome=runLocalSetup(process.argv.slice(2));const output=JSON.stringify(outcome.result)+'\n';
  if(outcome.exit_code===0)process.stdout.write(output);else process.stderr.write(output);
  process.exitCode=outcome.exit_code;
}
