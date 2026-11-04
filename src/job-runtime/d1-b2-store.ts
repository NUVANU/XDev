import { projectRootIdentity } from '../project-model/init-receipt.ts';
import { performB2Local, queryB2, performB2RoleSource } from './d1-b2-storage.ts';
import type { GrantLocator } from '../host-surface/d1-b2-native-port.ts';
import { b2Need as need } from './d1-b2-contracts.ts';

/** Public native Store: callers supply locators, never trusted replay/authority objects. */
export class B2Store {
  readonly root: string;
  constructor(root: string) { need(arguments.length === 1, 'STORE_OPTIONS_UNSUPPORTED'); this.root = projectRootIdentity(root).root; }
  initialize(sourceRef: string) { need(arguments.length === 1, 'STORE_OPTIONS_UNSUPPORTED'); return performB2Local(this.root, 'init', sourceRef); }
  allocate(sourceRef: string, expectedHead: string) { need(arguments.length === 2, 'STORE_OPTIONS_UNSUPPORTED'); return performB2Local(this.root, 'allocate', sourceRef, expectedHead); }
  create(sourceRef: string, expectedHead: string) { need(arguments.length === 2, 'STORE_OPTIONS_UNSUPPORTED'); return performB2Local(this.root, 'create', sourceRef, expectedHead); }
  query(jobId?: string) { need(arguments.length <= 1, 'STORE_OPTIONS_UNSUPPORTED'); return queryB2(this.root, jobId); }
  private unavailable() { queryB2(this.root); throw Error('B2_HOST_OBSERVER_UNAVAILABLE'); }
  prepareAttempt(_source: string, _head: string) { return this.unavailable(); }
  prepareRole(_source: string, _head: string) { return this.unavailable(); }
  recordReceipt(_source: string, _head: string) { return this.unavailable(); }
  recordTerminal(_source: string, _head: string) { return this.unavailable(); }
  recordQuality(_source: string, _head: string) { return this.unavailable(); }
  closeWriters(_source: string, _head: string) { return this.unavailable(); }
  recordOutcome(_source: string, _head: string) { return this.unavailable(); }
  authorizeRepair(_source: string, _head: string) { return this.unavailable(); }
  requestCancel(_source: string, _head: string) { return this.unavailable(); }
  recordCancel(_source: string, _head: string) { return this.unavailable(); }
  reconcile(_source: string, _head: string) { return this.unavailable(); }
  settle(_source: string, _head: string) { return this.unavailable(); }
  roleQualityInitialize(sourcePath: string) {
    need(arguments.length === 1, 'STORE_OPTIONS_UNSUPPORTED'); return performB2RoleSource(this.root, 'init', [sourcePath]);
  }
  roleQualityCreate(sourcePath: string, expectedHead: string) {
    need(arguments.length === 2, 'STORE_OPTIONS_UNSUPPORTED'); return performB2RoleSource(this.root, 'create', [sourcePath, expectedHead]);
  }
  roleQualityPrepare(jobId: string, operationId: string, grantLocator: GrantLocator, expectedProjectHead: string, expectedJobHead: string) {
    need(arguments.length === 5, 'STORE_OPTIONS_UNSUPPORTED'); return performB2RoleSource(this.root, 'prepare', [jobId, operationId, grantLocator, expectedProjectHead, expectedJobHead]);
  }
  roleQualityObserve(jobId: string, operationId: string, expectedProjectHead: string, expectedJobHead: string) {
    need(arguments.length === 4, 'STORE_OPTIONS_UNSUPPORTED'); return performB2RoleSource(this.root, 'observe', [jobId, operationId, expectedProjectHead, expectedJobHead]);
  }
  roleQualityResult(jobId: string) {
    need(arguments.length === 1, 'STORE_OPTIONS_UNSUPPORTED'); return performB2RoleSource(this.root, 'result', [jobId]);
  }
  roleQualityOutcome(jobId: string, operationId: string, expectedProjectHead: string, expectedJobHead: string) {
    need(arguments.length === 4, 'STORE_OPTIONS_UNSUPPORTED'); return performB2RoleSource(this.root, 'outcome', [jobId, operationId, expectedProjectHead, expectedJobHead]);
  }
  roleQualityCancel(jobId: string, operationId: string, grantLocator: GrantLocator, expectedProjectHead: string, expectedJobHead: string) {
    need(arguments.length === 5, 'STORE_OPTIONS_UNSUPPORTED'); return performB2RoleSource(this.root, 'cancel', [jobId, operationId, grantLocator, expectedProjectHead, expectedJobHead]);
  }
  roleQualityReconcile(jobId: string, operationId: string, grantLocator: GrantLocator, expectedProjectHead: string, expectedJobHead: string) {
    need(arguments.length === 5, 'STORE_OPTIONS_UNSUPPORTED'); return performB2RoleSource(this.root, 'reconcile', [jobId, operationId, grantLocator, expectedProjectHead, expectedJobHead]);
  }
}
