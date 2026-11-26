// Bottom Terminal: a sidebar footer action toggles a terminal below the
// thread chat. Each environment gets one shell. lib/dock-host.ts finds where
// the dock attaches. lib/sessions.ts keeps the shell alive while it is hidden.
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { useEffect, useRef } from "react";
import {
    definePluginApp,
    useBbContext,
    type ExperimentalThreadHeaderRowProps,
} from "@get-bb/plugin-sdk/app";
import { useDockHost } from "./lib/dock-host";
import {
    bumpLayoutVersion,
    clearViewedEnvironment,
    reportViewedEnvironment,
    toggleDock,
    useDockState,
} from "./lib/dock-store";
import { TerminalDock } from "./lib/terminal-dock";

// Rendered in every thread pane's header rows. It takes no space itself.
// A hidden marker locates the pane. The dock is portaled into that pane's
// thread page only for the thread the app route points at.
function DockAnchor({ threadId, environment }: ExperimentalThreadHeaderRowProps) {
    const context = useBbContext();
    const { open } = useDockState();
    const markerRef = useRef<HTMLSpanElement>(null);
    const environmentId = environment?.id ?? null;
    const isViewed = context.threadId === threadId;

    useEffect(() => {
        bumpLayoutVersion();
        return bumpLayoutVersion;
    }, []);

    useEffect(() => {
        if (!isViewed) return;
        const owner = {};
        reportViewedEnvironment(owner, environmentId);
        return () => clearViewedEnvironment(owner);
    }, [isViewed, environmentId]);

    const host = useDockHost(markerRef, open && isViewed && environmentId !== null);

    return (
        <>
            <span ref={markerRef} hidden data-bb-docked-terminal-anchor="" />
            {host !== null && environmentId !== null ? (
                <TerminalDock key={environmentId} host={host} environmentId={environmentId} />
            ) : null}
        </>
    );
}

export default definePluginApp((app) => {
    app.experimental_sidebarFooter.register({
        kind: "action",
        id: "bottom-terminal",
        label: "Bottom Terminal",
        icon: "Terminal",
        onActivate: toggleDock,
    });
    app.slots.experimental_threadHeaderRow({
        id: "bottom-terminal-anchor",
        component: DockAnchor,
    });
});
