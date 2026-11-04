import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RELEASE } from './release.ts';

// Installation has no implicit project, config, filesystem state or execution grant.
// This module intentionally imports no Core/configuration/filesystem modules.
export function createUnboundServer() {
  const server=new McpServer({name:'xdev-local',version:RELEASE.adapter_version},{maxToolInputElements:4096});
  server.registerTool('xdev_context',{
    description:'Show UNBOUND installation state. No project tools or execution permission; bind a real project locally before project work.',
    inputSchema:z.object({}).strict(),
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },async()=>{
    const value={format:'xdev-local-mcp-context-1',release:RELEASE,status:'UNBOUND',binding_status:'UNBOUND',binding_required:true,
      project_id:null,project_root:null,control_root:null,input_root:null,config:null,
      permissions:{stage_inputs:false,write_jobs:false,execute_qa:false},approved_requests:[],
      task_ready:false,execution_allowed:false,job_created:false,role_dispatch_supported:false,native_identity_authenticated:false,
      available_tools:['xdev_context'],host_acceptance:'NOT_ESTABLISHED_BY_MCP_PROTOCOL',
      next_step:'Provide the actual task and existing project directory. The local coordinator runs mcp/local.ts init with a new data directory, then mcp/configure.ts --config ABS_LOCAL_CONFIG --host HOST; update the host registration and reload/restart. No remote bind or approval tool is available.'};
    return {content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value};
  });
  return server;
}
