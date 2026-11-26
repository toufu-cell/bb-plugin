import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { experimental_Icon as Icon, experimental_usePluginId, useSdk } from "@get-bb/plugin-sdk/app";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { DOCK_ATTRIBUTE, MIN_CHAT_HEIGHT, MIN_DOCK_HEIGHT } from "./dock-host";
import {
    closeDock,
    setDockHeight,
    takeFocusRequest,
    takeStartRequest,
    useDockState,
    type FocusRequest,
} from "./dock-store";
import { ensureSession, findSession, forgetSession, isNotFound, replaceExitedSession } from "./sessions";
import {
    TERMINAL_COLS_MAX,
    TERMINAL_ROWS_MAX,
    TerminalSocket,
    decodeBase64,
    encodeInputChunks,
    terminalSocketUrl,
    type TerminalSessionStatus,
} from "./socket";

const RESIZE_STEP = 16;
const RESIZE_STEP_LARGE = 64;
const RECONNECT_MAX_DELAY_MS = 10_000;
// bb's terminal panel uses the same fallback when --font-terminal is unset.
const TERMINAL_FONT_FAMILY =
    '"JetBrainsMono Nerd Font Mono", "MesloLGS NF", "Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

type Phase =
    | { readonly kind: "looking" }
    | { readonly kind: "idle" }
    | { readonly kind: "starting" }
    | { readonly kind: "failed"; readonly message: string; readonly retry: "find" | "start" }
    | { readonly kind: "attached"; readonly terminalId: string };

type Connection = "connecting" | "open" | "lost";

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

// Matches bb's terminal panel: theme colors are bb CSS variables.
// A probe element resolves them, because xterm needs concrete colors.
function readTheme(): ITheme {
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement("span");
    probe.style.display = "none";
    document.body.appendChild(probe);
    const read = (name: string): string | undefined => {
        const raw = root.getPropertyValue(name).trim();
        if (raw === "") return undefined;
        probe.style.color = raw;
        return getComputedStyle(probe).color;
    };
    const ansi = (index: number) => read(`--ansi-${index}`);
    const theme: ITheme = {
        background: read("--sidebar"),
        foreground: read("--foreground"),
        cursor: read("--foreground"),
        cursorAccent: read("--sidebar"),
        selectionBackground: read("--muted"),
        selectionInactiveBackground: read("--muted"),
        black: ansi(0),
        red: ansi(1),
        green: ansi(2),
        yellow: ansi(3),
        blue: ansi(4),
        magenta: ansi(5),
        cyan: ansi(6),
        white: ansi(7),
        brightBlack: ansi(8),
        brightRed: ansi(9),
        brightGreen: ansi(10),
        brightYellow: ansi(11),
        brightBlue: ansi(12),
        brightMagenta: ansi(13),
        brightCyan: ansi(14),
        brightWhite: ansi(15),
    };
    probe.remove();
    return theme;
}

function readFontFamily(): string {
    const value = getComputedStyle(document.documentElement).getPropertyValue("--font-terminal").trim();
    return value === "" ? TERMINAL_FONT_FAMILY : value;
}

interface TerminalDockProps {
    readonly host: HTMLElement;
    readonly environmentId: string;
}

/** Appends a plugin-owned panel to the thread page and renders into it. */
export function TerminalDock({ host, environmentId }: TerminalDockProps) {
    const pluginId = experimental_usePluginId();
    const { height } = useDockState();
    const [container, setContainer] = useState<HTMLDivElement | null>(null);
    const [hostHeight, setHostHeight] = useState(() => host.clientHeight);

    useLayoutEffect(() => {
        const element = document.createElement("div");
        element.setAttribute(DOCK_ATTRIBUTE, "");
        element.setAttribute("data-bb-plugin-root", "");
        element.setAttribute("data-bb-plugin", pluginId);
        element.className = "bb-dt-dock";
        host.appendChild(element);
        setContainer(element);
        setHostHeight(host.clientHeight);
        const observer = new ResizeObserver(() => setHostHeight(host.clientHeight));
        observer.observe(host);
        return () => {
            observer.disconnect();
            element.remove();
            setContainer(null);
        };
    }, [host, pluginId]);

    const maxHeight = Math.max(MIN_DOCK_HEIGHT, hostHeight - MIN_CHAT_HEIGHT);
    const dockHeight = clamp(height, MIN_DOCK_HEIGHT, maxHeight);

    useLayoutEffect(() => {
        if (container !== null) container.style.height = `${dockHeight}px`;
    }, [container, dockHeight]);

    if (container === null) return null;
    return createPortal(
        <DockContent environmentId={environmentId} dockHeight={dockHeight} maxHeight={maxHeight} />,
        container,
    );
}

interface DockContentProps {
    readonly environmentId: string;
    readonly dockHeight: number;
    readonly maxHeight: number;
}

function DockContent({ environmentId, dockHeight, maxHeight }: DockContentProps) {
    // Read the SDK client through a ref. A new object identity from the host
    // then never reconnects the socket.
    const sdk = useSdk();
    const terminalsRef = useRef(sdk.terminals);
    terminalsRef.current = sdk.terminals;
    const screenRef = useRef<HTMLDivElement>(null);
    const [view, setView] = useState<Terminal | null>(null);
    const [phase, setPhase] = useState<Phase>({ kind: "looking" });
    const [connection, setConnection] = useState<Connection>("connecting");
    const [sessionStatus, setSessionStatus] = useState<TerminalSessionStatus | null>(null);
    const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
    // Held until the first attach. The screen stays hidden before that, and
    // a hidden xterm cannot take focus.
    const focusRequestRef = useRef<FocusRequest | null>(null);
    // Lookups and starts finish after the user may have hidden the dock or
    // pressed Retry. Only the latest request of a mounted dock updates it.
    const aliveRef = useRef(true);
    const requestRef = useRef(0);
    const beginRequest = () => {
        requestRef.current += 1;
        const token = requestRef.current;
        return () => aliveRef.current && requestRef.current === token;
    };

    useEffect(() => {
        aliveRef.current = true;
        return () => {
            aliveRef.current = false;
        };
    }, []);

    // One xterm per mount. Hiding the dock disposes it; the next mount
    // replays the session's retained output into a fresh one.
    useEffect(() => {
        const screen = screenRef.current;
        if (screen === null) return;
        const terminal = new Terminal({
            convertEol: true,
            cursorBlink: true,
            fontFamily: readFontFamily(),
            fontSize: 12,
            scrollback: 10_000,
            theme: readTheme(),
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(screen);

        let frame = 0;
        const fitToScreen = () => {
            frame = 0;
            const size = fit.proposeDimensions();
            if (size === undefined || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;
            const cols = clamp(Math.floor(size.cols), 1, TERMINAL_COLS_MAX);
            const rows = clamp(Math.floor(size.rows), 1, TERMINAL_ROWS_MAX);
            if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows);
        };
        fitToScreen();
        const resizeObserver = new ResizeObserver(() => {
            if (frame === 0) frame = requestAnimationFrame(fitToScreen);
        });
        resizeObserver.observe(screen);

        // Follow theme switches, which bb applies on the root element.
        let themeKey = JSON.stringify(terminal.options.theme);
        const themeObserver = new MutationObserver(() => {
            const theme = readTheme();
            const nextKey = JSON.stringify(theme);
            if (nextKey !== themeKey) {
                themeKey = nextKey;
                terminal.options.theme = theme;
            }
            const fontFamily = readFontFamily();
            if (fontFamily !== terminal.options.fontFamily) terminal.options.fontFamily = fontFamily;
        });
        themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class", "style", "data-theme"],
        });

        focusRequestRef.current = takeFocusRequest();
        setView(terminal);
        return () => {
            if (frame !== 0) cancelAnimationFrame(frame);
            resizeObserver.disconnect();
            themeObserver.disconnect();
            setView(null);
            terminal.dispose();
        };
    }, []);

    // The sessions module records a sent create even when this dock is gone.
    // A later mount then attaches to that shell instead of starting another.
    const start = (terminal: Terminal) => {
        const isCurrent = beginRequest();
        setPhase({ kind: "starting" });
        ensureSession(terminalsRef.current, environmentId, { cols: terminal.cols, rows: terminal.rows }).then(
            (terminalId) => {
                if (isCurrent()) setPhase({ kind: "attached", terminalId });
            },
            () => {
                if (isCurrent()) setPhase({ kind: "failed", message: "Could not start the terminal", retry: "start" });
            },
        );
    };

    const find = (terminal: Terminal) => {
        const isCurrent = beginRequest();
        setPhase({ kind: "looking" });
        findSession(terminalsRef.current, environmentId).then(
            (terminalId) => {
                // A hidden dock must not consume the start request of the
                // dock that replaced it.
                if (!isCurrent()) return;
                // Consume the explicit open either way. A later remount of
                // this environment then never starts a shell on its own.
                const requested = takeStartRequest(environmentId);
                if (terminalId !== null) setPhase({ kind: "attached", terminalId });
                else if (requested) start(terminal);
                else setPhase({ kind: "idle" });
            },
            () => {
                if (isCurrent()) setPhase({ kind: "failed", message: "Could not reach the terminal", retry: "find" });
            },
        );
    };

    useEffect(() => {
        if (view !== null) find(view);
        // `find` is recreated every render; depending on it would look the
        // session up again each time.
    }, [view, environmentId]);

    const terminalId = phase.kind === "attached" ? phase.terminalId : null;

    useEffect(() => {
        if (view === null || terminalId === null) return;
        const terminal = view;
        let disposed = false;
        let socket: TerminalSocket | null = null;
        // Next output seq this xterm has not written yet.
        let cursor = 0;
        // Output below this seq is retained history being replayed.
        let replayUntil = 0;
        // Replayed writes still being parsed. Their terminal queries must not
        // reach the PTY as if the user had typed the answers.
        let pendingReplayWrites = 0;
        let status: TerminalSessionStatus | null = null;
        let sentSize = "";
        let attempts = 0;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;

        terminal.reset();
        setConnection("connecting");
        setSessionStatus(null);

        const applyStatus = (next: TerminalSessionStatus) => {
            status = next;
            setSessionStatus(next);
        };

        const sendSize = () => {
            if (socket === null || !socket.ready()) return;
            const size = `${terminal.cols}x${terminal.rows}`;
            if (size === sentSize) return;
            sentSize = size;
            socket.sendResize(terminal.cols, terminal.rows);
        };

        const focusIfRequested = () => {
            const request = focusRequestRef.current;
            if (request === null) return;
            focusRequestRef.current = null;
            // Wait a frame so the attached state has made the screen visible.
            requestAnimationFrame(() => {
                const screen = screenRef.current;
                if (disposed || screen === null || getComputedStyle(screen).visibility !== "visible") return;
                const active = document.activeElement;
                const dock = screen.closest(`[${DOCK_ATTRIBUTE}]`);
                const focusMoved =
                    active !== null &&
                    active !== document.body &&
                    active !== request.origin &&
                    !(dock?.contains(active) ?? false);
                if (!focusMoved) terminal.focus();
            });
        };

        const scheduleReconnect = () => {
            const delay = Math.min(1000 * 2 ** attempts, RECONNECT_MAX_DELAY_MS);
            attempts += 1;
            retryTimer = setTimeout(() => {
                retryTimer = null;
                terminalsRef.current.get({ terminalId }).then(
                    (session) => {
                        if (disposed) return;
                        if (session.status === "exited") {
                            applyStatus("exited");
                            return;
                        }
                        applyStatus(session.status);
                        connect();
                    },
                    (error: unknown) => {
                        if (disposed) return;
                        if (isNotFound(error)) {
                            forgetSession(environmentId, terminalId);
                            setPhase({ kind: "idle" });
                            return;
                        }
                        scheduleReconnect();
                    },
                );
            }, delay);
        };

        const connect = () => {
            // Every handler ignores a socket that has been replaced. A late
            // event from it then never reaches this xterm.
            const own: TerminalSocket = new TerminalSocket(terminalSocketUrl(terminalId, cursor), {
                onAttached(info) {
                    if (socket !== own) return;
                    attempts = 0;
                    // A fresh xterm, or a ring buffer that moved past our
                    // cursor, redraws from the oldest retained chunk.
                    if (cursor === 0 || info.replayStartSeq > cursor) {
                        if (cursor !== 0) terminal.reset();
                        cursor = info.replayStartSeq;
                    }
                    replayUntil = info.nextSeq;
                    sentSize = info.cols !== null && info.rows !== null ? `${info.cols}x${info.rows}` : "";
                    applyStatus(info.status);
                    setConnection("open");
                    sendSize();
                    focusIfRequested();
                },
                onOutput(seq, dataBase64) {
                    if (socket !== own || seq < cursor) return;
                    cursor = seq + 1;
                    const bytes = decodeBase64(dataBase64);
                    if (seq < replayUntil) {
                        pendingReplayWrites += 1;
                        terminal.write(bytes, () => {
                            pendingReplayWrites -= 1;
                        });
                    } else {
                        terminal.write(bytes);
                    }
                },
                onStatus(next) {
                    if (socket !== own) return;
                    const previous = status;
                    applyStatus(next);
                    if (previous !== "disconnected" || next !== "running") return;
                    // After a host reconnect, bb sends the missed output as
                    // live output right after this update. A socket opened
                    // while disconnected also lacks resize rights. Attach
                    // again from the cursor, so the catch-up is replayed
                    // muted and resize works. Input waits for that attach.
                    own.dispose();
                    socket = null;
                    setConnection("connecting");
                    connect();
                },
                onExited() {
                    if (socket === own) applyStatus("exited");
                },
                onGone(code) {
                    if (socket !== own) return;
                    if (code === "terminal_not_found") {
                        forgetSession(environmentId, terminalId);
                        setPhase({ kind: "idle" });
                        return;
                    }
                    applyStatus("exited");
                },
                onClosed() {
                    if (disposed || socket !== own) return;
                    setConnection("lost");
                    scheduleReconnect();
                },
            });
            socket = own;
        };

        const dataSubscription = terminal.onData((data) => {
            if (pendingReplayWrites > 0 || status !== "running" || socket === null || !socket.ready()) return;
            for (const chunk of encodeInputChunks(data)) socket.sendInput(chunk);
        });
        const resizeSubscription = terminal.onResize(sendSize);

        connect();
        return () => {
            disposed = true;
            if (retryTimer !== null) clearTimeout(retryTimer);
            socket?.dispose();
            dataSubscription.dispose();
            resizeSubscription.dispose();
        };
    }, [view, terminalId, environmentId]);

    // The exited socket is already closed. Leaving the attached phase also
    // disposes the connection before the replacement shell is created.
    const restart = (terminal: Terminal) => {
        if (terminalId === null) return;
        const isCurrent = beginRequest();
        setPhase({ kind: "starting" });
        replaceExitedSession(terminalsRef.current, environmentId, terminalId, {
            cols: terminal.cols,
            rows: terminal.rows,
        }).then(
            (nextId) => {
                if (isCurrent()) setPhase({ kind: "attached", terminalId: nextId });
            },
            () => {
                if (isCurrent()) setPhase({ kind: "failed", message: "Could not start the terminal", retry: "start" });
            },
        );
    };

    const resizeTo = (next: number) => setDockHeight(clamp(Math.round(next), MIN_DOCK_HEIGHT, maxHeight));

    const onResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: dockHeight };
    };
    const onResizePointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId) return;
        resizeTo(drag.startHeight + drag.startY - event.clientY);
    };
    const onResizePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    };
    const onResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP;
        if (event.key === "ArrowUp") resizeTo(dockHeight + step);
        else if (event.key === "ArrowDown") resizeTo(dockHeight - step);
        else return;
        event.preventDefault();
    };

    let note: string | null = null;
    let action: { label: string; run: () => void } | null = null;
    switch (phase.kind) {
        case "looking":
            break;
        case "idle":
            if (view !== null) {
                const terminal = view;
                action = { label: "Start terminal", run: () => start(terminal) };
            }
            break;
        case "starting":
            note = "Starting…";
            break;
        case "failed":
            note = phase.message;
            if (view !== null) {
                const terminal = view;
                const retry = phase.retry;
                action = { label: "Retry", run: () => (retry === "start" ? start(terminal) : find(terminal)) };
            }
            break;
        case "attached":
            if (sessionStatus === "exited") {
                note = "Shell exited";
                if (view !== null) {
                    const terminal = view;
                    action = { label: "Restart", run: () => restart(terminal) };
                }
            } else if (connection === "lost" || sessionStatus === "disconnected") {
                note = "Reconnecting…";
            } else if (connection === "connecting") {
                note = "Connecting…";
            } else if (sessionStatus === "starting") {
                note = "Starting…";
            }
            break;
        default: {
            const unreachable: never = phase;
            return unreachable;
        }
    }

    return (
        <>
            <div
                className="bb-dt-resize"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize terminal"
                aria-valuemin={MIN_DOCK_HEIGHT}
                aria-valuemax={maxHeight}
                aria-valuenow={dockHeight}
                tabIndex={0}
                onPointerDown={onResizePointerDown}
                onPointerMove={onResizePointerMove}
                onPointerUp={onResizePointerEnd}
                onPointerCancel={onResizePointerEnd}
                onKeyDown={onResizeKeyDown}
            />
            <div className="bb-dt-header">
                <span className="bb-dt-title">Terminal</span>
                {note !== null ? (
                    <span className="bb-dt-note" role="status">
                        {note}
                    </span>
                ) : null}
                {action !== null ? (
                    <button type="button" className="bb-dt-button" onClick={action.run}>
                        {action.label}
                    </button>
                ) : null}
                <button type="button" className="bb-dt-button bb-dt-close" aria-label="Hide terminal" title="Hide terminal" onClick={closeDock}>
                    <Icon name="X" aria-hidden />
                </button>
            </div>
            <div className="bb-dt-body">
                <div ref={screenRef} className="bb-dt-screen" data-active={terminalId !== null ? "true" : "false"} />
            </div>
        </>
    );
}
