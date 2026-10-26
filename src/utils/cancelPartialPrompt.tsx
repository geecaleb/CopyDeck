import { showModal, ModalRoot, DialogBody, DialogFooter, DialogButton, Focusable } from "@decky/ui";

/** Keep leftover files, or delete the destination partial after cancel. null = dismiss (don't cancel). */
export type CancelPartialChoice = "keep" | "remove";

/**
 * Ask whether to keep or remove the partial destination when cancelling a copy.
 * Resolves null if the user backs out (cancel is aborted).
 */
export function promptCancelPartial(opts?: {
  title?: string;
  body?: string;
}): Promise<CancelPartialChoice | null> {
  const title = opts?.title ?? "Cancel copy?";
  const body = opts?.body
    ?? "A partial copy may already be on the destination. Keep it (you can resume later with Skip) or remove it?";

  return new Promise((resolve) => {
    const finish = (choice: CancelPartialChoice | null, closeModal?: () => void) => {
      closeModal?.();
      resolve(choice);
    };
    const CancelPartialModal = ({ closeModal }: { closeModal?: () => void }) => (
      <ModalRoot onCancel={() => finish(null, closeModal)}>
        <DialogBody>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{title}</div>
          <div style={{ fontSize: 13, color: "#aaa", marginBottom: 4 }}>{body}</div>
        </DialogBody>
        <DialogFooter>
          <Focusable flow-children="right" style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <DialogButton
              style={{ padding: "6px 12px", fontSize: 13, minHeight: 0 }}
              onClick={() => finish("keep", closeModal)}
            >
              Keep partial
            </DialogButton>
            <DialogButton
              className="Primary"
              style={{ padding: "6px 12px", fontSize: 13, minHeight: 0, background: "#5a0000", color: "#fa5252" }}
              onClick={() => finish("remove", closeModal)}
            >
              Remove partial
            </DialogButton>
            <DialogButton
              style={{ padding: "6px 12px", fontSize: 13, minHeight: 0 }}
              onClick={() => finish(null, closeModal)}
            >
              Back
            </DialogButton>
          </Focusable>
        </DialogFooter>
      </ModalRoot>
    );
    showModal(<CancelPartialModal />, window);
  });
}
