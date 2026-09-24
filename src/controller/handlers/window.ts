import { Window, MaximizeMode, Tile } from "kwin-api";
import { config, console, controller as ctrl, qt } from "..";
import { Workspace } from "kwin-api/qml";
import { DragPolicy, DragRetilePoint } from "../config";
import { QPoint, Signal } from "kwin-api/qt";
import { directionFromPoint } from "../../util";
import { FocusSnapshot, copyFocusGeometry } from "../focus-snapshot";

interface WindowGeometry {
    x: number;
    y: number;
    width: number;
    height: number;
}

export class WindowHandler {
    window: Window;
    /**
     * This basically means that the window may not be tiled (even the handler knows this),
     * but it wishes to be tiled whenever possible.
     *
     * Ex. A window is fullscreened, it is not tiled but after it leaves fullscreen it wants to be tiled again.
     * Or if a window is moving and it wants to be tiled after the move is finished.
     */
    wantsTiled: boolean;
    maximized: boolean;
    wasTiledBeforeMove: boolean = false;
    ignoreNextTilePlacement = false;
    private stackingBeforeFullscreen: {
        keepAbove: boolean;
        keepBelow: boolean;
    } | null = null;
    private pendingFullscreenStackingRestore: {
        keepAbove: boolean;
        keepBelow: boolean;
    } | null = null;
    private restoreAfterFullscreen: {
        x: number;
        y: number;
        width: number;
        height: number;
    } | null = null;
    private recoveredFullscreenSnapshot: FocusSnapshot | null = null;
    private restoreAfterMaximize: {
        x: number;
        y: number;
        width: number;
        height: number;
    } | null = null;
    private focusDrag: {
        original: WindowGeometry;
        focused: WindowGeometry;
    } | null = null;
    private disconnectSignals: Array<() => void> = [];

    workspace: Workspace;

    constructor(window: Window, workspace: Workspace) {
        this.window = window;
        this.workspace = workspace;
        // KWin exposes maximizeMode, but kwin-api 6.7.1 omits it from Window.
        const maximizeMode = (
            window as Window & { maximizeMode?: MaximizeMode }
        ).maximizeMode;
        this.maximized =
            maximizeMode !== undefined &&
            maximizeMode !== MaximizeMode.MaximizeRestore;
        const detached =
            window.fullScreen || window.minimized || this.maximized;
        this.recoveredFullscreenSnapshot = detached
            ? ctrl().focusSnapshotForWindow(window)
            : null;
        if (!detached) {
            ctrl().clearFocusSnapshot(window);
        }
        const savedTiledIntent = detached
            ? ctrl().tiledIntentForWindow(window)
            : null;
        if (!detached) {
            ctrl().clearTiledIntent(window);
        }

        // A native tile is evidence of intent across a script reload, even if
        // fullscreen/minimized currently prevents Polonium from tiling it.
        this.wantsTiled =
            this.recoveredFullscreenSnapshot?.tiled ??
            savedTiledIntent ??
            (this.startTiled() ||
                (this.isTileCandidate() && this.window.tile != null));
        if (window.fullScreen) {
            const snapshot = this.recoveredFullscreenSnapshot;
            if (
                snapshot !== null &&
                window.output.name === snapshot.outputName
            ) {
                this.restoreAfterFullscreen = copyFocusGeometry(
                    snapshot.geometry,
                );
            }
            this.stackingBeforeFullscreen = (snapshot === null
                ? null
                : {
                      keepAbove: snapshot.keepAbove,
                      keepBelow: snapshot.keepBelow,
                  }) ??
                ctrl().fullscreenStackingForWindow(window) ?? {
                    keepAbove: window.keepAbove,
                    keepBelow: window.keepBelow,
                };
            ctrl().saveFullscreenStacking(
                window,
                this.stackingBeforeFullscreen,
            );
            // The old instance restored the original stacking on unload.
            // Reapply the fullscreen workaround until the real exit signal.
            ctrl().queuePostEvent({
                t: "setWindowProperties",
                window,
                fullscreen: false,
            });
            ctrl().queuePostEvent({
                t: "setWindowProperties",
                window,
                fullscreen: true,
                keepAbove: true,
                keepBelow: false,
            });
        } else {
            ctrl().clearFullscreenStacking(window);
        }
        this.connectSignal(
            this.window.desktopsChanged,
            this.updateWindow.bind(this),
        );
        this.connectSignal(
            this.window.activitiesChanged,
            this.updateWindow.bind(this),
        );
        this.connectSignal(
            this.window.outputChanged,
            this.updateWindow.bind(this),
        );

        this.connectSignal(
            this.window.fullScreenChanged,
            this.fullscreenChanged.bind(this),
        );
        this.connectSignal(
            this.window.minimizedChanged,
            this.minimizedChanged.bind(this),
        );
        this.connectSignal(
            this.window.maximizedAboutToChange,
            this.maximizedAboutToChange.bind(this),
        );
        this.connectSignal(
            this.window.maximizedChanged,
            this.maximizationFinished.bind(this),
        );

        this.connectSignal(
            this.window.interactiveMoveResizeStarted,
            this.interactiveMoveResizeStarted.bind(this),
        );
        this.connectSignal(
            this.window.interactiveMoveResizeStepped,
            this.interactiveMoveResizeStepped.bind(this),
        );
        this.connectSignal(
            this.window.interactiveMoveResizeFinished,
            this.interactiveMoveResizeFinished.bind(this),
        );

        this.connectSignal(
            this.window.tileChanged,
            this.tileChanged.bind(this),
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

    startTiled(): boolean {
        return this.isTileCandidate() && this.canBeTiled();
    }

    private isTileCandidate(): boolean {
        if (
            this.window.specialWindow ||
            (!config().tilePopups &&
                (this.window.popupWindow || this.window.transient))
        ) {
            return false;
        }
        if (config().untileWindowClasses.test(this.window.resourceClass)) {
            return false;
        }
        if (config().untileWindowCaptions.test(this.window.caption)) {
            return false;
        }
        return true;
    }

    updateWindow() {
        console().debug(
            "updating displays for window",
            this.window.resourceClass,
        );
        ctrl().queueEvent({
            t: "updateWindow",
            window: this.window,
        });
    }

    fullscreenChanged() {
        const externalChange = !ctrl().isProcessingEvents();
        if (this.window.fullScreen && externalChange) {
            ctrl().saveTiledIntent(this.window, this.wantsTiled);
            ctrl().checkpointFocusForDetachment(this.window);
        }
        const focusSnapshot = externalChange
            ? ctrl().focusSnapshotForWindow(this.window)
            : null;
        const recovered =
            !this.window.fullScreen && externalChange
                ? (this.recoveredFullscreenSnapshot ?? focusSnapshot)
                : null;
        if (recovered !== null) {
            this.recoveredFullscreenSnapshot = null;
        }
        if (this.window.fullScreen && !ctrl().isProcessingEvents()) {
            this.restoreAfterFullscreen = ctrl().focusRestoreGeometryForWindow(
                this.window,
            );
        } else if (
            this.restoreAfterFullscreen !== null &&
            !ctrl().isProcessingEvents()
        ) {
            // KWin restores geometry after this signal, so apply the saved size next tick.
            ctrl().queuePostEvent({
                t: "setWindowProperties",
                window: this.window,
                geometry: this.restoreAfterFullscreen,
            });
            this.restoreAfterFullscreen = null;
        }
        if (this.window.fullScreen && !ctrl().isProcessingEvents()) {
            this.stackingBeforeFullscreen = this
                .pendingFullscreenStackingRestore ??
                ctrl().focusStackingForWindow(this.window) ?? {
                    keepAbove: this.window.keepAbove,
                    keepBelow: this.window.keepBelow,
                };
            ctrl().saveFullscreenStacking(
                this.window,
                this.stackingBeforeFullscreen,
            );
        } else if (!this.window.fullScreen && externalChange) {
            ctrl().clearFullscreenStacking(this.window);
        }
        ctrl().releaseFocusForWindow(this.window);
        console().debug(
            "fullscreen changed on window",
            this.window.resourceClass,
        );
        const preserveFocusTile =
            this.window.fullScreen && focusSnapshot?.tiled === true;
        if (recovered === null && !preserveFocusTile) {
            if (!this.canBeTiled() && ctrl().isWindowTiled(this.window)) {
                ctrl().queueEvent({
                    t: "untileWindow",
                    window: this.window,
                });
            } else if (
                this.canBeTiled() &&
                !ctrl().isWindowTiled(this.window) &&
                this.wantsTiled
            ) {
                ctrl().queueEvent({
                    t: "tileWindow",
                    window: this.window,
                });
            }
        }
        if (this.window.fullScreen) {
            // toggle fullscreen because this works for whatever reason
            ctrl().queuePostEvent({
                t: "setWindowProperties",
                window: this.window,
                fullscreen: false,
            });
            // add keepabove here to prevent fullscreen windows showing below widgets
            ctrl().queuePostEvent({
                t: "setWindowProperties",
                window: this.window,
                fullscreen: true,
                keepAbove: true,
                keepBelow: false,
            });
        } else if (
            !ctrl().isProcessingEvents() &&
            this.stackingBeforeFullscreen !== null
        ) {
            const stacking = this.stackingBeforeFullscreen;
            this.pendingFullscreenStackingRestore = stacking;
            this.stackingBeforeFullscreen = null;
            ctrl().queuePostEvent({
                t: "setWindowProperties",
                window: this.window,
                keepAbove: stacking.keepAbove,
                keepBelow: stacking.keepBelow,
                fullscreenStacking: stacking,
            });
        }
        if (recovered !== null) {
            ctrl().queuePostEvent({
                t: "restoreFocusSnapshot",
                window: this.window,
                snapshot: recovered,
            });
        } else if (!this.window.fullScreen && externalChange) {
            ctrl().clearFocusSnapshot(this.window);
        }
        if (
            !this.window.fullScreen &&
            !this.window.minimized &&
            !this.maximized &&
            externalChange
        ) {
            ctrl().clearTiledIntent(this.window);
        }
    }

    pendingFullscreenStacking() {
        return this.pendingFullscreenStackingRestore;
    }

    fullscreenStackingForCleanup() {
        return (
            this.pendingFullscreenStackingRestore ??
            this.stackingBeforeFullscreen
        );
    }

    clearPendingFullscreenStacking(stacking: {
        keepAbove: boolean;
        keepBelow: boolean;
    }) {
        if (this.pendingFullscreenStackingRestore === stacking) {
            this.pendingFullscreenStackingRestore = null;
        }
    }

    minimizedChanged() {
        if (this.window.minimized) {
            ctrl().saveTiledIntent(this.window, this.wantsTiled);
            ctrl().checkpointFocusForDetachment(this.window);
        } else if (!this.window.fullScreen && !this.maximized) {
            ctrl().clearTiledIntent(this.window);
        }
        const focusSnapshot = ctrl().focusSnapshotForWindow(this.window);
        ctrl().releaseFocusForWindow(this.window);
        console().debug(
            "minimized changed on window",
            this.window.resourceClass,
        );
        if (focusSnapshot?.tiled !== true) {
            if (!this.canBeTiled() && ctrl().isWindowTiled(this.window)) {
                ctrl().queueEvent({
                    t: "untileWindow",
                    window: this.window,
                });
            } else if (
                this.canBeTiled() &&
                !ctrl().isWindowTiled(this.window) &&
                this.wantsTiled
            ) {
                ctrl().queueEvent({
                    t: "tileWindow",
                    window: this.window,
                });
            }
        }
        if (!this.window.minimized && focusSnapshot !== null) {
            this.recoveredFullscreenSnapshot = null;
            ctrl().queuePostEvent({
                t: "restoreFocusSnapshot",
                window: this.window,
                snapshot: focusSnapshot,
            });
        }
    }
    maximizedAboutToChange(state: MaximizeMode) {
        if (state !== MaximizeMode.MaximizeRestore) {
            ctrl().saveTiledIntent(this.window, this.wantsTiled);
            ctrl().checkpointFocusForDetachment(this.window);
        } else if (!this.window.fullScreen && !this.window.minimized) {
            ctrl().clearTiledIntent(this.window);
        }
        const focusSnapshot = ctrl().focusSnapshotForWindow(this.window);
        if (state !== MaximizeMode.MaximizeRestore) {
            const geometry = ctrl().focusRestoreGeometryForWindow(this.window);
            if (geometry !== null) {
                this.restoreAfterMaximize = geometry;
            }
        }
        ctrl().releaseFocusForWindow(this.window);
        console().debug(
            "maximized state changed on window",
            this.window.resourceClass,
        );
        this.maximized = state !== MaximizeMode.MaximizeRestore;
        if (focusSnapshot?.tiled !== true) {
            if (!this.canBeTiled() && ctrl().isWindowTiled(this.window)) {
                ctrl().queueEvent({
                    t: "untileWindow",
                    window: this.window,
                });
            } else if (
                this.canBeTiled() &&
                !ctrl().isWindowTiled(this.window) &&
                this.wantsTiled
            ) {
                ctrl().queueEvent({
                    t: "tileWindow",
                    window: this.window,
                });
            }
        }
    }

    maximizationFinished() {
        if (this.maximized) {
            return;
        }
        if (this.restoreAfterMaximize !== null) {
            ctrl().queuePostEvent({
                t: "setWindowProperties",
                window: this.window,
                geometry: this.restoreAfterMaximize,
            });
            this.restoreAfterMaximize = null;
        }
        const focusSnapshot = ctrl().focusSnapshotForWindow(this.window);
        if (focusSnapshot !== null) {
            this.recoveredFullscreenSnapshot = null;
            ctrl().queuePostEvent({
                t: "restoreFocusSnapshot",
                window: this.window,
                snapshot: focusSnapshot,
            });
        }
    }

    // multiple step move resize -
    // if tiled and in a tile, then when move started, set is moving flag to true
    // then if it leaves the tile in a later step, untile it
    // after all that, if
    interactiveMoveResizeStarted() {
        if (ctrl().isFocusedWindow(this.window)) {
            const original = ctrl().focusGeometryForWindow(this.window);
            if (original !== null) {
                const frame = this.window.frameGeometry;
                this.focusDrag = {
                    original,
                    focused: {
                        x: frame.x,
                        y: frame.y,
                        width: frame.width,
                        height: frame.height,
                    },
                };
            }
            ctrl().releaseFocusForWindow(this.window, false);
            ctrl().queueEvent({ t: "rebuildDisplays" });
        }
        this.wasTiledBeforeMove = ctrl().isWindowTiled(this.window) ?? false;
    }
    interactiveMoveResizeStepped() {
        if (
            !ctrl().isWindowTiled(this.window) ||
            !this.canBeTiled() ||
            this.window.tile != null
        ) {
            return;
        }
        // if the policy is never retile then untile regardless of previous tile status
        if (
            !this.wasTiledBeforeMove &&
            config().windowDragPolicy !== DragPolicy.Never
        ) {
            return;
        }
        console().debug("move started on window", this.window.resourceClass);
        if (config().windowDragPolicy == DragPolicy.Never) {
            this.wantsTiled = false;
        }
        ctrl().queueEvent({
            t: "untileWindow",
            window: this.window,
        });
    }
    interactiveMoveResizeFinished() {
        const focusDrag = this.focusDrag;
        this.focusDrag = null;
        if (
            focusDrag !== null &&
            this.window.tile == null &&
            !ctrl().isWindowTiled(this.window)
        ) {
            const frame = this.window.frameGeometry;
            const width = Math.max(
                this.window.minSize.width,
                focusDrag.original.width +
                    frame.width -
                    focusDrag.focused.width,
            );
            const height = Math.max(
                this.window.minSize.height,
                focusDrag.original.height +
                    frame.height -
                    focusDrag.focused.height,
            );
            this.window.frameGeometry = qt().rect(
                focusDrag.original.x + frame.x - focusDrag.focused.x,
                focusDrag.original.y + frame.y - focusDrag.focused.y,
                width,
                height,
            );
        }
        if (
            !this.wantsTiled ||
            !this.canBeTiled() ||
            ctrl().isWindowTiled(this.window) ||
            this.window.tile != null
        ) {
            return;
        }
        if (
            !this.wasTiledBeforeMove &&
            config().windowDragPolicy == DragPolicy.Tiled
        ) {
            return;
        }
        console().debug("move finished on window", this.window.resourceClass);
        ctrl().queueEvent({
            t: "placeWindowPoint",
            window: this.window,
            point: this.getInsertionPoint(),
        });
    }

    // this only tracks manual insertion into a tile
    tileChanged(tile: Tile) {
        if (tile != null && this.ignoreNextTilePlacement) {
            this.ignoreNextTilePlacement = false;
            if (ctrl().isWindowTiled(this.window)) {
                return;
            }
        }
        if (tile != null && !ctrl().isWindowTiled(this.window)) {
            this.wantsTiled = true;
            ctrl().queueEvent({
                t: "placeWindow",
                window: this.window,
                tile: tile,
                // always use cursorPos as frameGeometry is equal to the tile geometry
                // after insertion
                direction: directionFromPoint(
                    tile.absoluteGeometry,
                    this.workspace.cursorPos,
                ),
            });
        }
    }

    clearTilePlacementSuppression() {
        this.ignoreNextTilePlacement = false;
    }

    canBeTiled(): boolean {
        return !(
            this.window.fullScreen ||
            this.window.minimized ||
            this.maximized
        );
    }

    private getInsertionPoint(): QPoint {
        switch (config().dragRetilePoint) {
            case DragRetilePoint.Mouse: {
                return this.workspace.cursorPos;
            }
            case DragRetilePoint.Center: {
                return qt().point(
                    this.window.frameGeometry.x +
                        this.window.frameGeometry.width / 2,
                    this.window.frameGeometry.y +
                        this.window.frameGeometry.height / 2,
                );
            }
            case DragRetilePoint.Top: {
                return qt().point(
                    this.window.frameGeometry.x +
                        this.window.frameGeometry.width / 2,
                    this.window.frameGeometry.y,
                );
            }
            default: {
                return this.workspace.cursorPos;
            }
        }
    }
}
