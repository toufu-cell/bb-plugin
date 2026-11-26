// One connection to a bb terminal session over the same-origin
// `/ws/terminals/:id` socket that bb's own terminal panel uses. The page is
// bb's, so the socket carries the signed-in session and passes bb's origin
// check without a separate server.
//
// The URL scheme, heartbeat, and message handling are adapted from
// bb-plugin-floating-terminal lib/socket.ts (commit 5f2b637):
//
//   MIT License
//
//   Copyright (c) 2026 Vedran Burojević
//
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the
//   "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to permit
//   persons to whom the Software is furnished to do so, subject to the
//   following conditions:
//
//   The above copyright notice and this permission notice shall be included
//   in all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
//   OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
//   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
//   NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
//   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
//   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
//   USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// Output acks (`outputAcks=1`) are not requested: bb then paces output the
// way it does for clients without acks, and a dropped client reconnects from
// its cursor.

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
// bb attaches a running session at once. A disconnected session gets no
// answer, so a socket that never attaches is closed and retried.
const ATTACH_TIMEOUT_MS = 10_000;

// Limits from bb 0.50.1 packages/domain/src/terminal.ts.
export const TERMINAL_COLS_MAX = 500;
export const TERMINAL_ROWS_MAX = 200;
const TERMINAL_DATA_MAX_BYTES = 64 * 1024;

export type TerminalSessionStatus = "starting" | "running" | "disconnected" | "exited";

function isSessionStatus(value: unknown): value is TerminalSessionStatus {
    return value === "starting" || value === "running" || value === "disconnected" || value === "exited";
}

export interface AttachedInfo {
    readonly status: TerminalSessionStatus;
    readonly cols: number | null;
    readonly rows: number | null;
    readonly replayStartSeq: number;
    readonly nextSeq: number;
}

export interface TerminalSocketHandlers {
    onAttached(info: AttachedInfo): void;
    onOutput(seq: number, dataBase64: string): void;
    onStatus(status: TerminalSessionStatus): void;
    onExited(): void;
    /** bb no longer has a running session under this id. */
    onGone(code: "terminal_not_found" | "terminal_not_running" | "terminal_exited"): void;
    /** The connection ended without dispose(). */
    onClosed(): void;
}

export function terminalSocketUrl(terminalId: string, sinceSeq: number): string {
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const id = encodeURIComponent(terminalId);
    return `${scheme}//${window.location.host}/ws/terminals/${id}?sinceSeq=${sinceSeq}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readSession(value: unknown): {
    status: TerminalSessionStatus | null;
    cols: number | null;
    rows: number | null;
} {
    const session = asRecord(value);
    return {
        status: isSessionStatus(session?.status) ? session.status : null,
        cols: typeof session?.cols === "number" ? session.cols : null,
        rows: typeof session?.rows === "number" ? session.rows : null,
    };
}

export class TerminalSocket {
    private readonly socket: WebSocket;
    private readonly handlers: TerminalSocketHandlers;
    private heartbeat: ReturnType<typeof setInterval> | null = null;
    private attachTimer: ReturnType<typeof setTimeout> | null = null;
    private lastPongAt = 0;
    private closed = false;
    private attached = false;

    constructor(url: string, handlers: TerminalSocketHandlers) {
        this.handlers = handlers;
        this.socket = new WebSocket(url);
        this.socket.onopen = () => this.handleOpen();
        this.socket.onmessage = (event) => this.handleMessage(event.data);
        this.socket.onclose = () => this.handleClose();
        this.attachTimer = setTimeout(() => {
            if (!this.attached) this.socket.close(4000, "attach-timeout");
        }, ATTACH_TIMEOUT_MS);
    }

    /** Whether input sent now reaches the PTY. */
    ready(): boolean {
        return !this.closed && this.attached && this.socket.readyState === WebSocket.OPEN;
    }

    sendInput(dataBase64: string): void {
        this.send({ type: "input", dataBase64 });
    }

    sendResize(cols: number, rows: number): void {
        this.send({ type: "resize", cols, rows });
    }

    /** Close without reporting it: the owner chose this. */
    dispose(): void {
        if (this.closed) return;
        this.closed = true;
        this.stopTimers();
        this.socket.onopen = null;
        this.socket.onmessage = null;
        this.socket.onclose = null;
        try {
            this.socket.close();
        } catch {
            // Already closing.
        }
    }

    private send(message: Record<string, unknown>): void {
        if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
        try {
            this.socket.send(JSON.stringify(message));
        } catch {
            // The close handler reports the failure.
        }
    }

    private handleOpen(): void {
        this.lastPongAt = Date.now();
        this.heartbeat = setInterval(() => {
            if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
                // A half-open connection never fires close on its own.
                this.socket.close(4000, "heartbeat-timeout");
                return;
            }
            this.send({ type: "ping" });
        }, HEARTBEAT_INTERVAL_MS);
    }

    private handleMessage(raw: unknown): void {
        if (this.closed || typeof raw !== "string") return;
        let message: Record<string, unknown> | null;
        try {
            message = asRecord(JSON.parse(raw));
        } catch {
            return;
        }
        if (message === null) return;

        switch (message.type) {
            case "pong":
                this.lastPongAt = Date.now();
                return;
            case "attached": {
                const session = readSession(message.session);
                if (
                    session.status === null ||
                    typeof message.replayStartSeq !== "number" ||
                    typeof message.nextSeq !== "number"
                ) {
                    return;
                }
                this.attached = true;
                this.lastPongAt = Date.now();
                if (this.attachTimer !== null) clearTimeout(this.attachTimer);
                this.attachTimer = null;
                this.handlers.onAttached({
                    status: session.status,
                    cols: session.cols,
                    rows: session.rows,
                    replayStartSeq: message.replayStartSeq,
                    nextSeq: message.nextSeq,
                });
                return;
            }
            case "output": {
                const chunk = asRecord(message.chunk);
                if (chunk === null || typeof chunk.seq !== "number" || typeof chunk.dataBase64 !== "string") {
                    return;
                }
                this.handlers.onOutput(chunk.seq, chunk.dataBase64);
                return;
            }
            case "session-updated": {
                const { status } = readSession(message.session);
                if (status !== null) this.handlers.onStatus(status);
                return;
            }
            case "exited":
                this.dispose();
                this.handlers.onExited();
                return;
            case "error": {
                const code = message.code;
                if (code === "terminal_not_found" || code === "terminal_not_running" || code === "terminal_exited") {
                    this.dispose();
                    this.handlers.onGone(code);
                }
                // Other errors are followed by a close, which reports them.
                return;
            }
            default:
                return;
        }
    }

    private handleClose(): void {
        if (this.closed) return;
        this.closed = true;
        this.stopTimers();
        this.handlers.onClosed();
    }

    private stopTimers(): void {
        if (this.heartbeat !== null) clearInterval(this.heartbeat);
        if (this.attachTimer !== null) clearTimeout(this.attachTimer);
        this.heartbeat = null;
        this.attachTimer = null;
    }
}

export function decodeBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

/** Split typed or pasted text into base64 chunks within bb's 64 KiB limit. */
export function encodeInputChunks(value: string): string[] {
    const bytes = new TextEncoder().encode(value);
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += TERMINAL_DATA_MAX_BYTES) {
        const slice = bytes.subarray(offset, Math.min(offset + TERMINAL_DATA_MAX_BYTES, bytes.byteLength));
        let binary = "";
        for (const byte of slice) binary += String.fromCharCode(byte);
        chunks.push(btoa(binary));
    }
    return chunks;
}
