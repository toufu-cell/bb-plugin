// One bb terminal session per environment, shared by every dock mount in this
// window. Hiding the dock only drops the socket. The session keeps running,
// and its id stays here. Reopening attaches to the same PTY.
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

type TerminalsArea = PluginBrowserBbSdk["terminals"];

const CONFIRMED_PREFIX = "bb-plugin-docked-terminal:terminal:";
const RESERVED_PREFIX = "bb-plugin-docked-terminal:reserved:";
const TERMINAL_TITLE = "Bottom Terminal";

// Session id format from bb 0.50.1. The schema is in
// packages/server-contract/src/api/terminals.ts. The alphabet and length are
// in packages/domain/src/raw-thread-id.ts.
const ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
const ID_SUFFIX_LENGTH = 10;

// In-flight or settled lookups keyed by environment id. The map holds the
// promise, not only the result. A remount during creation then waits for it
// instead of starting a second shell.
const requests = new Map<string, Promise<string | null>>();

function track(environmentId: string, request: Promise<string | null>): Promise<string | null> {
    requests.set(environmentId, request);
    const release = () => {
        if (requests.get(environmentId) === request) requests.delete(environmentId);
    };
    request.then((id) => {
        if (id === null) release();
    }, release);
    return request;
}

// Ids live in memory and in sessionStorage. Storage keeps them across a
// plugin reload in this window. Memory still works when storage is blocked.
const memory = new Map<string, string>();

function readId(key: string): string | null {
    try {
        const stored = window.sessionStorage.getItem(key);
        if (stored !== null) return stored;
    } catch {
        // Fall back to memory.
    }
    return memory.get(key) ?? null;
}

function writeId(key: string, id: string): void {
    memory.set(key, id);
    try {
        window.sessionStorage.setItem(key, id);
    } catch {
        // Memory keeps the id for this bundle.
    }
}

function removeId(key: string): void {
    memory.delete(key);
    try {
        window.sessionStorage.removeItem(key);
    } catch {
        // Nothing stored.
    }
}

function generateTerminalId(): string {
    // 256 is a multiple of the 32-letter alphabet, so masking stays uniform.
    const bytes = crypto.getRandomValues(new Uint8Array(ID_SUFFIX_LENGTH));
    let suffix = "";
    for (const byte of bytes) suffix += ID_ALPHABET[byte & 31];
    return `term_${suffix}`;
}

export function isNotFound(error: unknown): boolean {
    // bb's SDK rejects HTTP failures with a BbHttpError that carries `status`.
    return error instanceof Error && "status" in error && error.status === 404;
}

type LookUpResult = "found" | "missing" | "elsewhere";

// Any failure other than 404 rejects, so the caller keeps the id for a retry.
async function lookUp(terminals: TerminalsArea, environmentId: string, terminalId: string): Promise<LookUpResult> {
    try {
        const session = await terminals.get({ terminalId });
        return session.environmentId === environmentId ? "found" : "elsewhere";
    } catch (error) {
        if (isNotFound(error)) return "missing";
        throw error;
    }
}

async function lookUpKnown(terminals: TerminalsArea, environmentId: string): Promise<string | null> {
    const confirmedKey = CONFIRMED_PREFIX + environmentId;
    const confirmedId = readId(confirmedKey);
    if (confirmedId !== null) {
        if ((await lookUp(terminals, environmentId, confirmedId)) === "found") return confirmedId;
        removeId(confirmedKey);
    }
    // A create whose response was lost may still have started the shell.
    // On 404 the reserved id stays, and the next create reuses it.
    const reservedKey = RESERVED_PREFIX + environmentId;
    const reservedId = readId(reservedKey);
    if (reservedId === null) return null;
    const result = await lookUp(terminals, environmentId, reservedId);
    if (result === "elsewhere") removeId(reservedKey);
    if (result !== "found") return null;
    writeId(confirmedKey, reservedId);
    removeId(reservedKey);
    return reservedId;
}

/** The environment's known session id, or null when it has none yet. */
export function findSession(terminals: TerminalsArea, environmentId: string): Promise<string | null> {
    const pending = requests.get(environmentId);
    if (pending !== undefined) return pending;
    if (readId(CONFIRMED_PREFIX + environmentId) === null && readId(RESERVED_PREFIX + environmentId) === null) {
        return Promise.resolve(null);
    }
    return track(environmentId, lookUpKnown(terminals, environmentId));
}

export interface TerminalSize {
    readonly cols: number;
    readonly rows: number;
}

async function create(terminals: TerminalsArea, environmentId: string, size: TerminalSize): Promise<string> {
    // Reserve the id before sending. After a lost response, findSession
    // finds the shell under this id. On a 404, this create reuses the id.
    const reservedKey = RESERVED_PREFIX + environmentId;
    let terminalId = readId(reservedKey);
    if (terminalId === null) {
        terminalId = generateTerminalId();
        writeId(reservedKey, terminalId);
    }
    const session = await terminals.create({
        id: terminalId,
        scope: { kind: "environment", environmentId },
        cols: size.cols,
        rows: size.rows,
        start: { mode: "shell" },
        title: TERMINAL_TITLE,
    });
    if (session.environmentId !== environmentId) {
        throw new Error("The terminal belongs to another environment");
    }
    writeId(CONFIRMED_PREFIX + environmentId, session.id);
    removeId(reservedKey);
    return session.id;
}

/** Reuse the environment's session, or start one shell for it. */
export async function ensureSession(
    terminals: TerminalsArea,
    environmentId: string,
    size: TerminalSize,
): Promise<string> {
    const existing = await findSession(terminals, environmentId);
    if (existing !== null) return existing;
    const request = requests.get(environmentId) ?? track(environmentId, create(terminals, environmentId, size));
    const id = await request;
    if (id === null) throw new Error("The terminal could not be started");
    return id;
}

/**
 * Replace an exited shell with a new one in the same environment. bb's
 * restart cannot take a reserved id, so this goes through the same create.
 */
export function replaceExitedSession(
    terminals: TerminalsArea,
    environmentId: string,
    exitedId: string,
    size: TerminalSize,
): Promise<string> {
    forgetSession(environmentId, exitedId);
    return ensureSession(terminals, environmentId, size);
}

/** Drop an id bb no longer runs, so the next start creates a new shell. */
export function forgetSession(environmentId: string, terminalId: string): void {
    if (readId(CONFIRMED_PREFIX + environmentId) === terminalId) removeId(CONFIRMED_PREFIX + environmentId);
    if (readId(RESERVED_PREFIX + environmentId) === terminalId) removeId(RESERVED_PREFIX + environmentId);
    requests.delete(environmentId);
}
