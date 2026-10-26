import { useState, useEffect, useRef, type CSSProperties } from "react";
import {
  DialogButton,
  ProgressBar,
  Focusable,
  NavEntryPositionPreferences,
} from "@decky/ui";
import {
  cancelAll,
  cancelJob,
  cancelGroup,
  removeFromQueue,
  removeGroupFromQueue,
  clearCompletedProgress,
  clearCompletedJob,
  pauseCopy,
  resumeCopy,
  pauseGroup,
  resumeGroup,
} from "../utils/backendApi";
import type { AllProgress, JobProgress } from "../utils/backendApi";
import {
  getCachedProgress,
  subscribeToProgress,
  forceRefresh,
} from "../lib/jobNotifier";
import { promptCancelPartial } from "../utils/cancelPartialPrompt";

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec >= 1e9) return `${(bytesPerSec / 1e9).toFixed(1)} GB/s`;
  if (bytesPerSec >= 1e6) return `${(bytesPerSec / 1e6).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1e3) return `${(bytesPerSec / 1e3).toFixed(0)} KB/s`;
  return `${bytesPerSec.toFixed(0)} B/s`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

// A "display row" — either a single game job or a merged file-op group
interface DisplayRow {
  key: string;           // unique key for React
  name: string;
  stage: string;
  status: string;
  copied: number;
  total: number;
  error?: string | null;
  pause_reason?: string | null;
  /** Absolute destination path shown under completed entries */
  destPath?: string;
  /** Insertion order from the jobs map (queue add order). */
  orderIndex: number;
  /** Finish order for completed jobs (backend completed_seq). */
  completedSeq: number;
  // For game jobs: the appid used for pause/resume/cancel
  appid?: string;
  // For file-op groups: the group_id used for bulk remove
  groupId?: string;
  // Individual job ids in the group (needed for pause/resume if ever added)
  jobIds?: string[];
  isFileOp: boolean;
}

function isCancelPartialPromptOn(): boolean {
  return (window as any).__copydeck_cancel_partial_prompt !== false;
}

async function confirmAndCancelJob(row: DisplayRow): Promise<void> {
  let remove = false;
  if (isCancelPartialPromptOn()) {
    const choice = await promptCancelPartial({
      title: `Cancel ${row.name}?`,
    });
    if (choice === null) return;
    remove = choice === "remove";
  }
  if (row.isFileOp && row.groupId) await cancelGroup(row.groupId, remove);
  else if (row.appid) await cancelJob(row.appid, remove);
  await forceRefresh();
}

async function confirmAndCancelAll(): Promise<void> {
  let remove = false;
  if (isCancelPartialPromptOn()) {
    const choice = await promptCancelPartial({
      title: "Cancel all copies?",
      body: "Stop every active and queued job. Keep partials on the destination (resume later with Skip) or remove them?",
    });
    if (choice === null) return;
    remove = choice === "remove";
  }
  await cancelAll(remove);
  await forceRefresh();
}

function jobDestPath(job: JobProgress): string {
  return job.dest_path || job.dst_dir || job.dst_library || "";
}

// Merge all jobs that share a group_id into a single DisplayRow.
// Game jobs (no group_id) each become their own row.
function buildDisplayRows(
  jobs: AllProgress["jobs"],
  speeds: Record<string, number>
): { rows: DisplayRow[]; groupSpeed: Record<string, number> } {
  const rows: DisplayRow[] = [];
  const groupMap = new Map<string, DisplayRow>();
  let nextOrder = 0;

  for (const [jobId, job] of Object.entries(jobs)) {
    const gid = job.group_id;

    if (gid) {
      // File-op job — merge into group row (first sighting sets list order)
      if (!groupMap.has(gid)) {
        const row: DisplayRow = {
          key: gid,
          name: job.name ?? jobId,
          stage: job.stage ?? job.status ?? "",
          status: job.status ?? "",
          copied: 0,
          total: 0,
          error: null,
          destPath: jobDestPath(job),
          orderIndex: nextOrder++,
          completedSeq: job.completed_seq ?? 0,
          groupId: gid,
          jobIds: [],
          isFileOp: true,
        };
        groupMap.set(gid, row);
        rows.push(row);
      }
      const row = groupMap.get(gid)!;
      row.jobIds!.push(jobId);
      if (!row.destPath) row.destPath = jobDestPath(job);
      // Group completes when the last member finishes — take the max seq
      if ((job.completed_seq ?? 0) > row.completedSeq) {
        row.completedSeq = job.completed_seq ?? 0;
      }
      row.copied += job.copied ?? 0;
      // If the backend echoes group_total_bytes, use that as the authoritative total
      // for the whole group (set once from the first job that carries it).
      // Fall back to summing per-job totals for older backends.
      if (job.group_total_bytes && row.total === 0) {
        row.total = job.group_total_bytes;
      } else if (!job.group_total_bytes) {
        row.total += job.total ?? 0;
      }

      // Propagate worst status: copying > paused > queued; error/done/cancelled handled below
      const priority: Record<string, number> = {
        error: 6, copying: 5, paused: 4, queued: 3, cancelled: 2, done: 1,
      };
      if ((priority[job.status ?? ""] ?? 0) > (priority[row.status] ?? 0)) {
        row.status = job.status ?? row.status;
        row.stage  = job.stage  ?? row.stage;
      }

      // Collect errors
      if (job.error) row.error = job.error;

      // Build group label from first job name + group_total
      const gt = job.group_total ?? 1;
      if (row.jobIds!.length === 1) {
        // First job sets the base name
        const baseName = job.name ?? jobId;
        row.name = gt > 1
          ? `${baseName} & ${gt - 1} other${gt - 1 === 1 ? "" : "s"}`
          : baseName;
      }
      // Subsequent jobs in the group don't change the name
    } else {
      // Game job — one row per job
      rows.push({
        key: jobId,
        name: job.name ?? `App ${jobId}`,
        stage: job.stage ?? job.status ?? "",
        status: job.status ?? "",
        copied: job.copied ?? 0,
        total:  job.total  ?? 0,
        error:  job.error,
        pause_reason: job.pause_reason,
        destPath: jobDestPath(job),
        orderIndex: nextOrder++,
        completedSeq: job.completed_seq ?? 0,
        appid: jobId,
        isFileOp: false,
      });
    }
  }

  // Compute per-group speed by summing per-job speeds
  const groupSpeed: Record<string, number> = {};
  for (const [jobId, spd] of Object.entries(speeds)) {
    const job = jobs[jobId];
    const gid = job?.group_id;
    if (gid) {
      groupSpeed[gid] = (groupSpeed[gid] ?? 0) + spd;
    }
  }

  return { rows, groupSpeed };
}

export function BatchProgressPanel() {
  const [state, setState] = useState<AllProgress | null>(() => getCachedProgress());
  const [speeds, setSpeeds] = useState<Record<string, number>>({});
  const [completedOpen, setCompletedOpen] = useState(false);
  const prevCopied = useRef<Record<string, { bytes: number; time: number }>>({});

  useEffect(() => {
    return subscribeToProgress((newState) => {
      setState(newState);
      const now = Date.now();
      setSpeeds((prev) => {
        const next = { ...prev };
        for (const [jobId, job] of Object.entries(newState.jobs)) {
          if (job.status === "copying") {
            const last = prevCopied.current[jobId];
            if (last) {
              const dt = (now - last.time) / 1000;
              const db = (job.copied ?? 0) - last.bytes;
              if (dt > 0 && db >= 0) next[jobId] = db / dt;
            }
            prevCopied.current[jobId] = { bytes: job.copied ?? 0, time: now };
          } else {
            delete next[jobId];
            delete prevCopied.current[jobId];
          }
        }
        return next;
      });
    });
  }, []);

  if (!state) return <div style={{ padding: 16, color: "#888" }}>Loading...</div>;

  const jobs = Object.entries(state.jobs);
  const hasActivity =
    state.is_copying || state.is_stopping || jobs.some(([, j]) => j.status !== "queued");
  const hasCompleted = jobs.some(
    ([, j]) => j.status === "done" || j.status === "error" || j.status === "cancelled"
  );

  if (!hasActivity && jobs.length === 0) {
    return (
      <div style={{ padding: 16, color: "#888", fontSize: 13 }}>
        No copy in progress.
      </div>
    );
  }

  const { rows, groupSpeed } = buildDisplayRows(state.jobs, speeds);

  // Defaults on (alphabetical); settings panel writes these on load/toggle.
  const sortCompletedAlpha = (window as any).__copydeck_sort_completed_alpha !== false;
  const sortQueuedAlpha = (window as any).__copydeck_sort_queued_alpha !== false;

  const byName = (a: DisplayRow, b: DisplayRow) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

  const completedRows = rows
    .filter((r) => r.status === "done" || r.status === "error" || r.status === "cancelled")
    .sort((a, b) =>
      sortCompletedAlpha
        ? byName(a, b)
        : (a.completedSeq - b.completedSeq) || (a.orderIndex - b.orderIndex)
    );
  // Currently copying / paused — keep copying before paused, then alpha within
  const activeRows = rows
    .filter((r) => r.status === "copying" || r.status === "paused")
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "copying" ? -1 : 1;
      return byName(a, b);
    });
  const queuedRows = rows
    .filter((r) => r.status === "queued")
    .sort((a, b) =>
      sortQueuedAlpha ? byName(a, b) : a.orderIndex - b.orderIndex
    );

  const statusColor: Record<string, string> = {
    copying: "#4c6ef5", paused: "#f0a500", done: "#40c057",
    cancelled: "#f0a500", error: "#fa5252", queued: "#888",
  };

  // Compact row buttons — Deck's DialogButton defaults are too tall/wide for cards
  const rowBtnBase: CSSProperties = {
    fontSize: 11,
    padding: "3px 6px",
    minHeight: 0,
    minWidth: 0,
    height: 28,
    width: "100%",
    boxSizing: "border-box",
  };
  const queueRemoveBtn: CSSProperties = {
    ...rowBtnBase,
    width: 78,
    maxWidth: 78,
    flexShrink: 0,
    background: "#3a1a1a",
    color: "#fa5252",
  };

  return (
    <Focusable
      style={{ padding: "8px 12px" }}
      navEntryPreferPosition={NavEntryPositionPreferences.FIRST}
      focusWithinClassName="copydeck-batch-focus"
    >
      <style>{`
        .copydeck-batch-focus { outline: 2px solid rgba(255,255,255,0.7); outline-offset: 2px; background: rgba(76, 110, 245, 0.15); border-radius: 6px; }
        .copydeck-btn-focus { outline: 2px solid rgba(255,255,255,0.8) !important; outline-offset: 2px !important; background: rgba(76, 110, 245, 0.4) !important; border-radius: 4px; box-shadow: 0 0 0 1px rgba(255,255,255,0.3); }
        .copydeck-queue-row-focus { outline: 2px solid rgba(255,255,255,0.8) !important; outline-offset: 2px !important; background: rgba(76, 110, 245, 0.35) !important; border-radius: 4px; }
      `}</style>

      {completedRows.length > 0 && (
        <>
          <Focusable
            onActivate={() => setCompletedOpen((v) => !v)}
            noFocusRing={false}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "6px 8px", marginBottom: completedOpen ? 6 : 10,
              background: "#1a1a1a", borderRadius: 4, cursor: "pointer",
            }}
            focusClassName="copydeck-queue-row-focus"
            focusWithinClassName="copydeck-queue-row-focus"
          >
            <span style={{ fontSize: 11, color: "#aaa", textTransform: "uppercase", letterSpacing: 1 }}>
              Completed ({completedRows.length})
            </span>
            <span style={{ fontSize: 11, color: "#888" }}>{completedOpen ? "▲" : "▼"}</span>
          </Focusable>
          {completedOpen && completedRows.map((row) => {
            const statusColorStr = statusColor[row.status] ?? "#888";
            return (
              <Focusable
                key={row.key}
                onActivate={async () => {
                  const id = row.isFileOp ? row.groupId : row.appid;
                  if (!id) return;
                  await clearCompletedJob(id);
                  await forceRefresh();
                }}
                onOKActionDescription="Clear"
                noFocusRing={false}
                style={{
                  marginBottom: 6, padding: "8px 10px",
                  background: "#151520", borderRadius: 4,
                  borderLeft: `3px solid ${statusColorStr}`,
                }}
                focusClassName="copydeck-queue-row-focus"
                focusWithinClassName="copydeck-queue-row-focus"
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontSize: 12 }}>{row.name}</span>
                  <span style={{ fontSize: 11, color: statusColorStr, flexShrink: 0 }}>
                    {row.stage || row.status}
                  </span>
                </div>
                {row.destPath && (
                  <div style={{
                    fontSize: 10, color: "#666", marginTop: 2,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {row.destPath}
                  </div>
                )}
                {row.total > 0 && (
                  <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>
                    {formatBytes(row.total)}
                  </div>
                )}
                {row.error && (
                  <div style={{ fontSize: 11, color: "#fa5252", marginTop: 4 }}>
                    {row.error}
                  </div>
                )}
              </Focusable>
            );
          })}
        </>
      )}

      {activeRows.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: "#aaa", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, marginTop: completedRows.length > 0 ? 4 : 0 }}>
            Copying
          </div>
          {activeRows.map((row) => {
            const pct = row.total > 0 ? Math.round((row.copied / row.total) * 100) : 0;
            const statusColorStr = statusColor[row.status] ?? "#888";
            const spd = row.isFileOp
              ? (groupSpeed[row.groupId!] ?? 0)
              : (speeds[row.appid!] ?? 0);

            return (
              <div
                key={row.key}
                style={{
                  marginBottom: 10, padding: "8px 10px",
                  background: row.status === "paused" ? "#2a2a1a" : "#1a1a2e",
                  borderRadius: 4, borderLeft: `3px solid ${statusColorStr}`,
                  width: "100%", maxWidth: "100%", boxSizing: "border-box",
                  overflow: "hidden",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, gap: 8 }}>
                  <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.name}</span>
                  <span style={{ fontSize: 11, color: statusColorStr, flexShrink: 0 }}>
                    {row.stage || row.status}
                  </span>
                </div>

                {row.status === "copying" && (
                  <>
                    <ProgressBar nProgress={pct} />
                    <div style={{ fontSize: 10, color: "#888", marginTop: 2, display: "flex", justifyContent: "space-between" }}>
                      <span>
                        {formatBytes(row.copied)} / {formatBytes(row.total)} ({pct}%)
                      </span>
                      {spd > 0 && (
                        <span style={{ color: "#4c6ef5" }}>{formatSpeed(spd)}</span>
                      )}
                    </div>
                    <Focusable
                      flow-children="right"
                      style={{ display: "flex", gap: 6, marginTop: 8, width: "100%", maxWidth: "100%", boxSizing: "border-box" }}
                    >
                      <Focusable style={{ flex: 1, minWidth: 0 }} focusClassName="copydeck-btn-focus" focusWithinClassName="copydeck-btn-focus">
                        <DialogButton
                          onClick={async () => {
                            if (row.isFileOp) { await pauseGroup(row.groupId!); }
                            else { await pauseCopy(row.appid!); }
                            await forceRefresh();
                          }}
                          style={{ ...rowBtnBase, background: "#2a2a3a", color: "#f0a500" }}
                        >
                          ⏸ Pause
                        </DialogButton>
                      </Focusable>
                      <Focusable style={{ flex: 1, minWidth: 0 }} focusClassName="copydeck-btn-focus" focusWithinClassName="copydeck-btn-focus">
                        <DialogButton
                          onClick={() => confirmAndCancelJob(row)}
                          style={{ ...rowBtnBase, background: "#3a1a1a", color: "#fa5252" }}
                        >
                          ✕ Cancel
                        </DialogButton>
                      </Focusable>
                    </Focusable>
                  </>
                )}

                {row.status === "paused" && (
                  <>
                    <div style={{ fontSize: 11, color: "#f0a500", marginBottom: 6 }}>
                      {row.stage ?? "Paused"}
                    </div>
                    {row.pause_reason && (
                      <div style={{ fontSize: 10, color: "#aaa", marginBottom: 8 }}>
                        {row.pause_reason}
                      </div>
                    )}
                    <Focusable
                      flow-children="right"
                      style={{ display: "flex", gap: 6, marginTop: 4, width: "100%", maxWidth: "100%", boxSizing: "border-box" }}
                    >
                      <Focusable style={{ flex: 1, minWidth: 0 }} focusClassName="copydeck-btn-focus" focusWithinClassName="copydeck-btn-focus">
                        <DialogButton
                          onClick={async () => {
                            if (row.isFileOp) { await resumeGroup(row.groupId!); }
                            else { await resumeCopy(row.appid!); }
                            await forceRefresh();
                          }}
                          style={{ ...rowBtnBase, background: "#1a3a1a", color: "#40c057" }}
                        >
                          ▶ Resume
                        </DialogButton>
                      </Focusable>
                      <Focusable style={{ flex: 1, minWidth: 0 }} focusClassName="copydeck-btn-focus" focusWithinClassName="copydeck-btn-focus">
                        <DialogButton
                          onClick={() => confirmAndCancelJob(row)}
                          style={{ ...rowBtnBase, background: "#3a1a1a", color: "#fa5252" }}
                        >
                          ✕ Cancel
                        </DialogButton>
                      </Focusable>
                    </Focusable>
                  </>
                )}

                {row.error && (
                  <div style={{ fontSize: 11, color: "#fa5252", marginTop: 4 }}>
                    {row.error}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      {queuedRows.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: "#aaa", textTransform: "uppercase", letterSpacing: 1, margin: "10px 0 6px" }}>
            Queued ({queuedRows.length})
          </div>
          {queuedRows.map((row) => (
            <Focusable
              key={row.key}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                padding: "6px 10px", marginBottom: 4, background: "#1a1a1a",
                borderRadius: 4, borderLeft: "3px solid #444",
                width: "100%", maxWidth: "100%", boxSizing: "border-box",
              }}
              focusClassName="copydeck-queue-row-focus"
              focusWithinClassName="copydeck-queue-row-focus"
            >
              <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {row.name}
                </div>
                <div style={{ fontSize: 10, color: "#888" }}>
                  {row.total > 0 ? formatBytes(row.total) : "Waiting..."}
                </div>
              </div>
              <Focusable style={{ flexShrink: 0, width: 78 }} focusWithinClassName="copydeck-btn-focus">
                <DialogButton
                  onClick={async () => {
                    if (row.isFileOp && row.groupId) {
                      await removeGroupFromQueue(row.groupId);
                    } else {
                      await removeFromQueue(row.appid!);
                    }
                    await forceRefresh();
                  }}
                  style={queueRemoveBtn}
                >
                  ✕ Remove
                </DialogButton>
              </Focusable>
            </Focusable>
          ))}
        </>
      )}

      {(state.is_copying || activeRows.length > 0 || queuedRows.length > 0) && (
        <Focusable style={{ marginTop: 10 }} focusWithinClassName="copydeck-btn-focus">
          <DialogButton
            onClick={() => confirmAndCancelAll()}
            style={{ background: "#5a0000", color: "#fa5252", width: "100%", fontSize: 12 }}
          >
            ✕ Cancel All
          </DialogButton>
        </Focusable>
      )}

      {hasCompleted && (
        <Focusable style={{ marginTop: 8 }} focusWithinClassName="copydeck-btn-focus">
          <DialogButton
            onClick={async () => { await clearCompletedProgress(); await forceRefresh(); }}
            style={{ background: "#2a2a3a", color: "#ccc", width: "100%", fontSize: 12 }}
          >
            Clear Completed
          </DialogButton>
        </Focusable>
      )}
    </Focusable>
  );
}
