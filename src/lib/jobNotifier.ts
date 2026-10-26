import { toaster } from "@decky/api";
import { getAllProgress } from "../utils/backendApi";
import type { AllProgress, JobProgress } from "../utils/backendApi";

type JobSnapshot = Record<string, { status?: string; stage?: string }>;

declare global {
  interface Window {
    GamepadUI?: { playUISound: (sound: string) => void };
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let prevSnapshot: JobSnapshot = {};
let initialized = false;
let cachedState: AllProgress | null = null;
const listeners = new Set<(state: AllProgress) => void>();

// Track which groups have already fired their completion/error toast
// so multi-file groups only toast once (when the last job in the group finishes).
const toastedGroups = new Set<string>();

function playSound(name: string) {
  window.GamepadUI?.playUISound(name);
}

function processResult(result: AllProgress) {
  const jobs = result.jobs;

  if (!initialized) {
    // On first load, snapshot all current statuses without toasting anything.
    prevSnapshot = Object.fromEntries(
      Object.entries(jobs).map(([k, v]) => [k, { status: v.status, stage: v.stage }])
    );
    // Mark any already-done groups as toasted so we don't re-toast on restart.
    for (const job of Object.values(jobs)) {
      const gid = job.group_id;
      if (gid && (job.status === "done" || job.status === "error")) {
        toastedGroups.add(gid);
      }
    }
    initialized = true;
    cachedState = { is_copying: result.is_copying, is_stopping: result.is_stopping, jobs: { ...jobs } };
    listeners.forEach((cb) => cb(cachedState!));
    return;
  }

  // ── Group-aware toast logic ──────────────────────────────────────────────
  // For file ops that share a group_id, we want a single toast per group
  // (e.g. "Copied 3 items") fired only when every job in that group is done.
  // For game copy jobs (no group_id), we preserve the existing per-job toast.

  // Collect jobs that just transitioned to done/error this tick.
  const justDone: Array<JobProgress & { _jobId: string }> = [];
  const justErrored: Array<JobProgress & { _jobId: string }> = [];

  for (const [jobId, job] of Object.entries(jobs)) {
    const prev = prevSnapshot[jobId];
    if (job.status === "done" && prev?.status !== "done") {
      justDone.push({ ...job, _jobId: jobId });
    } else if (job.status === "error" && prev?.status !== "error") {
      justErrored.push({ ...job, _jobId: jobId });
    }
  }

  // Process completions grouped by group_id
  const processedGroups = new Set<string>();

  for (const job of justDone) {
    const gid = job.group_id;
    const groupTotal = job.group_total;
    const isAlreadyExisted = job.already_existed === true;
    const isExtract = job.op === "extract";
    const isCompress = job.op === "compress";
    const isFileOp = job.op === "copy" || job.op === "move" || isExtract || isCompress;

    if (isFileOp && gid) {
      // Skip if we've already toasted this group
      if (toastedGroups.has(gid) || processedGroups.has(gid)) continue;

      // Count how many jobs in this group are now done
      const groupJobs = Object.values(jobs).filter((j) => j.group_id === gid);
      const doneCount = groupJobs.filter((j) => j.status === "done" || j.status === "error" || j.status === "cancelled").length;
      const total = groupTotal ?? groupJobs.length;

      // Only toast when all jobs in the group have finished
      if (doneCount < total) continue;

      processedGroups.add(gid);
      toastedGroups.add(gid);

      const successCount = groupJobs.filter((j) => j.status === "done").length;
      if (successCount > 0) {
        const allSkipped = groupJobs.every((j) => j.status === "done" && j.already_existed === true);
        if (allSkipped) {
          playSound("deck_ui_toast");
          const label = successCount === 1
            ? (job.name ?? "1 item")
            : `${successCount} items`;
          toaster.toast({ title: "Already there", body: label });
        } else {
          playSound(isExtract ? "deck_ui_toast" : "deck_ui_achievement_toast");
          const label = successCount === 1
            ? (job.name ?? "1 item")
            : `${successCount} items`;
          const opLabel = isExtract ? "Extracted!" : isCompress ? "Compressed!" : job.op === "move" ? "Moved!" : "Copied!";
          toaster.toast({ title: opLabel, body: label });
        }
      }
    } else {
      // Non-grouped job: Steam game copy, non-Steam folder copy, or single-file ROM copy
      const name = job.name ?? `App ${job._jobId}`;
      const isNonSteam = job.op === "nonsteam" || job.op === "nonsteam_file";
      if (isAlreadyExisted) {
        playSound("deck_ui_toast");
        toaster.toast({ title: "Already on drive", body: name });
      } else {
        playSound("deck_ui_achievement_toast");
        toaster.toast({ title: isNonSteam ? "Copied!" : "Copied!", body: name });
      }
    }
  }

  // Process errors grouped by group_id
  for (const job of justErrored) {
    const gid = job.group_id;
    const isExtract = job.op === "extract";
    const isCompress = job.op === "compress";
    const isFileOp = job.op === "copy" || job.op === "move" || isExtract || isCompress;
    const name = job.name ?? `App ${job._jobId}`;

    if (isFileOp && gid) {
      if (toastedGroups.has(gid) || processedGroups.has(gid)) continue;
      // For errors, toast immediately per-job so the user knows what failed
      processedGroups.add(gid);
      toastedGroups.add(gid);
      playSound("deck_ui_toast");
      toaster.toast({
        title: isExtract ? "Extract error" : isCompress ? "Compress error" : "Copy error",
        body: job.error ? `${name}: ${job.error}` : name,
      });
    } else {
      // Non-grouped job error: Steam game, non-Steam folder, or ROM file copy
      playSound("deck_ui_toast");
      toaster.toast({
        title: "Copy error",
        body: job.error ? `${name}: ${job.error}` : name,
      });
    }
  }

  // Clean up toastedGroups for groups that have been fully removed from jobs
  // (backend clears done jobs eventually) so stale entries don't accumulate.
  const activeGroupIds = new Set(
    Object.values(jobs)
      .map((j) => j.group_id)
      .filter(Boolean)
  );
  for (const gid of toastedGroups) {
    if (!activeGroupIds.has(gid)) toastedGroups.delete(gid);
  }

  prevSnapshot = Object.fromEntries(
    Object.entries(jobs).map(([k, v]) => [k, { status: v.status, stage: v.stage }])
  );
  cachedState = { is_copying: result.is_copying, is_stopping: result.is_stopping, jobs: { ...jobs } };
  listeners.forEach((cb) => cb(cachedState!));
}

function reschedule(ms: number) {
  if (intervalId !== null) clearInterval(intervalId);
  intervalId = setInterval(poll, ms);
}

async function poll() {
  try {
    const result = await getAllProgress();
    processResult(result);
    // Keep polling whenever there's active work or subscribers watching.
    // Check both is_copying AND any non-done jobs in the snapshot — there's
    // a brief window between "job queued" and "_is_copying = True" where
    // is_copying is false but work is in flight. Without this, polling stops
    // and the completion toast never fires if the QAM was closed.
    const hasActiveJobs = Object.values(result.jobs).some(
      j => j.status !== "done" && j.status !== "error" && j.status !== "cancelled"
    );
    if (result.is_copying || hasActiveJobs) {
      reschedule(500);
    } else if (listeners.size > 0) {
      reschedule(1000);
    } else {
      if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
    }
  } catch {
    reschedule(3000);
  }
}

export function startJobNotifier() {
  if (intervalId !== null) return;
  initialized = false;
  prevSnapshot = {};
  toastedGroups.clear();
  poll();
}

export function stopJobNotifier() {
  if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
  initialized = false;
  prevSnapshot = {};
  cachedState = null;
  listeners.clear();
  toastedGroups.clear();
}

export function getCachedProgress(): AllProgress | null {
  return cachedState;
}

export function subscribeToProgress(cb: (state: AllProgress) => void): () => void {
  listeners.add(cb);
  if (cachedState !== null) cb(cachedState);
  // Always ensure polling is running while there are active subscribers
  // so the panel stays live even after is_copying goes false.
  if (intervalId === null) {
    intervalId = setInterval(poll, 1000);
  }
  return () => {
    listeners.delete(cb);
    // Only stop polling if no subscribers AND no active jobs in flight.
    // Stopping while a copy is running would mean the completion toast
    // never fires after the QAM is closed.
    if (listeners.size === 0 && intervalId !== null) {
      const hasActive = cachedState
        ? Object.values(cachedState.jobs).some(
            j => j.status !== "done" && j.status !== "error" && j.status !== "cancelled"
          )
        : false;
      if (!hasActive && !cachedState?.is_copying) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }
  };
}

export async function forceRefresh(): Promise<void> {
  // Always restart polling — called after queuing a new job so we need
  // to start checking even before the backend confirms activity.
  if (intervalId === null) {
    intervalId = setInterval(poll, 500);
  }
  try {
    const result = await getAllProgress();
    processResult(result);
  } catch {
    // ignore
  }
}
