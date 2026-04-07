import { useEffect, useState } from "react";
import { normalizeCommandName } from "@collab/shared/path-utils";
import "./App.css";

interface TerminalEntry {
  sessionId: string;
  displayName: string;
  commandName: string;
  cwd: string;
  foreground: string | null;
  tileId: string;
}

function isIdle(entry: TerminalEntry): boolean {
  if (!entry.foreground) return true;
  const foreground = normalizeCommandName(entry.foreground);
  if (foreground === entry.commandName) return true;
  if (
    entry.commandName === "wsl" &&
    foreground === normalizeCommandName(entry.displayName)
  ) {
    return true;
  }
  return false;
}

function isTerminalEntry(value: unknown): value is TerminalEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.sessionId === "string"
    && typeof entry.displayName === "string"
    && typeof entry.commandName === "string"
    && typeof entry.cwd === "string"
    && typeof entry.tileId === "string"
    && (entry.foreground === null || typeof entry.foreground === "string");
}

function dedupeEntries(entries: TerminalEntry[]): TerminalEntry[] {
  const byTileId = new Map<string, TerminalEntry>();
  for (const entry of entries) {
    byTileId.set(entry.tileId, entry);
  }
  return [...byTileId.values()];
}

function App() {
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [focusedSessionId, setFocusedSessionId] =
    useState<string | null>(null);
  const [ccWaiting, setCcWaiting] = useState<Set<string>>(new Set());
  const [ccWaitingAt, setCcWaitingAt] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    // Listen for messages from the shell renderer via webview.send()
    // These arrive on ipcRenderer.on() in the universal preload,
    // exposed via window.api.onTerminalListMessage.
    const cleanup = window.api.onTerminalListMessage(
      (channel: string, ...args: unknown[]) => {
        if (channel === "terminal-list:init") {
          const sessions = Array.isArray(args[0])
            ? args[0].filter(isTerminalEntry)
            : [];
          setEntries(dedupeEntries(sessions));
        } else if (channel === "terminal-list:add") {
          const entry = args[0];
          if (!isTerminalEntry(entry)) return;
          setEntries((prev) =>
            dedupeEntries([...prev.filter((e) => e.tileId !== entry.tileId), entry])
          );
        } else if (channel === "terminal-list:remove") {
          const sessionId = args[0] as string;
          setEntries((prev) =>
            prev.filter((e) => e.sessionId !== sessionId),
          );
          setCcWaiting((prev) => {
            const next = new Set(prev);
            next.delete(sessionId);
            return next;
          });
        } else if (channel === "terminal-list:focus") {
          const sessionId = args[0] as string | null;
          setFocusedSessionId(sessionId);
        } else if (channel === "pty-status-changed") {
          const payload = args[0] as {
            sessionId: string;
            foreground: string;
          };
          setEntries((prev) =>
            prev.map((e) =>
              e.sessionId === payload.sessionId
                ? { ...e, foreground: payload.foreground }
                : e,
            ),
          );
        } else if (channel === "cc-attention") {
          const payload = args[0] as { sessionId: string; waiting: boolean };
          setCcWaiting((prev) => {
            const next = new Set(prev);
            if (payload.waiting) next.add(payload.sessionId);
            else next.delete(payload.sessionId);
            return next;
          });
          if (payload.waiting) {
            setCcWaitingAt((prev) => {
              const next = new Map(prev);
              next.set(payload.sessionId, Date.now());
              return next;
            });
          }
        } else if (channel === "pty-exit") {
          const payload = args[0] as { sessionId: string };
          setEntries((prev) =>
            prev.filter((e) => e.sessionId !== payload.sessionId),
          );
          setCcWaiting((prev) => {
            const next = new Set(prev);
            next.delete(payload.sessionId);
            return next;
          });
        }
      },
    );

    return cleanup;
  }, []);

  function peekTile(sessionId: string) {
    setFocusedSessionId(sessionId);
    window.api.sendToHost("terminal-list:peek-tile", sessionId);
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (entries.length === 0) return;

      e.preventDefault();

      const dir = e.key === "ArrowUp" ? -1 : 1;
      const currentIdx = entries.findIndex(
        (entry) => entry.sessionId === focusedSessionId,
      );
      const nextIdx =
        currentIdx < 0
          ? 0
          : (currentIdx + dir + entries.length) % entries.length;

      peekTile(entries[nextIdx].sessionId);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [entries, focusedSessionId]);

  return (
    <div className="terminal-list">
      <div className="terminal-list-header">Terminals</div>
      {entries.map((entry) => {
        const idle = isIdle(entry);
        const waiting = ccWaiting.has(entry.sessionId);
        const focused = entry.sessionId === focusedSessionId;
        const stateClass = idle ? "idle" : "busy";
        const dotClass = waiting ? "cc-waiting" : stateClass;
        const classes = [
          "terminal-entry",
          stateClass,
          focused ? "focused" : "",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <div
            key={entry.tileId}
            className={classes}
            onClick={() => peekTile(entry.sessionId)}
          >
            <div
              className={`status-dot ${dotClass}`}
              style={waiting ? { animationDelay: `${-(( ccWaitingAt.get(entry.sessionId) ?? Date.now()) % 2000)}ms` } : undefined}
            />
            <div className="entry-info">
              <div className="entry-top">
                <span className="shell-name">
                  {entry.displayName}
                </span>
                <span className="status-label">
                  {idle
                    ? "idle"
                    : entry.foreground || "running"}
                </span>
              </div>
              <div className="entry-cwd">
                {entry.cwd}
              </div>
            </div>
          </div>
        );
      })}
      {entries.length === 0 && (
        <div
          style={{
            padding: "12px",
            color: "var(--muted, #666)",
            fontSize: "11px",
          }}
        >
          No terminals open
        </div>
      )}
    </div>
  );
}

export default App;
