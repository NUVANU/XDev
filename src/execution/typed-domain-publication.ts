/** Typed dispatcher only. Reserve-only validators and acknowledgement keep their meaning. */
import {inspectDomainCompositionPublication,read,type DomainPins} from './domain-composition.ts';
import {inspectExecutionDomainPublication} from './execution-domain.ts';
export async function inspectTypedDomainPublication(pins:DomainPins){
 const c=read(pins.composition_ref);
 if(c?.format==='xdev-execution-domain-composition-1')return inspectExecutionDomainPublication(pins);
 return inspectDomainCompositionPublication(pins);
}
