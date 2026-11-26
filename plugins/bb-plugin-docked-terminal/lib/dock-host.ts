// Finds the thread page element the dock attaches to. bb 0.50.1 has no slot
// below the composer. This relies on the page layout in
// apps/app/src/views/thread-detail/ThreadScreen.tsx instead.
// There, a flex column marked `data-thread-window` holds the scrolling page
// with the composer. A plugin-owned flex child appended to it takes height
// from that page. That pushes the messages and the composer up.
// The selector is not a public contract, so every check below fails closed.
// When anything is unclear, the dock does not mount.
import { useEffect, useState, type RefObject } from "react";
import { useLayoutVersion } from "./dock-store";

// `data-surface-tone` marks the panel and transcript presentations.
// Only the full page layout gets a dock.
const HOST_SELECTOR = "[data-thread-window]:not([data-surface-tone])";
const FOCUSED_PANE_SELECTOR = '[data-split-pane-id][data-focused="true"]';
const SPLIT_PANE_SELECTOR = "[data-split-pane-id][data-focused]";
const HIDDEN_SELECTOR = '[inert], [aria-hidden="true"]';
// Marks the dock's own subtree so its terminal output is not re-examined.
export const DOCK_ATTRIBUTE = "data-bb-docked-terminal";

export const MIN_DOCK_HEIGHT = 96;
export const MIN_CHAT_HEIGHT = 200;
const MIN_HOST_WIDTH = 320;
const MIN_HOST_HEIGHT = MIN_DOCK_HEIGHT + MIN_CHAT_HEIGHT;

const OBSERVED_ATTRIBUTES = [
    "data-focused",
    "data-maximized",
    "data-split-pane-id",
    "data-surface-tone",
    "data-thread-window",
    "inert",
    "aria-hidden",
];

// The thread page that belongs to this header, whether or not it can show a
// dock right now. Identity depends only on structure and split focus.
function findCandidate(marker: HTMLElement): HTMLElement | null {
    if (!marker.isConnected) return null;

    // The nearest ancestor that contains a thread page decides which page
    // belongs to this header. More than one there means the layout is not the
    // one this plugin knows.
    let host: HTMLElement | null = null;
    for (let element = marker.parentElement; element !== null; element = element.parentElement) {
        const found = element.querySelectorAll<HTMLElement>(HOST_SELECTOR);
        if (found.length === 0) continue;
        if (found.length > 1) return null;
        host = found[0] ?? null;
        break;
    }
    if (host === null) return null;

    const isSplit =
        document.querySelectorAll(HOST_SELECTOR).length > 1 ||
        document.querySelectorAll(SPLIT_PANE_SELECTOR).length > 1;
    if (isSplit) {
        const pane = marker.closest(FOCUSED_PANE_SELECTOR);
        if (pane === null || !pane.contains(host)) return null;
    }
    return host;
}

// Whether the candidate is visible and large enough for a dock now. A
// maximized side panel, for example, makes the chat inert and narrow.
function canShowDock(marker: HTMLElement, host: HTMLElement): boolean {
    if (marker.closest(HIDDEN_SELECTOR) !== null || host.closest(HIDDEN_SELECTOR) !== null) return false;
    const rect = host.getBoundingClientRect();
    return rect.width >= MIN_HOST_WIDTH && rect.height >= MIN_HOST_HEIGHT;
}

function isInsideDock(node: Node): boolean {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest(`[${DOCK_ATTRIBUTE}]`) != null;
}

/**
 * The thread page under this header row while `enabled`, or null. Re-checked
 * on split focus, inert or aria-hidden changes, pane mounts, and resizes.
 */
export function useDockHost(markerRef: RefObject<HTMLElement | null>, enabled: boolean): HTMLElement | null {
    const [host, setHost] = useState<HTMLElement | null>(null);
    const layoutVersion = useLayoutVersion();

    useEffect(() => {
        const marker = markerRef.current;
        if (!enabled || marker === null) {
            setHost(null);
            return;
        }

        let frame = 0;
        let candidate: HTMLElement | null = null;
        const resizeObserver = new ResizeObserver(() => schedule());
        const check = () => {
            frame = 0;
            // Keep observing the candidate while it cannot show the dock.
            // Its size coming back then remounts the dock. The inert or
            // aria-hidden change comes through the mutation observer, in
            // either order.
            const next = findCandidate(marker);
            if (next !== candidate) {
                if (candidate !== null) resizeObserver.unobserve(candidate);
                if (next !== null) resizeObserver.observe(next);
                candidate = next;
            }
            setHost(next !== null && canShowDock(marker, next) ? next : null);
        };
        function schedule(): void {
            if (frame === 0) frame = requestAnimationFrame(check);
        }

        const mutationObserver = new MutationObserver((records) => {
            if (records.every((record) => isInsideDock(record.target))) return;
            schedule();
        });
        mutationObserver.observe(document.body, {
            subtree: true,
            attributes: true,
            attributeFilter: OBSERVED_ATTRIBUTES,
        });
        window.addEventListener("resize", schedule);
        check();

        return () => {
            if (frame !== 0) cancelAnimationFrame(frame);
            mutationObserver.disconnect();
            resizeObserver.disconnect();
            window.removeEventListener("resize", schedule);
        };
    }, [enabled, layoutVersion, markerRef]);

    return enabled ? host : null;
}
