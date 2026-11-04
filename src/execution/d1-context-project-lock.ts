import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, rmdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

function check(value:unknown,code:string):asserts value {if(!value)throw Error(code);}

/** Serializes a new D1 context binding with the first role REGISTER. It is
 * deliberately separate from the post-registration resource→Job send locks. */
export class D1ContextProjectLock {
  readonly controlRoot:string;readonly projectId:string;readonly path:string;
  private held=false;
  constructor(controlRoot:string,projectId:string){
    check(isAbsolute(controlRoot)&&resolve(controlRoot)===controlRoot&&
      existsSync(controlRoot)&&lstatSync(controlRoot).isDirectory()&&
      !lstatSync(controlRoot).isSymbolicLink()&&projectId.trim().length>0,
      'D1_CONTEXT_LOCK_SCOPE');
    this.controlRoot=controlRoot;this.projectId=projectId;
    this.path=join(controlRoot,'d1-context-bind-'+createHash('sha256').update(projectId).digest('hex')+'.lock');
  }
  assertHeld(controlRoot:string,projectId:string){
    check(this.held&&this.controlRoot===controlRoot&&this.projectId===projectId&&
      existsSync(this.path)&&lstatSync(this.path).isDirectory()&&
      !lstatSync(this.path).isSymbolicLink(),'D1_CONTEXT_LOCK_REQUIRED');
  }
  withLock<T>(fn:()=>T):T{
    check(!this.held,'D1_CONTEXT_LOCK_REENTRY');const deadline=Date.now()+5000;
    while(true){
      try{mkdirSync(this.path,{mode:0o700});break;}
      catch(error){
        if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
        check(!lstatSync(this.path).isSymbolicLink()&&lstatSync(this.path).isDirectory(),
          'D1_CONTEXT_LOCK_INVALID');
        check(Date.now()<deadline,'D1_CONTEXT_LOCK_BUSY_OR_UNKNOWN');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      }
    }
    const stat=lstatSync(this.path),identity=`${stat.dev}:${stat.ino}`;
    try{this.held=true;return fn();}
    finally{
      this.held=false;const end=lstatSync(this.path);
      check(end.isDirectory()&&`${end.dev}:${end.ino}`===identity,'D1_CONTEXT_LOCK_OWNERSHIP_LOST');
      rmdirSync(this.path);
    }
  }
}
