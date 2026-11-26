// Window-wide dock state. The sidebar footer action runs outside React.
// The open flag lives here, and every thread header row subscribes to it.
import { useSyncExternalStore } from "react";

export const DEFAULT_DOCK_HEIGHT = 240;

export interface DockState {
    readonly open: boolean;
    readonly height: number;
    // The environment the user explicitly opened the dock for. Only that
    // environment may start a shell without a click on Start terminal.
    readonly startEnvironmentId: string | null;
    // Set only by an explicit open from the footer. A thread switch leaves it
    // null, so bb keeps focusing the composer on navigation.
    readonly focusRequest: FocusRequest | null;
}

export interface FocusRequest {
    // What had focus when the user opened the dock, usually the footer
    // button. Focus that moved anywhere else since then is left alone.
    readonly origin: Element | null;
}

let state: DockState = {
    open: false,
    height: DEFAULT_DOCK_HEIGHT,
    startEnvironmentId: null,
    focusRequest: null,
};
const listeners = new Set<() => void>();

function update(patch: Partial<DockState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function getState(): DockState {
    return state;
}

export function useDockState(): DockState {
    return useSyncExternalStore(subscribe, getState, getState);
}

// The environment of the thread on screen, reported by its header row.
// The footer action uses it as the target of an explicit open.
let viewed: { readonly owner: object; readonly environmentId: string | null } | null = null;

export function reportViewedEnvironment(owner: object, environmentId: string | null): void {
    viewed = { owner, environmentId };
}

export function clearViewedEnvironment(owner: object): void {
    if (viewed?.owner === owner) viewed = null;
}

export function toggleDock(): void {
    if (state.open) {
        closeDock();
        return;
    }
    update({
        open: true,
        startEnvironmentId: viewed?.environmentId ?? null,
        focusRequest: { origin: document.activeElement },
    });
}

export function closeDock(): void {
    update({ open: false, startEnvironmentId: null, focusRequest: null });
}

export function takeStartRequest(environmentId: string): boolean {
    if (state.startEnvironmentId !== environmentId) return false;
    update({ startEnvironmentId: null });
    return true;
}

export function takeFocusRequest(): FocusRequest | null {
    const request = state.focusRequest;
    if (request !== null) update({ focusRequest: null });
    return request;
}

export function setDockHeight(height: number): void {
    if (height !== state.height) update({ height });
}

// Header rows of every pane bump this on mount and unmount. A dock then
// re-checks its host when a split pane appears or goes away.
let layoutVersion = 0;
const layoutListeners = new Set<() => void>();

export function bumpLayoutVersion(): void {
    layoutVersion += 1;
    for (const listener of layoutListeners) listener();
}

export function useLayoutVersion(): number {
    return useSyncExternalStore(
        (listener) => {
            layoutListeners.add(listener);
            return () => layoutListeners.delete(listener);
        },
        () => layoutVersion,
        () => layoutVersion,
    );
}
