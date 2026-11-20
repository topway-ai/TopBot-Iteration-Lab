import { isDeepStrictEqual } from "node:util";
import { normalizeTagRulesetProof } from "./topbot-tag-ruleset.mjs";

const repository = "topway-ai/TopBot-Iteration-Lab";
const repositoryId = 1464902386;
const repositoryNodeId = "R_kgDOV1Ci8g";
const repo = `/repos/${repository}`;
const actionsAppId = 15368;
const workflows = [["ci.yml", "CI"], ["topbot-automatic-review.yml", "TopBot automatic review"]];
const trustedFiles = [".github/workflows/ci.yml", ".github/workflows/topbot-automatic-review.yml",
  ".github/workflows/topbot-windows-update.yml", "scripts/topbot-auto-review.mjs"];
const contexts = new Set(workflows.map(([, name]) => name));
const automaticRules = new Set(["creation", "deletion", "non_fast_forward", "required_linear_history",
  "required_signatures", "required_status_checks"]);
const pendingStatuses = new Set(["requested", "queued", "pending", "waiting", "in_progress"]);
const isId = value => Number.isSafeInteger(value) && value > 0;
const isSha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value) && value !== "0".repeat(40);
const sameRepo = value => value?.id === repositoryId && value.node_id === repositoryNodeId && value.full_name === repository;

export class AutomaticCheckPending extends Error {
  name = "AutomaticCheckPending";
}

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

async function requireMainTip(read, expectedSha) {
  const main = await read(`${repo}/branches/main`);
  requireState(main?.protected === true && main.commit?.sha === expectedSha, "Protected main is not at the expected SHA.");
  return main;
}

async function verifyRulesets(read, rules, attestations) {
  const byId = new Map();
  for (const rule of rules) {
    requireState(isId(rule.ruleset_id), "A required main rule has no verifiable ruleset ID.");
    const group = byId.get(rule.ruleset_id) ?? [];
    group.push(rule);
    byId.set(rule.ruleset_id, group);
  }
  for (const [id, effective] of byId) {
    const detail = await read(`${repo}/rulesets/${id}`);
    const types = new Set(effective.map(rule => rule.type));
    const sameRule = (entry, rule) => entry?.type === rule.type && isDeepStrictEqual(entry.parameters, rule.parameters);
    requireState(detail?.id === id && detail.target === "branch" && detail.enforcement === "active" &&
      typeof detail.source === "string" && detail.source.length > 0 && ["Repository", "Organization", "Enterprise"].includes(detail.source_type) &&
      (detail.source_type !== "Repository" || detail.source === repository) && types.size === effective.length &&
      Array.isArray(detail.rules) && detail.rules.length === effective.length && effective.every(rule =>
        detail.source_type === rule.ruleset_source_type && detail.source === rule.ruleset_source && detail.rules.some(entry => sameRule(entry, rule))),
    "An effective main ruleset changed or could not be verified.");
    const revision = normalizeTagRulesetProof(`${id}@${detail.updated_at}`);
    // Read-only tokens can use a separately pinned, previously verified revision.
    requireState(Object.hasOwn(detail, "bypass_actors")
      ? Array.isArray(detail.bypass_actors) && detail.bypass_actors.length === 0
      : revision && attestations.includes(revision), "An effective main ruleset permits bypass or the bypass list is unverifiable.");
  }
}

export async function requireAutomaticMain(read, expectedSha, attestations = []) {
  requireState(isSha(expectedSha), "Invalid expected main SHA.");
  const main = await requireMainTip(read, expectedSha);
  const rules = await read(`${repo}/rules/branches/main`);
  // The effective branch endpoint excludes disabled and evaluation-only rulesets.
  requireState(Array.isArray(rules) && rules.every(rule => automaticRules.has(rule?.type)) &&
    main.protection?.required_pull_request_reviews == null && main.protection?.required_conversation_resolution?.enabled !== true,
  "Protected main has a manual or unsupported gate.");
  requireState(rules.some(rule => rule.type === "deletion") && rules.some(rule => rule.type === "non_fast_forward"),
    "Protected main must block deletion and non-fast-forward updates.");
  const required = new Set();
  for (const rule of rules.filter(rule => rule.type === "required_status_checks")) {
    const checks = rule.parameters?.required_status_checks;
    requireState(Array.isArray(checks) && checks.length > 0 && checks.every(check =>
      contexts.has(check?.context) && check.integration_id === actionsAppId), "Protected main has an unexpected required check or integration.");
    for (const check of checks) required.add(check.context);
  }
  requireState(required.size === contexts.size, "Protected main must require both TopBot GitHub Actions checks.");
  await verifyRulesets(read, rules, attestations);
  requireState((await read(`${repo}/immutable-releases`))?.enabled === true, "Immutable releases are not enabled.");
}

function candidateInput(candidate) {
  const { pr, base, head, branch } = candidate ?? {};
  requireState(isId(pr) && isSha(base) && isSha(head) && base !== head && typeof branch === "string" &&
    /^topbot-auto\/[a-z0-9][a-z0-9-]{0,39}$/.test(branch), "Invalid automatic TopBot candidate.");
  return { pr, base, head, branch };
}

function completeList(response, key, label) {
  const list = response?.[key];
  requireState(Array.isArray(list) && list.length <= 100 && response.total_count === list.length,
    `Cannot verify a complete ${label} listing.`);
  return list;
}

function exactlyLinked(run, { pr, base, head, branch }, workflow) {
  if (run?.event !== "pull_request" || run.head_sha !== head || run.head_branch !== branch ||
      typeof run.path !== "string" || run.path.split("@", 1)[0] !== `.github/workflows/${workflow}` ||
      !sameRepo(run.repository) || !sameRepo(run.head_repository) || !Array.isArray(run.pull_requests) || run.pull_requests.length !== 1) return false;
  const [link] = run.pull_requests;
  return link?.number === pr && link.head?.ref === branch && link.head.sha === head && link.head.repo?.id === repositoryId &&
    link.base?.ref === "main" && link.base.sha === base && link.base.repo?.id === repositoryId;
}

function requireSuccess(check, label) {
  if (pendingStatuses.has(check.status) && check.conclusion === null) throw new AutomaticCheckPending(`${label} is still running.`);
  requireState(check.status === "completed" && check.conclusion === "success", `${label} did not finish successfully.`);
}

async function verifyWorkflow(read, candidate, workflow, name) {
  const runs = completeList(await read(`${repo}/actions/workflows/${workflow}/runs?event=pull_request&head_sha=${candidate.head}&per_page=100`),
    "workflow_runs", `${name} run`);
  if (runs.length === 0) throw new AutomaticCheckPending(`${name} has not started for this candidate.`);
  const matches = runs.filter(run => exactlyLinked(run, candidate, workflow));
  const [run] = matches;
  requireState(matches.length === 1 && isId(run.id) && isId(run.run_attempt), `No unique ${name} run matches the exact PR, workflow path, base and head.`);
  requireSuccess(run, `${name} run`);
  const jobs = completeList(await read(`${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`), "jobs", `${name} attempt job`);
  const final = jobs.filter(job => job?.name === name);
  const [job] = final;
  requireState(final.length === 1 && isId(job.id) && job.run_id === run.id && job.head_sha === candidate.head,
    `No unique ${name} final job matches the verified run attempt and head.`);
  requireSuccess(job, `${name} final job`);
  return { run: run.id, attempt: run.run_attempt, job: job.id };
}

export async function verifyAutomaticCandidate(read, candidate) {
  const input = candidateInput(candidate);
  await Promise.all(trustedFiles.map(async file => {
    const [base, head] = await Promise.all([read(`${repo}/contents/${file}?ref=${input.base}`),
      read(`${repo}/contents/${file}?ref=${input.head}`)]);
    requireState(base?.type === "file" && head?.type === "file" && base.path === file && head.path === file &&
      isSha(base.sha) && head.sha === base.sha, "The candidate changed trusted CI, review or release definitions.");
  }));
  const [ci, review] = await Promise.all(workflows.map(([workflow, name]) => verifyWorkflow(read, input, workflow, name).catch(error => {
    if (error instanceof AutomaticCheckPending) return error;
    throw error;
  })));
  if (ci instanceof AutomaticCheckPending) throw ci;
  if (review instanceof AutomaticCheckPending) throw review;
  return { ...input, ciRun: ci.run, ciAttempt: ci.attempt, ciJob: ci.job,
    reviewRun: review.run, reviewAttempt: review.attempt, reviewJob: review.job };
}

export async function advanceAutomaticMain(request, candidate) {
  const input = candidateInput(candidate);
  const { pr, base, head, branch } = input;
  const read = path => request(path);
  await requireAutomaticMain(read, base);
  const commit = await read(`${repo}/git/commits/${head}`);
  requireState(commit?.sha === head && Array.isArray(commit.parents) && commit.parents.length === 1 && commit.parents[0]?.sha === base,
    "The candidate must be an exact single child of the current main.");
  await verifyAutomaticCandidate(read, input);
  const pull = await read(`${repo}/pulls/${pr}`);
  requireState(pull?.number === pr && pull.state === "open" && pull.draft === false && pull.merged === false &&
    pull.base?.ref === "main" && pull.base.sha === base && sameRepo(pull.base.repo) &&
    pull.head?.ref === branch && pull.head.sha === head && sameRepo(pull.head.repo), "The open TopBot PR no longer matches the candidate.");

  // GitHub checks both leases in one transaction; the source ref is not advanced.
  const receipt = await request("/graphql", "POST", {
    query: "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
    variables: { input: { repositoryId: repositoryNodeId, clientMutationId: head, refUpdates: [
      { name: `refs/heads/${branch}`, beforeOid: head, afterOid: head, force: false },
      { name: "refs/heads/main", beforeOid: base, afterOid: head, force: false },
    ] } },
  });
  requireState(receipt?.errors === undefined && receipt?.data?.updateRefs?.clientMutationId === head,
    "GitHub did not confirm the atomic ref update. Inspect the refs before retrying.");
  await requireMainTip(read, head);
  return head;
}
