// Archive section: a disclosure row above the sidebar toolbar that lists
// archived threads without changing the active thread list.
//
// BB 0.50.1 has no slot for content between the sidebar list and its toolbar,
// so an app overlay portals into a node placed after BB's footer disclosure
// wrapper. The anchor selector is pinned to the verified BB release.
import { useEffect, useId, useState } from "react";
import type { MouseEvent } from "react";
import { createPortal } from "react-dom";
import {
    definePluginApp,
    experimental_Icon as Icon,
    experimental_usePluginId,
    experimental_useSidebarThreads,
    useBbContext,
    useBbNavigate,
    type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";

const ANCHOR_SELECTOR =
    '[data-testid="app-sidebar-body"] > [data-sidebar="content"] + div:has(> [data-overflow-fade="above"])';
const OPEN_MOBILE_PANEL_SELECTOR =
    '[data-sidebar="panel"][role="dialog"][data-state="open"]';
const OPEN_MOBILE_BACKDROP_SELECTOR =
    '[data-sidebar-mobile-backdrop][data-state="open"]';
// In a short window, BB's footer disclosure (50svh) and the open Archive list
// would leave the thread list without a reachable row. While Archive is open,
// cap only the disclosure's own scroller so each list keeps about one row.
// Above roughly 480px the native 50svh limit is smaller and still applies.
const SHORT_WINDOW_DISCLOSURE_CAP = `${ANCHOR_SELECTOR}:has(+ [data-bb-plugin-scope-archive-section] button[aria-expanded="true"]) > section > div { max-height: min(50svh, max(4rem, calc(100svh - 248px))); }`;
const ARCHIVED_ONLY = { experimental_lifecycles: ["archived"] } as const;

/**
 * Keeps an owned node directly after the sidebar anchor across sidebar
 * remounts. Returns null while the anchor is absent so the UI stays hidden.
 */
function useSidebarMount(pluginId: string): HTMLElement | null {
    const [mount, setMount] = useState<HTMLElement | null>(null);

    useEffect(() => {
        const node = document.createElement("div");
        // Scope attributes let the plugin stylesheet match this subtree.
        // data-bb-portaled-overlay is omitted so BB keeps native link
        // modifier handling for the anchors inside.
        node.setAttribute("data-bb-plugin-root", "");
        node.setAttribute("data-bb-plugin", pluginId);
        node.setAttribute(`data-bb-plugin-scope-${pluginId}`, "");
        // Grow from zero up to the content height, so in a short sidebar the
        // free space is shared with BB's thread list instead of taking it all.
        node.className = "flex min-h-0 max-h-fit flex-1 basis-0 flex-col";

        let frame = 0;
        const place = () => {
            frame = 0;
            const previous = node.previousElementSibling;
            if (node.isConnected && previous?.matches(ANCHOR_SELECTOR)) {
                setMount(node);
                return;
            }
            const anchor = document.querySelector(ANCHOR_SELECTOR);
            if (anchor === null) {
                node.remove();
                setMount(null);
                return;
            }
            anchor.after(node);
            setMount(node);
        };
        // Coalesce DOM churn (for example streaming chat) to one check per frame.
        const schedule = () => {
            if (frame === 0) frame = requestAnimationFrame(place);
        };

        place();
        const observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });
        return () => {
            observer.disconnect();
            if (frame !== 0) cancelAnimationFrame(frame);
            node.remove();
            setMount(null);
        };
    }, [pluginId]);

    return mount;
}

/**
 * The overlay has no sidebar navigation callback, so a plain link activation
 * uses the compact drawer's own backdrop dismissal. Nothing happens unless
 * the link sits in the open mobile panel next to its open backdrop.
 */
function dismissMobileDrawer(from: Element) {
    const panel = from.closest(OPEN_MOBILE_PANEL_SELECTOR);
    const backdrop = panel?.previousElementSibling;
    if (
        backdrop instanceof HTMLElement &&
        backdrop.matches(OPEN_MOBILE_BACKDROP_SELECTOR)
    ) {
        backdrop.click();
    }
}

function isPlainActivation(event: MouseEvent<HTMLAnchorElement>): boolean {
    return (
        !event.defaultPrevented &&
        event.button === 0 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey
    );
}

const ROW_HEIGHT =
    "h-[var(--bb-sidebar-row-height)] max-md:pointer-coarse:h-[var(--bb-sidebar-row-height-coarse)]";
const ROW_INTERACTION =
    "cursor-pointer rounded-md text-sm outline-none ring-sidebar-ring hover:bg-sidebar-accent focus-visible:ring-2";
const ROW_TEXT = "text-sidebar-foreground hover:text-sidebar-accent-foreground";
// The list scrolls, so an outer ring would be clipped at its edges.
const INSET_RING = "focus-visible:ring-inset";
// BB's subtle token keeps secondary controls apart from the titles.
// Titles use the sidebar foreground, and muted is nearly the same.
const SECONDARY_ROW = `flex w-full items-center px-2 text-[var(--subtle-foreground)] ${ROW_HEIGHT} ${ROW_INTERACTION} ${INSET_RING}`;

function ArchivedThreadLink({
    thread,
    isCurrent,
}: {
    thread: PluginSidebarThread;
    isCurrent: boolean;
}) {
    const navigate = useBbNavigate();
    const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
        // Modified and middle clicks keep the browser and BB link behavior.
        if (!isPlainActivation(event)) return;
        event.preventDefault();
        navigate.toThread(thread.id);
        dismissMobileDrawer(event.currentTarget);
    };
    return (
        <a
            href={thread.href}
            aria-current={isCurrent ? "page" : undefined}
            onClick={onClick}
            className={`flex min-w-0 items-center px-2 ${ROW_HEIGHT} ${ROW_INTERACTION} ${ROW_TEXT} ${INSET_RING} aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground`}
        >
            <span className="min-w-0 truncate">{thread.displayTitle}</span>
        </a>
    );
}

function StatusLine({
    tone = "muted",
    children,
}: {
    tone?: "muted" | "error";
    children: string;
}) {
    return (
        <p
            role={tone === "error" ? "alert" : "status"}
            className={`px-2 py-1.5 text-xs ${tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
            {children}
        </p>
    );
}

/** Mounted only while the section is open, so the archive query runs on demand. */
function ArchivedThreadList() {
    const state = experimental_useSidebarThreads(ARCHIVED_ONLY);
    const { threadId } = useBbContext();
    const pages = state.experimental_archived;
    // Local to the mounted list, so each opening starts with parents only.
    const [showChildren, setShowChildren] = useState(false);
    // Keep SDK order; hidden threads are filtered out as BB's own list does.
    const threads = state.threads.filter(
        (thread) => thread.isArchived && !thread.isHidden,
    );
    const hasChildren = threads.some((thread) => thread.parentThreadId !== null);
    const visibleThreads = showChildren
        ? threads
        : threads.filter((thread) => thread.parentThreadId === null);
    // Initial results follow the top-level status only. `pages` can still be
    // loading after the sidebar bootstrap fails, and it only drives paging.
    if (threads.length === 0) {
        if (state.status === "loading") return <StatusLine>Loading archived threads…</StatusLine>;
        if (state.status === "error") {
            return (
                <StatusLine tone="error">
                    Couldn't load archived threads
                </StatusLine>
            );
        }
    }

    return (
        <>
            {hasChildren ? (
                // One element for both labels keeps focus on it after toggling.
                <button
                    type="button"
                    onClick={() => setShowChildren((show) => !show)}
                    className={`mb-0.5 ${SECONDARY_ROW}`}
                >
                    {showChildren ? "Hide child threads" : "Show child threads"}
                </button>
            ) : null}
            {visibleThreads.length > 0 ? (
                <ul className="space-y-0.5">
                    {visibleThreads.map((thread) => (
                        <li key={thread.id}>
                            <ArchivedThreadLink
                                thread={thread}
                                isCurrent={thread.id === threadId}
                            />
                        </li>
                    ))}
                </ul>
            ) : pages?.hasNextPage ? null : (
                <StatusLine>
                    {threads.length > 0
                        ? "No archived parent threads"
                        : "No archived threads"}
                </StatusLine>
            )}
            {pages?.isFetchNextPageError ? (
                <StatusLine tone="error">Couldn't load more threads</StatusLine>
            ) : null}
            {pages?.hasNextPage ? (
                <button
                    type="button"
                    disabled={pages.isFetchingNextPage}
                    onClick={() => {
                        // Failures surface through isFetchNextPageError.
                        pages.fetchNextPage().catch(() => undefined);
                    }}
                    className={`${SECONDARY_ROW} disabled:cursor-default disabled:opacity-70`}
                >
                    {pages.isFetchingNextPage
                        ? "Loading…"
                        : pages.isFetchNextPageError
                          ? "Try again"
                          : "Show more"}
                </button>
            ) : null}
        </>
    );
}

function ArchiveSection({
    isOpen,
    onToggle,
}: {
    isOpen: boolean;
    onToggle: () => void;
}) {
    const listId = useId();
    // Column-reverse keeps the button in place below the list while DOM order
    // stays button first, so Tab moves from the button into the list.
    return (
        <div className="flex min-h-0 flex-1 flex-col-reverse gap-0.5 px-2 pt-1">
            <style>{SHORT_WINDOW_DISCLOSURE_CAP}</style>
            <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={listId}
                onClick={onToggle}
                className={`flex w-full shrink-0 items-center gap-2 pl-2 pr-1.5 text-left ${ROW_HEIGHT} ${ROW_INTERACTION} ${ROW_TEXT}`}
            >
                <Icon name="Archive" className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">Archive</span>
                <Icon
                    name={isOpen ? "ChevronDown" : "ChevronUp"}
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                />
            </button>
            <div
                id={listId}
                role="region"
                aria-label="Archived threads"
                hidden={!isOpen}
                className="max-h-[min(16rem,30dvh)] min-h-0 overflow-y-auto border-t border-sidebar-border pt-0.5"
            >
                {isOpen ? <ArchivedThreadList /> : null}
            </div>
        </div>
    );
}

function ArchiveSectionOverlay() {
    const pluginId = experimental_usePluginId();
    const mount = useSidebarMount(pluginId);
    // Owned here so the open state survives sidebar remounts.
    const [isOpen, setIsOpen] = useState(false);
    return mount === null
        ? null
        : createPortal(
              <ArchiveSection
                  isOpen={isOpen}
                  onToggle={() => setIsOpen((open) => !open)}
              />,
              mount,
          );
}

export default definePluginApp((app) => {
    app.slots.experimental_appOverlay({
        id: "archive-section",
        component: ArchiveSectionOverlay,
    });
});
