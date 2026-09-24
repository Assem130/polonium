import { Workspace } from "kwin-api/qml";
import { config, controller as ctrl } from "..";
import { Window } from "kwin-api";
import { Borders } from "../config";
import { directionFromPoint } from "../../util";
import { Display } from "../event";
import { Signal } from "kwin-api/qt";

export class WorkspaceHandler {
    private workspace: Workspace;
    // double buffer activated windows so we know which one was most recently active
    // (do this for active window insertion)
    private previousActivated: Window | null;
    private currentActivated: Window | null;
    private disconnectSignals: Array<() => void> = [];

    constructor(workspace: Workspace) {
        this.workspace = workspace;
        this.previousActivated = null;
        this.currentActivated = this.workspace.activeWindow;

        this.connectSignal(
            this.workspace.windowAdded,
            this.windowAdded.bind(this),
        );
        this.connectSignal(
            this.workspace.windowRemoved,
            this.windowRemoved.bind(this),
        );
        this.connectSignal(
            this.workspace.windowActivated,
            this.windowActivated.bind(this),
        );

        this.connectSignal(
            this.workspace.currentActivityChanged,
            this.rebuildDesktops.bind(this),
        );

        this.connectSignal(
            this.workspace.screensChanged,
            this.updateDrivers.bind(this),
        );
        this.connectSignal(
            this.workspace.desktopsChanged,
            this.updateDrivers.bind(this),
        );
        this.connectSignal(
            this.workspace.activityAdded,
            this.updateDrivers.bind(this),
        );
        this.connectSignal(
            this.workspace.activityRemoved,
            this.updateDrivers.bind(this),
        );
        this.connectSignal(
            this.workspace.activitiesChanged,
            this.updateDrivers.bind(this),
        );
    }

    private connectSignal<T extends Function>(signal: Signal<T>, callback: T) {
        signal.connect(callback);
        this.disconnectSignals.push(() => signal.disconnect(callback));
    }

    dispose(): void {
        for (const disconnect of this.disconnectSignals.splice(0)) {
            try {
                disconnect();
            } catch (_error) {
                // A removed native object may already have dropped its signals.
            }
        }
    }

    windowAdded(window: Window) {
        if (
            config().ignoreWindowClasses.test(window.resourceClass) ||
            config().ignoreWindowCaptions.test(window.caption)
        ) {
            return;
        }
        let tile,
            direction = undefined;
        if (this.previousActivated?.tile != null) {
            tile = this.previousActivated.tile;
            direction = directionFromPoint(
                tile.absoluteGeometry,
                this.workspace.cursorPos,
            );
        }
        ctrl().queueEvent({
            t: "newWindow",
            window: window,
            tile: tile,
            direction: direction,
        });
    }

    windowRemoved(window: Window) {
        ctrl().queueEvent({
            t: "deleteWindow",
            window: window,
            displays: [...Display.generateWindow(window)],
        });
    }

    rebuildDesktops() {
        // never mind we still have to do stuff
        ctrl().queueEvent({ t: "rebuildDisplays" });
    }

    updateDrivers() {
        ctrl().queueEvent({ t: "updateDrivers" });
    }

    windowActivated(window: Window | null) {
        // eventually we should move border setting entirely into the controller/driver
        this.previousActivated = this.currentActivated;
        this.currentActivated = window;
        const borders = config().borders;
        if (
            this.previousActivated !== null &&
            (borders === Borders.Active ||
                (borders === Borders.FloatingActive &&
                    ctrl().isWindowTiled(this.previousActivated)))
        ) {
            ctrl().queuePostEvent({
                t: "setWindowProperties",
                window: this.previousActivated,
                noBorder: true,
            });
        }
        if (window === null) {
            ctrl().queueEvent({ t: "windowActivated", window });
            return;
        }
        if (
            (borders === Borders.Active ||
                borders === Borders.FloatingActive) &&
            ctrl().isWindowTiled(window)
        ) {
            ctrl().queuePostEvent({
                t: "setWindowProperties",
                window: window,
                noBorder: false,
            });
        }
        ctrl().queueEvent({
            t: "windowActivated",
            window: window,
        });
    }
}
