export type K8sResource =
  | 'pods'
  | 'pods/log'
  | 'events'
  | 'services'
  | 'deployments'
  | 'replicasets'
  | 'statefulsets'
  | 'ingresses'
  | 'daemonsets'
  | 'cronjobs'
  | 'secrets'
  | 'configmaps'
  | 'nodes'
  | 'namespaces'
  | 'persistentvolumeclaims'
  | 'persistentvolumes'
  | 'endpoints';

export type K8sVerb = 'get' | 'list' | 'watch' | 'describe' | 'logs' | 'delete' | 'patch' | 'update';

export interface OwnerReference {
  apiVersion: string;
  kind: 'ReplicaSet' | 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job';
  name: string;
  uid: string;
}

export interface PodInfo {
  name: string;
  namespace: string;
  labels: Record<string, string>;
  ownerReferences?: OwnerReference[];
}

export interface PolicyOptions {
  allowedNamespaces?: string[];
  deniedNamespaces?: string[];
  allowStatefulSetRestart?: boolean;
}

export interface SafeRestartPodRequest {
  namespace: string;
  podName: string;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export function isReadOnlyOperation(verb: string, resource: string): ValidationResult {
  const normalizedVerb = verb.toLowerCase();
  const normalizedResource = resource.toLowerCase();
  const readOnlyVerbs: Set<string> = new Set(['get', 'list', 'watch', 'describe', 'logs']);
  const allowedResources: Set<string> = new Set([
    'pods',
    'pods/log',
    'events',
    'services',
    'deployments',
    'replicasets',
    'statefulsets',
    'ingresses',
    'daemonsets',
    'cronjobs',
  ]);

  if (!readOnlyVerbs.has(normalizedVerb)) {
    return { ok: false, reason: `Verb '${verb}' is not allowed for read-only operations.` };
  }

  if (!allowedResources.has(normalizedResource)) {
    return { ok: false, reason: `Resource '${resource}' is restricted for public guests.` };
  }

  return { ok: true };
}

export function isValidK8sName(name: string): boolean {
  return name.length > 0 && name.length <= 253 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name);
}

export const isValidPodName = isValidK8sName;

export function validateNamespace(namespace: string, options: PolicyOptions): ValidationResult {
  if (!isValidK8sName(namespace)) {
    return { ok: false, reason: `Invalid namespace: '${namespace}'` };
  }

  const systemNamespaces = new Set([
    'kube-system',
    'kube-public',
    'kube-node-lease',
    'cert-manager',
    'ingress-nginx',
    'monitoring',
  ]);
  if (systemNamespaces.has(namespace)) {
    return { ok: false, reason: `System namespace '${namespace}' is denied.` };
  }

  if (options.deniedNamespaces?.includes(namespace)) {
    return { ok: false, reason: `Namespace '${namespace}' is explicitly denied.` };
  }

  if (options.allowedNamespaces && !options.allowedNamespaces.includes(namespace)) {
    return { ok: false, reason: `Namespace '${namespace}' is not in the allowed list.` };
  }

  return { ok: true };
}

export function validateSafeRestartPodRequest(
  request: SafeRestartPodRequest,
  options: PolicyOptions,
): ValidationResult {
  if (!isValidPodName(request.podName)) {
    return { ok: false, reason: `Invalid pod name: '${request.podName}'` };
  }
  return validateNamespace(request.namespace, options);
}

export function validatePodRestart(pod: PodInfo, options: PolicyOptions): ValidationResult {
  const requestResult = validateSafeRestartPodRequest({ namespace: pod.namespace, podName: pod.name }, options);
  if (!requestResult.ok) return requestResult;

  if (pod.labels['nanoclaw.io/public-restart-allowed'] !== 'true') {
    return { ok: false, reason: 'Pod is missing required label: nanoclaw.io/public-restart-allowed=true' };
  }

  if (!pod.ownerReferences || pod.ownerReferences.length === 0) {
    return { ok: false, reason: 'Pod must have ownerReferences to be safely restarted.' };
  }

  const hasValidOwner = pod.ownerReferences.some((owner) => {
    if (owner.kind === 'StatefulSet') {
      return options.allowStatefulSetRestart === true;
    }
    return ['ReplicaSet', 'Deployment', 'DaemonSet'].includes(owner.kind);
  });

  if (!hasValidOwner) {
    const ownerKinds = pod.ownerReferences.map((o) => o.kind).join(', ');
    return { ok: false, reason: `Pod owner kind(s) [${ownerKinds}] are not allowed for safe restart.` };
  }

  return { ok: true };
}
