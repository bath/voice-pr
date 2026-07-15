// Durable, user-local Action history. GitHub remains the collaboration surface;
// this store exists only so one user can refine Actions across Sessions.
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const ACTION_STORE_ROOT =
  process.env.VOICE_PR_ACTION_STORE_DIR || join(homedir(), ".voice-pr", "actions");

export function createActionStore({ root = ACTION_STORE_ROOT, now = () => new Date() } = {}) {
  const locks = new Map();

  function record({ pr, sessionId, plan }) {
    const key = prKey(pr);
    const prior = locks.get(key) || Promise.resolve();
    const next = prior.then(() => recordUnlocked({ key, pr, sessionId, plan }));
    locks.set(key, next.catch(() => {}));
    return next;
  }

  async function recordUnlocked({ key, pr, sessionId, plan }) {
    await mkdir(root, { recursive: true });
    const snapshotPath = join(root, `${key}.json`);
    const historyPath = join(root, `${key}.ndjson`);
    const snapshot = await readSnapshot(snapshotPath, pr);
    if (snapshot.sessions.includes(sessionId)) return snapshot;

    const recordedAt = now().toISOString();
    const byId = new Map(snapshot.actions.map((action) => [action.id, action]));
    const refToId = new Map();
    for (const action of plan.actions) {
      const id = byId.has(action.ref)
        ? action.ref
        : stableId("action", `${key}:${sessionId}:${action.ref}`);
      refToId.set(action.ref, id);
    }

    for (const action of plan.actions) {
      const id = refToId.get(action.ref);
      const priorAction = byId.get(id);
      const dependencyIds = action.dependsOn.map((ref) => refToId.get(ref) || ref);
      const projection = {
        id,
        objective: action.objective,
        target: action.target,
        constraints: action.constraints,
        acceptance: action.acceptance,
        disposition: action.disposition,
        intentStrength: action.intentStrength,
        authorization: action.authorization,
        progress: action.progress,
        verification: action.verification,
        dependsOn: dependencyIds,
        sourceSessions: [...new Set([...(priorAction?.sourceSessions || []), sessionId])],
        createdAt: priorAction?.createdAt || recordedAt,
        updatedAt: recordedAt,
      };
      if (priorAction) Object.assign(priorAction, projection);
      else {
        snapshot.actions.push(projection);
        byId.set(id, projection);
      }
    }

    const appendedOperations = plan.operations.map((operation) => ({
      id: stableId("operation", `${key}:${sessionId}:${operation.ref}`),
      sessionId,
      actionId: refToId.get(operation.actionRef) || operation.actionRef,
      kind: operation.kind,
      sourceSegmentIndexes: operation.sourceSegmentIndexes,
      summary: operation.summary,
      supersedes: operation.supersedes,
      recordedAt,
    }));
    snapshot.operations.push(...appendedOperations);

    const appendedEffects = plan.actions.flatMap((action) =>
      action.effects.map((effect) => ({
        id: stableId(
          "effect",
          `${key}:${sessionId}:${refToId.get(action.ref)}:${effect.ref}`
        ),
        sessionId,
        actionId: refToId.get(action.ref),
        capability: effect.capability,
        summary: effect.summary,
        authorization: effect.authorization,
        authorizationReason: effect.authorizationReason,
        receipt: null,
        plannedAt: recordedAt,
      }))
    );
    snapshot.effects.push(...appendedEffects);
    snapshot.sessions.push(sessionId);
    snapshot.updatedAt = recordedAt;

    const historyRecord = {
      schemaVersion: 1,
      sessionId,
      recordedAt,
      actionIds: [...refToId.values()],
      operations: appendedOperations,
      effects: appendedEffects,
    };
    const durableSnapshot = JSON.parse(JSON.stringify(snapshot));
    const temporaryPath = `${snapshotPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(durableSnapshot, null, 2), "utf8");
    await rename(temporaryPath, snapshotPath);
    await appendFile(historyPath, JSON.stringify(historyRecord) + "\n", "utf8");
    return durableSnapshot;
  }

  async function listOpen(pr) {
    const snapshot = await readSnapshot(join(root, `${prKey(pr)}.json`), pr);
    return snapshot.actions.filter(
      (action) => action.progress !== "resolved" && action.progress !== "cancelled"
    );
  }

  function recordEffectReceipt({ pr, sessionId, capability, receipt }) {
    const key = prKey(pr);
    const prior = locks.get(key) || Promise.resolve();
    const next = prior.then(async () => {
      const snapshotPath = join(root, `${key}.json`);
      const historyPath = join(root, `${key}.ndjson`);
      const snapshot = await readSnapshot(snapshotPath, pr);
      const recordedAt = now().toISOString();
      const matches = snapshot.effects.filter(
        (effect) =>
          effect.sessionId === sessionId &&
          effect.capability === capability &&
          !effect.receipt
      );
      for (const effect of matches)
        effect.receipt = { ...JSON.parse(JSON.stringify(receipt || {})), recordedAt };
      if (!matches.length) return { recorded: 0, snapshot };
      snapshot.updatedAt = recordedAt;
      const temporaryPath = `${snapshotPath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(snapshot, null, 2), "utf8");
      await rename(temporaryPath, snapshotPath);
      await appendFile(
        historyPath,
        JSON.stringify({
          schemaVersion: 1,
          type: "effect-receipt",
          sessionId,
          capability,
          effectIds: matches.map((effect) => effect.id),
          receipt,
          recordedAt,
        }) + "\n",
        "utf8"
      );
      return { recorded: matches.length, snapshot };
    });
    locks.set(key, next.catch(() => {}));
    return next;
  }

  return { record, listOpen, recordEffectReceipt };
}

async function readSnapshot(path, pr) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed.schemaVersion !== 1) throw new Error("Unsupported Action store schema");
    return parsed;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      schemaVersion: 1,
      pr: { owner: pr.owner, repo: pr.repo, number: pr.number, url: pr.url || null },
      sessions: [],
      actions: [],
      operations: [],
      effects: [],
      updatedAt: null,
    };
  }
}

function prKey(pr) {
  return `${pr.owner}_${pr.repo}_${pr.number}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function stableId(prefix, value) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

export const actionStore = createActionStore();
