import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createUnboundServer } from './unbound.ts';
try {
  const args=process.argv.slice(2);
  let server;
  if(args.length===0)server=createUnboundServer();
  else {
    if(!(args.length===2&&args[0]==='--config'))throw Error('Usage: server.ts [--config ABS_LOCAL_CONFIG]');
    // Explicit bad configuration is an error, never a fallback to UNBOUND.
    // Bound modules are not even loaded during an unbound installation.
    const {loadConfig}=await import('./configure.ts');const local=loadConfig(args[1]!);
    const {createXdevServer}=await import('./tools.ts');server=createXdevServer(local);
  }
  await server.connect(new StdioServerTransport());
  // No cancellation/reset handler: a disconnect is not proof that a QA child
  // stopped. Core durable QA/start claims survive process loss and deny reuse.
} catch(e){process.stderr.write('XDev MCP: '+(e instanceof Error?e.message:String(e))+'\n');process.exitCode=1;}
