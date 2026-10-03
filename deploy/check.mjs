// Offline invariants, not Kubernetes admission or independent security approval. Never contacts the cluster.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import YAML from 'yaml';

// P2 review regressions: the early PSA proof must not depend on a later-created ServiceAccount,
// and Falco repository filters must tolerate the runtime omitting the registry prefix.
const rootProof = YAML.parse(fs.readFileSync('deploy/k8s/test/root-pod.yaml','utf8'));
assert.equal(rootProof.spec.serviceAccountName,undefined,'step 2 must use the default ServiceAccount');
assert.equal(rootProof.spec.automountServiceAccountToken,false);
const falco = YAML.parse(YAML.parse(fs.readFileSync('deploy/falco/values.yaml','utf8')).customRules['agent-ledger.yaml']);
const processRule = falco.find(rule=>rule.rule==='Agent Ledger proxy spawned a process');
const shellRule = falco.find(rule=>rule.rule==='Shell in agent-ledger namespace');
assert.match(processRule.condition,/container\.image\.repository endswith "ryan-zeleznock\/agent-ledger"/);
assert.match(shellRule.condition,/not container\.image\.repository endswith "library\/busybox"/);

assert.equal(fs.readFileSync('deploy/sql/001_init.sql','utf8'), fs.readFileSync('deploy/k8s/config/001_init.sql','utf8'), 'SQL copy drift');
const rendered = execFileSync('kubectl', ['kustomize', 'deploy/k8s'], {encoding:'utf8', timeout:30_000});
const docs = YAML.parseAllDocuments(rendered).map(doc => { assert.equal(doc.errors.length,0); return doc.toJS(); });
assert(!docs.some(doc => doc.kind === 'Secret'), 'Secrets must be provisioned outside this repo');
const workloads = docs.filter(doc => ['Deployment','StatefulSet','Job'].includes(doc.kind));
assert.equal(workloads.length,4);
for (const doc of workloads) {
  const pod=doc.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken,false);
  assert.equal(pod.securityContext.runAsNonRoot,true);
  assert.equal(pod.securityContext.seccompProfile.type,'RuntimeDefault');
  const uid=doc.metadata.name==='postgres'?70:65532;
  for(const key of ['runAsUser','runAsGroup','fsGroup']) assert.equal(pod.securityContext[key],uid);
  for (const forbidden of ['hostNetwork','hostPID','hostIPC']) assert(!pod[forbidden]);
  for (const v of pod.volumes??[]) assert(!v.hostPath);
  for (const c of [...pod.containers,...pod.initContainers??[]]) {
    assert.equal(c.securityContext.allowPrivilegeEscalation,false);
    assert.equal(c.securityContext.readOnlyRootFilesystem,true);
    assert.deepEqual(c.securityContext.capabilities.drop,['ALL']);
    assert(c.resources.requests.cpu && c.resources.requests.memory && c.resources.limits.cpu && c.resources.limits.memory);
    assert(!(c.env??[]).some(e=>e.name==='NODE_OPTIONS'));
    assert(!c.envFrom?.length);
    if(c.image.startsWith('ghcr.io/ryan-zeleznock/agent-ledger')) assert.match(c.image, /:slice-2a@sha256:[0-9a-f]{64}$/);
  }
}
for(const sa of docs.filter(d=>d.kind==='ServiceAccount')) assert.equal(sa.automountServiceAccountToken,false);
const proxy=workloads.find(d=>d.metadata.name==='proxy').spec.template.spec;
assert.equal(proxy.volumes.find(v=>v.name==='config').emptyDir.medium,'Memory');
assert(!proxy.volumes.find(v=>v.name==='secrets').secret.items.some(i=>i.key==='api-key'));
const job=workloads.find(d=>d.metadata.name==='integration');
assert.equal(job.spec.backoffLimit,0); assert.equal(job.spec.ttlSecondsAfterFinished,86400);
assert.equal(job.spec.template.spec.containers[0].args[0],'-e');
const nets=docs.filter(d=>d.kind==='NetworkPolicy');
assert.equal(nets.length,7);
assert.deepEqual(nets.find(n=>n.metadata.name==='00-default-deny').spec.policyTypes,['Ingress','Egress']);
assert.deepEqual(nets.find(n=>n.metadata.name==='10-allow-dns').spec.podSelector.matchExpressions[0].values,['proxy','integration']);
assert(!nets.some(n=>['postgres','demo-upstream'].includes(n.spec.podSelector.matchLabels?.app) && n.spec.egress?.length));
const registry=YAML.parse(fs.readFileSync('deploy/k8s/config/registry.yaml','utf8'));
assert.deepEqual(Object.keys(registry.servers.demo.tools).sort(),['add','echo','now','wipe']);
assert.equal(registry.servers.demo.tools.wipe.class,'risky');
assert.deepEqual(registry.servers.demo.tools.wipe.storeArgs,[]);
const service=docs.find(d=>d.kind==='Service'&&d.metadata.name==='proxy');
assert.equal(service.spec.ports[0].nodePort,30787); assert.equal(service.spec.externalTrafficPolicy,'Local');
const compose=YAML.parse(fs.readFileSync('docker-compose.yml','utf8'));
assert.deepEqual(compose.services.proxy.command,['dist/server/main.js']);
assert.equal(compose.services.proxy.environment.AGENT_LEDGER_APPROVALS,'none');
assert.equal(compose.services.postgres.user,'70:70');
console.log(`Offline deployment invariants checked: ${docs.length} resources, ${workloads.length} workloads; no API calls.`);
if(rendered.includes('sha256:'+'0'.repeat(64))) console.log('DIGEST PLACEHOLDER: Ryan must build/pin before deploying. Admission/runtime checks remain in HOMELAB.md.');
