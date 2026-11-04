import type {Action} from './admission.ts';
/** Minimal structural projection. Future controllers may pass their larger
 * intent, but budget contracts must not import controller lifecycle types. */
export type BudgetIntent={action:Action;action_sha256:string;phase:string;reservation_ref:string|null};
export type ReservationReceipt={reservation_ref:string;source_revision:string;source_digest:string;committed_revision:string;committed_digest:string};
export type PreparedResourceObservation={action_sha256:string;state:'NONE'|'HELD'|'UNKNOWN';reservation_ref:string|null;source_revision:string;source_digest:string;evidence_ref:string;pending_operations:boolean};
export type BudgetDomain='RESERVE_ONLY_CONTROL'|'EXECUTION';
