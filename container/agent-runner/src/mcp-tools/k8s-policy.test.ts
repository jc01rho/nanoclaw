import { describe, it, expect } from 'bun:test';
import {
  isReadOnlyOperation,
  isValidPodName,
  validateSafeRestartPodRequest,
  validateNamespace,
  validatePodRestart,
  type PodInfo,
  type PolicyOptions,
} from './k8s-policy';

describe('k8s-policy', () => {
  describe('isReadOnlyOperation', () => {
    it('should allow read-only verbs and resources', () => {
      expect(isReadOnlyOperation('get', 'pods').ok).toBe(true);
      expect(isReadOnlyOperation('list', 'services').ok).toBe(true);
      expect(isReadOnlyOperation('watch', 'deployments').ok).toBe(true);
      expect(isReadOnlyOperation('describe', 'replicasets').ok).toBe(true);
      expect(isReadOnlyOperation('logs', 'pods').ok).toBe(true);
    });

    it('should deny non-read-only verbs', () => {
      expect(isReadOnlyOperation('delete', 'pods').ok).toBe(false);
      expect(isReadOnlyOperation('patch', 'pods').ok).toBe(false);
      expect(isReadOnlyOperation('update', 'pods').ok).toBe(false);
    });

    it('should deny restricted resources', () => {
      expect(isReadOnlyOperation('get', 'secrets').ok).toBe(false);
      expect(isReadOnlyOperation('list', 'configmaps').ok).toBe(false);
      expect(isReadOnlyOperation('get', 'nodes').ok).toBe(false);
      expect(isReadOnlyOperation('list', 'namespaces').ok).toBe(false);
    });

    it('should allow pod logs and events but no writes', () => {
      expect(isReadOnlyOperation('logs', 'pods').ok).toBe(true);
      expect(isReadOnlyOperation('get', 'pods/log').ok).toBe(true);
      expect(isReadOnlyOperation('watch', 'events').ok).toBe(true);
      expect(isReadOnlyOperation('delete', 'pods').ok).toBe(false);
    });
  });

  describe('isValidPodName', () => {
    it('should allow valid pod names', () => {
      expect(isValidPodName('my-pod')).toBe(true);
      expect(isValidPodName('pod123')).toBe(true);
      expect(isValidPodName('a-b-c')).toBe(true);
    });

    it('should deny invalid pod names', () => {
      expect(isValidPodName('-mypod')).toBe(false);
      expect(isValidPodName('mypod-')).toBe(false);
      expect(isValidPodName('MyPod')).toBe(false); // lowercase only
      expect(isValidPodName('pod_name')).toBe(false); // no underscores
      expect(isValidPodName('pod name')).toBe(false); // no spaces
      expect(isValidPodName('pod/name')).toBe(false);
      expect(isValidPodName('pod;rm')).toBe(false);
    });
  });

  describe('validateNamespace', () => {
    const options: PolicyOptions = {
      allowedNamespaces: ['default', 'app-ns'],
      deniedNamespaces: ['forbidden-ns'],
    };

    it('should allow allowed namespaces', () => {
      expect(validateNamespace('default', options).ok).toBe(true);
      expect(validateNamespace('app-ns', options).ok).toBe(true);
    });

    it('should deny denied namespaces', () => {
      expect(validateNamespace('forbidden-ns', options).ok).toBe(false);
    });

    it('should deny namespaces not in allowed list', () => {
      expect(validateNamespace('other-ns', options).ok).toBe(false);
    });

    it('should deny system namespaces by default', () => {
      expect(validateNamespace('kube-system', options).ok).toBe(false);
      expect(validateNamespace('kube-public', options).ok).toBe(false);
    });

    it('should deny system namespaces even if explicitly in allowed list', () => {
      const customOptions: PolicyOptions = {
        allowedNamespaces: ['kube-system'],
      };
      expect(validateNamespace('kube-system', customOptions).ok).toBe(false);
    });

    it('should deny invalid namespace names', () => {
      expect(validateNamespace('bad namespace', {}).ok).toBe(false);
      expect(validateNamespace('../default', {}).ok).toBe(false);
    });
  });

  describe('validateSafeRestartPodRequest', () => {
    it('should only accept exact pod and namespace names', () => {
      expect(validateSafeRestartPodRequest({ namespace: 'default', podName: 'app-123' }, {}).ok).toBe(true);
      expect(validateSafeRestartPodRequest({ namespace: 'default', podName: '--all' }, {}).ok).toBe(false);
      expect(validateSafeRestartPodRequest({ namespace: 'default', podName: 'app-123 --force' }, {}).ok).toBe(false);
      expect(validateSafeRestartPodRequest({ namespace: 'kube-system', podName: 'coredns-123' }, {}).ok).toBe(false);
    });
  });

  describe('validatePodRestart', () => {
    const baseOptions: PolicyOptions = {
      allowedNamespaces: ['default', 'app-ns'],
    };

    const validPod: PodInfo = {
      name: 'valid-pod',
      namespace: 'default',
      labels: { 'nanoclaw.io/public-restart-allowed': 'true' },
      ownerReferences: [
        {
          apiVersion: 'v1',
          kind: 'ReplicaSet',
          name: 'my-rs',
          uid: '123',
        },
      ],
    };

    it('should allow valid pod restart', () => {
      expect(validatePodRestart(validPod, baseOptions).ok).toBe(true);
    });

    it('should deny invalid pod names', () => {
      const invalidPod = { ...validPod, name: '-invalid' };
      const result = validatePodRestart(invalidPod, baseOptions);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('Invalid pod name');
    });

    it('should deny invalid namespaces', () => {
      const invalidNsPod = { ...validPod, namespace: 'kube-system' };
      const result = validatePodRestart(invalidNsPod, baseOptions);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('System namespace');
    });

    it('should deny pod without restart-allowed label', () => {
      const noLabelPod: PodInfo = {
        ...validPod,
        labels: {},
      };
      const result = validatePodRestart(noLabelPod, baseOptions);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('missing required label');
    });

    it('should deny ownerless pods', () => {
      const ownerlessPod: PodInfo = {
        ...validPod,
        ownerReferences: [],
      };
      const result = validatePodRestart(ownerlessPod, baseOptions);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('must have ownerReferences');
    });

    it('should deny StatefulSet unless explicitly allowed', () => {
      const ssPod: PodInfo = {
        ...validPod,
        ownerReferences: [
          {
            apiVersion: 'apps/v1',
            kind: 'StatefulSet',
            name: 'my-ss',
            uid: '456',
          },
        ],
      };
      const result = validatePodRestart(ssPod, baseOptions);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('not allowed for safe restart');

      const allowedSsOptions: PolicyOptions = {
        ...baseOptions,
        allowStatefulSetRestart: true,
      };
      expect(validatePodRestart(ssPod, allowedSsOptions).ok).toBe(true);
    });

    it('should allow ReplicaSet-owned pods', () => {
      expect(validatePodRestart(validPod, baseOptions).ok).toBe(true);
    });

    it('should allow Deployment-owned pods', () => {
      const deployPod: PodInfo = {
        ...validPod,
        ownerReferences: [
          {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            name: 'my-deploy',
            uid: '789',
          },
        ],
      };
      expect(validatePodRestart(deployPod, baseOptions).ok).toBe(true);
    });

    it('should deny Job-owned pods by default', () => {
      const jobPod: PodInfo = {
        ...validPod,
        ownerReferences: [
          {
            apiVersion: 'batch/v1',
            kind: 'Job',
            name: 'db-migration',
            uid: 'job-1',
          },
        ],
      };
      expect(validatePodRestart(jobPod, baseOptions).ok).toBe(false);
    });
  });
});
