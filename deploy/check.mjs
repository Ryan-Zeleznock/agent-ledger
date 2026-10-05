// Offline invariants, not Kubernetes admission or independent security approval. Never contacts the cluster.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import YAML from 'yaml';

// Slice 2b pin 9: the digests resolved from Docker Hub on 2026-10-04 (index digests, multi-arch; deploy/README.md).
const BUSYBOX='docker.io/library/busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e';
const POSTGRES='docker.io/library/postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';

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
assert.equal(workloads.length,5);
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
    if(c.image.startsWith('ghcr.io/ryan-zeleznock/agent-ledger')) assert.match(c.image, doc.metadata.name==='everything' ? /^ghcr\.io\/ryan-zeleznock\/agent-ledger:everything-2026\.8\.31@sha256:[0-9a-f]{64}$/ : /^ghcr\.io\/ryan-zeleznock\/agent-ledger:slice-2b@sha256:[0-9a-f]{64}$/);
    // Slice 2b pin 9: every image in the namespace is digest-pinned, busybox and postgres included.
    assert.match(c.image, /@sha256:[0-9a-f]{64}$/, `${doc.metadata.name}/${c.name} image must be digest-pinned`);
    if(c.image.startsWith('docker.io/library/busybox:')) assert.equal(c.image, BUSYBOX);
    if(c.image.startsWith('docker.io/library/postgres:')) assert.equal(c.image, POSTGRES);
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
assert.equal(nets.length,8);
assert.deepEqual(nets.find(n=>n.metadata.name==='00-default-deny').spec.policyTypes,['Ingress','Egress']);
assert.deepEqual(nets.find(n=>n.metadata.name==='10-allow-dns').spec.podSelector.matchExpressions[0].values,['proxy','integration']);
assert(!nets.some(n=>['postgres','demo-upstream','everything'].includes(n.spec.podSelector.matchLabels?.app) && n.spec.egress?.length));
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

// ---------- Slice 2b (pins 5, 7, 9, 10) ----------
const proxyDeploy=workloads.find(d=>d.metadata.name==='proxy');
assert.equal(proxyDeploy.spec.replicas,1,'ONE proxy per Slack app (ADR-015)');
assert.equal(proxyDeploy.spec.strategy?.type,'Recreate','a RollingUpdate would run two Socket Mode routers at once');
const pc=proxy.containers[0];
for(const probe of ['startupProbe','readinessProbe','livenessProbe']) assert.equal(pc[probe]?.httpGet?.scheme,'HTTPS',`proxy ${probe} must be HTTPS`);
assert(pc.startupProbe.periodSeconds*pc.startupProbe.failureThreshold>=2*60+30,'startupProbe must cover both 60 s connect budgets + 30 s');
const penv=Object.fromEntries(pc.env.map(e=>[e.name,e.value]));
assert.equal(penv.AGENT_LEDGER_APPROVALS,'slack'); assert.equal(penv.AGENT_LEDGER_TLS,'on'); assert.equal(penv.AGENT_LEDGER_UPSTREAM_CONNECT_BUDGET_MS,'60000');
const stage=proxy.initContainers.find(c=>c.name==='stage-config').command.join(' ');
for(const f of ['/mnt/registry/approvals.yaml','/mnt/slack/approvals.botToken','/mnt/slack/approvals.appToken','/mnt/tls/tls.crt','/mnt/tls/tls.key']) assert(stage.includes(f),`stage-config must copy ${f}`);
assert.match(stage,/umask 077/); assert.match(stage,/chmod 600/);
assert.deepEqual(proxy.volumes.find(v=>v.name==='slack-tokens').secret.items.map(i=>i.key),['approvals.botToken','approvals.appToken']);
assert.deepEqual(proxy.volumes.find(v=>v.name==='proxy-tls').secret.items.map(i=>i.key),['tls.crt','tls.key']);
// Slack egress: exactly one ipBlock rule, public IPv4 on TCP 443 only, private ranges excepted.
const pe=nets.find(n=>n.metadata.name==='20-proxy-egress').spec.egress;
const ipRules=pe.filter(r=>r.to.some(t=>t.ipBlock));
assert.equal(ipRules.length,1);
assert.deepEqual(ipRules[0].to,[{ipBlock:{cidr:'0.0.0.0/0',except:['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16']}}]);
assert.deepEqual(ipRules[0].ports,[{protocol:'TCP',port:443}]);
assert(pe.some(r=>r.to.some(t=>t.podSelector?.matchLabels?.app==='everything') && r.ports.length===1 && r.ports[0].port===3001));
// everything: ingress only from the proxy on 3001, no egress at all; the Pod holds nothing secret.
const ev=nets.find(n=>n.metadata.name==='25-everything').spec;
assert.deepEqual(ev.policyTypes,['Ingress','Egress']); assert.deepEqual(ev.egress,[]);
assert.deepEqual(ev.ingress,[{from:[{podSelector:{matchLabels:{app:'proxy'}}}],ports:[{protocol:'TCP',port:3001}]}]);
assert(!nets.some(n=>n.metadata.name!=='25-everything' && n.metadata.name!=='00-default-deny' && JSON.stringify(n.spec.podSelector).includes('everything')),'no other policy may select everything');
const evDeploy=workloads.find(d=>d.metadata.name==='everything');
const evPod=evDeploy.spec.template.spec;
assert.equal(evDeploy.spec.replicas,1); assert.equal(evPod.enableServiceLinks,false); assert.equal(evPod.automountServiceAccountToken,false);
assert.equal(evPod.volumes,undefined,'everything mounts nothing'); assert.equal(evPod.initContainers,undefined);
assert.deepEqual(evPod.containers[0].env,[{name:'PORT',value:'3001'}]);
// the image's build input: exact version + integrity in the lockfile (pin 10), digest-pinned bases, no install scripts
const lock=JSON.parse(fs.readFileSync('deploy/upstreams/everything/package-lock.json','utf8'));
const se=lock.packages['node_modules/@modelcontextprotocol/server-everything'];
assert.equal(se.version,'2026.8.31');
assert.equal(se.integrity,'sha512-5U3OZh8Xq0Li4nA26l6uNvV9/1suMDuWSn+NjLZIhzinhMY6N3A4DCrxVecBGPf2PsNFKTEv5krxGPRwzxc7jQ==');
for(const [k,v] of Object.entries(lock.packages)) if(k){ assert.match(v.resolved,/^https:\/\/registry\.npmjs\.org\//,k); assert.match(v.integrity,/^sha512-/,k); assert(!v.hasInstallScript,`${k} has an install script`); }
assert.deepEqual(JSON.parse(fs.readFileSync('deploy/upstreams/everything/package.json','utf8')).dependencies,{'@modelcontextprotocol/server-everything':'2026.8.31'});
assert.equal(fs.readFileSync('deploy/upstreams/everything/.npmrc','utf8').trim(),'ignore-scripts=true');
const evDocker=fs.readFileSync('deploy/upstreams/everything/Dockerfile','utf8');
for(const from of evDocker.split('\n').filter(l=>l.startsWith('FROM '))) assert.match(from,/@sha256:[0-9a-f]{64}( AS \w+)?$/,from);
assert.match(evDocker,/npm ci --omit=dev --ignore-scripts/); assert.match(evDocker,/^USER 65532$/m);
// Kyverno: digest rule covers busybox/postgres; projected-token rule + its negative Pod
const kyv=docs.find(d=>d.kind==='ValidatingPolicy').spec.validations;
assert(kyv.some(v=>v.expression.includes("docker.io/library/busybox:") && v.expression.includes("docker.io/library/postgres:") && v.expression.includes('@sha256:')));
assert(kyv.some(v=>v.expression.includes('serviceAccountToken') && v.expression.includes('projected')));
const badProjected=YAML.parse(fs.readFileSync('deploy/k8s/test/bad-pod-projected-token.yaml','utf8'));
assert.equal(badProjected.spec.automountServiceAccountToken,false);
assert(badProjected.spec.volumes.some(v=>v.projected?.sources?.some(s=>s.serviceAccountToken)));
// the cluster-scoped Kyverno reports RBAC (applied by its own step; not in the kustomization)
const cr=YAML.parse(fs.readFileSync('deploy/k8s/cluster/kyverno-reports-ephemeralcontainers.yaml','utf8'));
assert.equal(cr.kind,'ClusterRole'); assert.equal(cr.metadata.labels['rbac.kyverno.io/aggregate-to-reports-controller'],'true');
assert.deepEqual(cr.rules,[{apiGroups:[''],resources:['pods/ephemeralcontainers'],verbs:['get','list','watch']}]);
assert(!docs.some(d=>d.kind==='ClusterRole'),'cluster-scoped RBAC stays out of the namespace kustomization');
// registry rows (pin 7) and the upstream entry
assert.equal(registry.servers.everything.tools['get-env'].class,'risky'); assert.deepEqual(registry.servers.everything.tools['get-env'].storeArgs,[]);
assert.equal(registry.servers.everything.tools['gzip-file-as-resource'].class,'risky');
assert.deepEqual(registry.servers.everything.tools.echo.storeArgs,['message']); assert.deepEqual(registry.servers.everything.tools['get-sum'].storeArgs,['a','b']);
const ups=YAML.parse(fs.readFileSync('deploy/k8s/config/upstreams.yaml','utf8')).upstreams;
assert.deepEqual(ups.find(u=>u.name==='everything'),{name:'everything',transport:'http',url:'http://everything.agent-ledger.svc.cluster.local:3001/mcp'});
assert(!ups.some(u=>u.name==='approvals'),'approvals is a reserved upstream name');
const appr=YAML.parse(fs.readFileSync('deploy/k8s/config/approvals.yaml','utf8'));
assert.deepEqual(Object.keys(appr.slack).sort(),['approvers','channelId','timeoutMs']); assert(appr.slack.timeoutMs<=240000);
const integ=job.spec.template.spec.containers[0].args[1];
for(const flag of ["'--approvals','slack'","'--ca-file','/mnt/ca/ca.crt'","'--expect-legacy','everything'","'https://proxy.agent-ledger.svc:8787/mcp'"]) assert(integ.includes(flag),`integration smoke needs ${flag}`);
const slackManifest=YAML.parse(fs.readFileSync('deploy/slack/app-manifest.yaml','utf8'));
assert.deepEqual(slackManifest.oauth_config.scopes.bot,['chat:write']);
assert.equal(slackManifest.settings.socket_mode_enabled,true); assert.equal(slackManifest.settings.interactivity.is_enabled,true);
assert.equal(slackManifest.settings.interactivity.request_url,undefined); assert.equal(slackManifest.settings.org_deploy_enabled,false); assert.equal(slackManifest.settings.token_rotation_enabled,false);
if(appr.slack.channelId==='C0000000000') console.log('APPROVALS PLACEHOLDER: Ryan sets the channel and approver ids in HOMELAB step 5b.');

console.log(`Offline deployment invariants checked: ${docs.length} resources, ${workloads.length} workloads; no API calls.`);
if(rendered.includes('sha256:'+'0'.repeat(64))) console.log('DIGEST PLACEHOLDER: Ryan must build/pin before deploying. Admission/runtime checks remain in HOMELAB.md.');
