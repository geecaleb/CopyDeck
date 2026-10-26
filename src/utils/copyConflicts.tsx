import { showModal, ModalRoot, DialogBody, DialogFooter, DialogButton, Focusable } from "@decky/ui";
import { checkFileOpConflicts } from "./backendApi";

export type ConflictMode = "skip" | "overwrite";

/** Ask Skip / Overwrite / Cancel. Resolves null if the user cancels. */
export function promptCopyConflicts(): Promise<ConflictMode | null> {
  return new Promise((resolve) => {
    const finish = (mode: ConflictMode | null, closeModal?: () => void) => {
      closeModal?.();
      resolve(mode);
    };
    const ConflictModal = ({ closeModal }: { closeModal?: () => void }) => (
      <ModalRoot onCancel={() => finish(null, closeModal)}>
        <DialogBody>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Duplicate files found</div>
          <div style={{ fontSize: 13, color: "#aaa", marginBottom: 4 }}>
            Would you like to skip all duplicates or overwrite all?
          </div>
          <div style={{ fontSize: 11, color: "#666" }}>
            Folders are always written into (merged). Skip leaves finished files and continues partial ones; Overwrite replaces conflicting files.
          </div>
        </DialogBody>
        <DialogFooter>
          <Focusable flow-children="right" style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <DialogButton
              style={{ padding: "6px 12px", fontSize: 13, minHeight: 0 }}
              onClick={() => finish("skip", closeModal)}
            >
              Skip
            </DialogButton>
            <DialogButton
              className="Primary"
              style={{ padding: "6px 12px", fontSize: 13, minHeight: 0 }}
              onClick={() => finish("overwrite", closeModal)}
            >
              Overwrite
            </DialogButton>
            <DialogButton
              style={{ padding: "6px 12px", fontSize: 13, minHeight: 0 }}
              onClick={() => finish(null, closeModal)}
            >
              Cancel
            </DialogButton>
          </Focusable>
        </DialogFooter>
      </ModalRoot>
    );
    showModal(<ConflictModal />, window);
  });
}

/**
 * If any dest files already exist, prompt Skip/Overwrite.
 * Returns "skip" | "overwrite", or null if cancelled.
 * When there are no conflicts, returns "skip" (resume / continue behavior).
 */
export async function resolveConflictMode(
  jobs: Array<{ src: string; dst_dir: string }>,
): Promise<ConflictMode | null> {
  const valid = jobs.filter((j) => j.src && j.dst_dir);
  if (valid.length === 0) return "skip";
  try {
    const check = await checkFileOpConflicts(valid);
    if (!check.has_conflicts) return "skip";
  } catch {
    return "skip";
  }
  return promptCopyConflicts();
}
