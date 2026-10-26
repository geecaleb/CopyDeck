/** Best-effort bridge between Steam's gamepad keyboard and plugin text state. */

export type SteamKeyboardBridge = {
  /** Push the current buffer into Steam's gamepad keyboard (opens or refreshes it when supported). */
  pushToKeyboard: (text: string) => void;
  dispose: () => void;
};

function tryUnregister(u: unknown) {
  try {
    if (u && typeof (u as { unregister?: () => void }).unregister === "function")
      (u as { unregister: () => void }).unregister();
  } catch {
    /* ignore */
  }
}

export function attachSteamGamepadKeyboard(
  getText: () => string,
  setText: (t: string) => void,
): SteamKeyboardBridge {
  const input = (window as any).SteamClient?.Input;
  const browser = (window as any).SteamClient?.Browser;
  const disposers: Array<() => void> = [];

  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* SteamClient shape varies by channel */
    }
  };

  safe(() => browser?.NotifyUserActivation?.());

  if (input?.RegisterForGameKeyboardMessages) {
    try {
      const u = input.RegisterForGameKeyboardMessages((msg: any) => {
        if (msg?.m_bOpen && typeof msg.m_pchExistingText === "string") setText(msg.m_pchExistingText);
      });
      disposers.push(() => tryUnregister(u));
    } catch {
      /* ignore */
    }
  }

  if (input?.RegisterForUserDismissKeyboardMessages) {
    try {
      const u = input.RegisterForUserDismissKeyboardMessages((p: any) => {
        if (typeof p === "string") setText(p);
        else if (p && typeof p === "object") {
          if (typeof p.text === "string") setText(p.text);
          else if (typeof p.value === "string") setText(p.value);
          else if (typeof p.strText === "string") setText(p.strText);
        }
      });
      disposers.push(() => tryUnregister(u));
    } catch {
      /* ignore */
    }
  }

  const regUk = input?.RegisterForUserKeyboardMessages;
  if (typeof regUk === "function") {
    try {
      const u = regUk((p: any) => {
        if (typeof p === "string") setText(p);
        else if (p?.text != null) setText(String(p.text));
      });
      disposers.push(() => tryUnregister(u));
    } catch {
      /* ignore */
    }
  }

  const pushToKeyboard = (text: string) => {
    safe(() => browser?.NotifyUserActivation?.());
    safe(() => input?.SetGamepadKeyboardText?.(true, text));
    safe(() => input?.SetGamepadKeyboardText?.(false, text));
    safe(() => input?.SetGamepadKeyboardText?.(true, getText()));
  };

  return {
    pushToKeyboard,
    dispose: () => {
      for (const d of disposers) safe(d);
    },
  };
}
