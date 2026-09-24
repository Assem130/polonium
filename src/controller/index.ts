import { ClientAreaOption, MaximizeMode, Window, Tile } from "kwin-api";
import {
    Event,
    PostEvent,
    simplifyEvents,
    simplifyPostEvents,
    DisplaySymbol,
    Display,
} from "./event";
import { QmlApi, QmlObjects } from "../extern";
import { Workspace } from "kwin-api/qml";
import {
    WorkspaceHandler,
    WindowHandler,
    ShortcutsHandler,
    SettingsHandler,
    DBusHandler,
} from "./handlers";
import { Direction, directionFromPoint, Queue } from "../util";
import { Console } from "./console";
import { Driver } from "../driver";
import { QPoint, QTimer, Qt } from "kwin-api/qt";
import { Borders, Config } from "./config";
import { TilingEngineType } from "../engine";
import {
    FocusGeometry,
    FocusSnapshot,
    isFocusSnapshot,
    copyFocusGeometry,
} from "./focus-snapshot";

interface FocusMode {
    window: Window;
    display: Display;
    geometry: FocusGeometry;
    keepAbove: boolean;
    keepBelow: boolean;
    noBorder: boolean;
    tiled: boolean;
    nativeTile: Tile | null;
    nativeTilePath: number[] | null;
    nativeTileGeometry: FocusGeometry | null;
}

class Controller {
    private workspace: Workspace;
    private qmlObjects: QmlObjects;

    private eventQueue: Queue<Event> = new Queue();
    private postEventQueue: Queue<PostEvent> = new Queue();
    private eventTimer: QTimer;
    private processingEvents: boolean = false;

    private drivers: Map<DisplaySymbol, Driver> = new Map();
    private pendingAdoption: Set<DisplaySymbol> = new Set();
    private pendingFocusToggles: Map<
        DisplaySymbol,
        { window: Window | null; display: Display }
    > = new Map();
    private pendingPlacements: Map<
        DisplaySymbol,
        Map<
            Window,
            {
                tilePath?: number[] | null;
                tileGeometry?: FocusGeometry;
                point?: QPoint;
                direction?: Direction;
            }
        >
    > = new Map();

    private windowHandlers: Map<Window, WindowHandler> = new Map();
    private previousDisplays: Map<Window, Display[]> = new Map();
    private workspaceHandler: WorkspaceHandler;
    private shortcutsHandler: ShortcutsHandler;
    private settingsHandler: SettingsHandler;
    private dbusHandler: DBusHandler | null = null;
    private focusMode: FocusMode | null = null;
    private focusDetachSuspensions: Map<Window, Display> = new Map();
    private focusKeepAboveWindows: Set<Window> = new Set();
    private disposed = false;

    constructor(qmlApi: QmlApi, qmlObjects: QmlObjects) {
        this.workspace = qmlApi.workspace;
        //this.options = qmlApi.options;
        //this.kwin = qmlApi.kwin;
        this.qmlObjects = qmlObjects;

        this.eventTimer = this.qmlObjects.eventTimer;
        this.eventTimer.interval = config().rebuildDelay;
        this.eventTimer.repeat = false;
        this.eventTimer.triggered.connect(this.processEvents.bind(this));

        if (config().useDBusSaver) {
            this.dbusHandler = new DBusHandler(this.qmlObjects.dbus);
        }
        this.settingsHandler = new SettingsHandler(this.qmlObjects.settings);
        this.workspaceHandler = new WorkspaceHandler(this.workspace);
        this.shortcutsHandler = new ShortcutsHandler(
            this.workspace,
            this.qmlObjects.shortcuts,
        );
        this.updateDrivers();
    }

    adoptOpenWindows() {
        for (const window of this.workspace.windows) {
            if (
                config().ignoreWindowClasses.test(window.resourceClass) ||
                config().ignoreWindowCaptions.test(window.caption)
            ) {
                continue;
            }
            const handler = new WindowHandler(window, this.workspace);
            this.windowHandlers.set(window, handler);
            this.previousDisplays.set(window, [
                ...Display.generateWindow(window),
            ]);
            for (const display of Display.generateWindow(window)) {
                const driver = this.getDriver(display);
                if (driver === undefined) {
                    continue;
                }
                driver.initializeWindow(window);
                if (
                    !handler.wantsTiled ||
                    !handler.canBeTiled() ||
                    window.tile == null
                ) {
                    driver.markAdoptedUntiled(window);
                }
            }
        }
        for (const display of Display.generate(
            this.workspace.desktops,
            this.workspace.activities,
            this.workspace.screens,
        )) {
            if (this.pendingAdoption.has(display.toSymbol())) {
                continue;
            }
            const driver = this.getDriver(display);
            if (driver === undefined) {
                continue;
            }
            const current = display.activity === this.workspace.currentActivity;
            const rootTile = current
                ? this.workspace.rootTile(display.output, display.desktop)
                : null;
            const hasTiledWindows = driver.adoptExistingWindows(rootTile);
            if (current && rootTile != null && hasTiledWindows) {
                driver.buildLayout(rootTile, display);
            }
        }
    }

    private resolveDisplayAdoption(display: Display): Display[] {
        const id = display.toSymbol();
        if (!this.pendingAdoption.delete(id)) {
            return [];
        }
        const driver = this.getDriver(display);
        if (driver === undefined) {
            return [];
        }
        const current = display.activity === this.workspace.currentActivity;
        const rootTile = current
            ? this.workspace.rootTile(display.output, display.desktop)
            : null;
        const shouldBuild = driver.adoptExistingWindows(rootTile);
        const placements = this.pendingPlacements.get(id);
        this.pendingPlacements.delete(id);
        if (placements !== undefined) {
            for (const [window, placement] of placements) {
                this.queueEvent(
                    {
                        t: "replayPlacement",
                        window,
                        display,
                        tilePath: placement.tilePath,
                        tileGeometry: placement.tileGeometry,
                        point: placement.point,
                        direction: placement.direction,
                    },
                    true,
                );
            }
        }
        const pendingToggle = this.pendingFocusToggles.get(id);
        this.pendingFocusToggles.delete(id);
        if (
            pendingToggle !== undefined &&
            pendingToggle.window === this.workspace.activeWindow
        ) {
            // Run after this batch has rebuilt the adopted display.
            this.queueEvent(
                {
                    t: "toggleSingleWindowView",
                    window: pendingToggle.window,
                    display: pendingToggle.display,
                },
                true,
            );
        }
        const activeWindow = this.workspace.activeWindow;
        if (
            this.focusMode !== null &&
            activeWindow !== null &&
            [...Display.generateWindow(activeWindow)].some((d) =>
                d.equals(display),
            )
        ) {
            this.queueEvent(
                { t: "windowActivated", window: activeWindow },
                true,
            );
        }
        return current && rootTile != null && shouldBuild ? [display] : [];
    }

    isFocusedWindow(window: Window, display?: Display): boolean {
        return (
            this.focusMode !== null &&
            this.focusMode.window === window &&
            (display === undefined || !!this.focusMode.display.equals(display))
        );
    }

    isFocusDetachSuspended(window: Window, display: Display): boolean {
        return !!this.focusDetachSuspensions.get(window)?.equals(display);
    }

    isProcessingEvents(): boolean {
        return this.processingEvents;
    }

    focusStackingForWindow(window: Window) {
        return this.focusMode?.window === window
            ? {
                  keepAbove: this.focusMode.keepAbove,
                  keepBelow: this.focusMode.keepBelow,
              }
            : null;
    }

    focusRestoreGeometryForWindow(window: Window): FocusGeometry | null {
        const mode = this.focusMode;
        return mode?.window === window && !mode.tiled
            ? copyFocusGeometry(mode.geometry)
            : null;
    }

    focusGeometryForWindow(window: Window): FocusGeometry | null {
        const mode = this.focusMode;
        return mode?.window === window
            ? copyFocusGeometry(mode.geometry)
            : null;
    }

    private tilePath(root: Tile, target: Tile): number[] | null {
        if (root === target) {
            return [];
        }
        for (let index = 0; index < root.tiles.length; index += 1) {
            const childPath = this.tilePath(root.tiles[index], target);
            if (childPath !== null) {
                return [index, ...childPath];
            }
        }
        return null;
    }

    private tileAtPath(root: Tile, path: number[]): Tile | null {
        let tile = root;
        for (const index of path) {
            if (index >= tile.tiles.length) {
                return null;
            }
            tile = tile.tiles[index];
        }
        return tile;
    }

    private tileGeometryMatches(
        tile: Tile,
        geometry: FocusGeometry | null,
    ): boolean {
        if (geometry === null) {
            return false;
        }
        const current = tile.absoluteGeometry;
        return (
            Math.abs(current.x - geometry.x) <= 1 &&
            Math.abs(current.y - geometry.y) <= 1 &&
            Math.abs(current.width - geometry.width) <= 1 &&
            Math.abs(current.height - geometry.height) <= 1
        );
    }

    focusSnapshotForWindow(window: Window): FocusSnapshot | null {
        const id = String(window.internalId);
        const snapshot = this.qmlObjects.root.getFocusSnapshot(id);
        if (snapshot === null) {
            return null;
        }
        if (!isFocusSnapshot(snapshot) || snapshot.windowId !== id) {
            this.qmlObjects.root.removeFocusSnapshot(id);
            return null;
        }
        return snapshot;
    }

    checkpointFocusForDetachment(window: Window): void {
        const mode = this.focusMode;
        if (mode === null || mode.window !== window) {
            return;
        }
        this.qmlObjects.root.saveFocusSnapshot(String(window.internalId), {
            windowId: String(window.internalId),
            desktopId: mode.display.desktop.id,
            activity: mode.display.activity,
            outputName: mode.display.output.name,
            geometry: copyFocusGeometry(mode.geometry),
            keepAbove: mode.keepAbove,
            keepBelow: mode.keepBelow,
            noBorder: mode.noBorder,
            tiled: mode.tiled,
            tilePath: mode.nativeTilePath,
            tileGeometry: mode.nativeTileGeometry,
        } as FocusSnapshot);
        if (mode.tiled) {
            this.focusDetachSuspensions.set(window, mode.display);
        }
    }

    clearFocusSnapshot(window: Window): void {
        this.qmlObjects.root.removeFocusSnapshot(String(window.internalId));
    }

    tiledIntentForWindow(window: Window): boolean | null {
        const intent = this.qmlObjects.root.getTiledIntent(
            String(window.internalId),
        );
        return typeof intent === "boolean" ? intent : null;
    }

    saveTiledIntent(window: Window, tiled: boolean): void {
        this.qmlObjects.root.saveTiledIntent(String(window.internalId), tiled);
    }

    clearTiledIntent(window: Window): void {
        this.qmlObjects.root.removeTiledIntent(String(window.internalId));
    }

    fullscreenStackingForWindow(window: Window): {
        keepAbove: boolean;
        keepBelow: boolean;
    } | null {
        const stacking = this.qmlObjects.root.getFullscreenStacking(
            String(window.internalId),
        ) as { keepAbove?: unknown; keepBelow?: unknown } | null;
        return stacking !== null &&
            typeof stacking.keepAbove === "boolean" &&
            typeof stacking.keepBelow === "boolean"
            ? { keepAbove: stacking.keepAbove, keepBelow: stacking.keepBelow }
            : null;
    }

    saveFullscreenStacking(
        window: Window,
        stacking: { keepAbove: boolean; keepBelow: boolean },
    ): void {
        this.qmlObjects.root.saveFullscreenStacking(
            String(window.internalId),
            stacking,
        );
    }

    clearFullscreenStacking(window: Window): void {
        this.qmlObjects.root.removeFullscreenStacking(
            String(window.internalId),
        );
    }

    private restoreFocusSnapshot(
        window: Window,
        snapshot: FocusSnapshot,
    ): void {
        const maximizeMode = (
            window as Window & { maximizeMode?: MaximizeMode }
        ).maximizeMode;
        if (
            !this.windowExists(window) ||
            window.fullScreen ||
            window.minimized ||
            (maximizeMode !== undefined &&
                maximizeMode !== MaximizeMode.MaximizeRestore)
        ) {
            return;
        }
        const sameDisplay =
            window.output.name === snapshot.outputName &&
            (window.onAllDesktops ||
                window.desktops.some(
                    (desktop) => desktop.id === snapshot.desktopId,
                )) &&
            (window.activities.length === 0 ||
                window.activities.includes(snapshot.activity));
        const display = sameDisplay
            ? this.parseDisplay(
                  JSON.stringify({
                      d: snapshot.desktopId,
                      a: snapshot.activity,
                      o: snapshot.outputName,
                  }),
              )
            : undefined;
        const driver =
            display === undefined ? undefined : this.getDriver(display);
        const rootTile =
            display === undefined
                ? null
                : this.workspace.rootTile(display.output, display.desktop);
        const tile =
            rootTile != null && snapshot.tilePath !== null
                ? this.tileAtPath(rootTile, snapshot.tilePath)
                : null;
        const handler = this.windowHandlers.get(window);
        try {
            if (
                window.tile === null &&
                window.output.name === snapshot.outputName
            ) {
                const { x, y, width, height } = snapshot.geometry;
                window.frameGeometry = qt().rect(x, y, width, height);
            }
            if (
                snapshot.tiled &&
                tile !== null &&
                driver !== undefined &&
                this.tileGeometryMatches(tile, snapshot.tileGeometry) &&
                (window.tile === null || window.tile === tile)
            ) {
                if (window.tile === null) {
                    if (handler !== undefined) {
                        handler.ignoreNextTilePlacement = true;
                    }
                    tile.manage(window);
                }
                driver.markAdoptedTiled(window);
            } else if (snapshot.tiled) {
                // The old path can now identify a different tile. Do not
                // rebuild over a manual native placement with stale engine data.
                if (window.tile !== null) {
                    driver?.preserveNativeLayout(rootTile);
                    driver?.markAdoptedTiled(window);
                    if (handler !== undefined) {
                        handler.wantsTiled = true;
                    }
                } else {
                    driver?.markAdoptedUntiled(window);
                    if (handler !== undefined) {
                        handler.wantsTiled = true;
                    }
                    if (
                        handler?.canBeTiled() &&
                        display !== undefined &&
                        driver !== undefined &&
                        !driver.usesNativeLayoutFallback() &&
                        driver.getEngineType() !== TilingEngineType.KWin
                    ) {
                        this.queueEvent(
                            { t: "restoreTiledWindow", window, display },
                            true,
                        );
                    }
                }
            }
            window.noBorder = snapshot.noBorder;
            window.keepAbove = snapshot.keepAbove;
            window.keepBelow = snapshot.keepBelow;
        } finally {
            const suspended = this.focusDetachSuspensions.delete(window);
            this.clearFocusSnapshot(window);
            if (suspended) {
                this.queueEvent({ t: "rebuildDisplays" }, true);
            }
        }
    }

    private restoreFocusGeometry(
        mode: FocusMode,
        targetDisplay: Display | null = null,
    ) {
        const { x, y, width, height } = mode.geometry;
        if (
            targetDisplay !== null &&
            targetDisplay.output !== mode.display.output
        ) {
            const area = this.workspace.clientArea(
                ClientAreaOption.MaximizeArea,
                targetDisplay.output,
                targetDisplay.desktop,
            );
            const fitWidth = Math.min(width, Math.max(1, area.width - 8));
            const fitHeight = Math.min(height, Math.max(1, area.height - 8));
            mode.window.frameGeometry = qt().rect(
                area.x + (area.width - fitWidth) / 2,
                area.y + (area.height - fitHeight) / 2,
                fitWidth,
                fitHeight,
            );
            return;
        }
        mode.window.frameGeometry = qt().rect(x, y, width, height);
    }

    private restoreFocusKeepAbove() {
        for (const window of this.focusKeepAboveWindows) {
            if (this.windowExists(window)) {
                window.keepAbove = true;
            }
        }
        this.focusKeepAboveWindows.clear();
    }

    private isFocusKeepAboveCandidate(
        window: Window,
        display: Display,
    ): boolean {
        if (!this.windowHandlers.has(window)) {
            return false;
        }
        if (
            !window.normalWindow ||
            window.specialWindow ||
            window.popupWindow ||
            window.transient
        ) {
            return false;
        }
        // Leave launchers free to appear over the focused window.
        if (
            window !== this.focusMode?.window &&
            window.skipTaskbar &&
            !window.moveable &&
            !window.resizeable
        ) {
            return false;
        }
        return (
            window.output === display.output &&
            (window.onAllDesktops ||
                window.desktops.includes(display.desktop)) &&
            (window.activities.length === 0 ||
                window.activities.includes(display.activity))
        );
    }

    private lowerFocusKeepAbove(display: Display) {
        for (const window of this.focusKeepAboveWindows) {
            if (
                this.windowExists(window) &&
                this.isFocusKeepAboveCandidate(window, display)
            ) {
                continue;
            }
            if (this.windowExists(window)) {
                window.keepAbove = true;
            }
            this.focusKeepAboveWindows.delete(window);
        }
        for (const window of this.workspace.windows) {
            const pending = this.windowHandlers
                .get(window)
                ?.pendingFullscreenStacking();
            if (
                window === this.focusMode?.window &&
                pending !== null &&
                pending !== undefined &&
                !pending.keepAbove
            ) {
                this.focusKeepAboveWindows.delete(window);
                if (window.keepAbove) {
                    window.keepAbove = false;
                }
                continue;
            }
            if (
                !window.keepAbove ||
                !this.isFocusKeepAboveCandidate(window, display)
            ) {
                continue;
            }
            this.focusKeepAboveWindows.add(window);
            window.keepAbove = false;
        }
    }

    private exitFocusMode(
        restoreGeometry = true,
        targetDisplay: Display | null = null,
        continueFocus = false,
    ): Display[] {
        const mode = this.focusMode;
        if (mode === null) {
            return [];
        }
        this.focusMode = null;
        if (this.windowExists(mode.window)) {
            const handler = this.windowHandlers.get(mode.window);
            if (mode.tiled && handler !== undefined) {
                handler.ignoreNextTilePlacement = true;
            }
            if (restoreGeometry) {
                this.restoreFocusGeometry(mode, targetDisplay);
            }
            if (!continueFocus) {
                mode.window.keepAbove = mode.keepAbove;
            }
            mode.window.keepBelow = mode.keepBelow;
            mode.window.noBorder = mode.noBorder;
            if (
                restoreGeometry &&
                mode.nativeTile !== null &&
                mode.window.tile == null &&
                !mode.window.fullScreen &&
                !mode.window.minimized &&
                !this.focusDetachSuspensions.has(mode.window) &&
                (targetDisplay === null || targetDisplay.equals(mode.display))
            ) {
                const rootTile = this.workspace.rootTile(
                    mode.display.output,
                    mode.display.desktop,
                );
                if (
                    rootTile != null &&
                    this.tilePath(rootTile, mode.nativeTile) !== null
                ) {
                    mode.nativeTile.manage(mode.window);
                    this.getDriver(mode.display)?.markAdoptedTiled(mode.window);
                }
            }
        }
        if (!continueFocus) {
            this.restoreFocusKeepAbove();
        }
        return [mode.display];
    }

    releaseFocusForWindow(window: Window, restoreGeometry = true) {
        if (this.isFocusedWindow(window)) {
            this.exitFocusMode(restoreGeometry);
        }
    }

    private focusDisplay(window: Window | null): Display | null {
        if (window == null || window.output == null) {
            return null;
        }
        return new Display(
            this.workspace.currentDesktop,
            this.workspace.currentActivity,
            window.output,
        );
    }

    private focusGeometry(display: Display) {
        const area = this.workspace.clientArea(
            ClientAreaOption.MaximizeArea,
            display.output,
            display.desktop,
        );
        // A small inset lets an auto-hide panel reveal without maximizing the window.
        return qt().rect(
            area.x + 4,
            area.y + 4,
            area.width - 8,
            area.height - 8,
        );
    }

    applyFocusGeometry(display: Display, driver: Driver) {
        const mode = this.focusMode;
        if (
            mode === null ||
            !mode.display.equals(display) ||
            !driver.hasWindow(mode.window) ||
            !this.windowExists(mode.window)
        ) {
            return;
        }
        const window = mode.window;
        if (window.tile != null) {
            window.tile.unmanage(window);
        }
        window.keepBelow = false;
        this.lowerFocusKeepAbove(display);
        window.noBorder = false;
        window.frameGeometry = this.focusGeometry(display);
    }

    private focusTargetDriver(
        window: Window | null,
        display: Display | null,
    ): Driver | null {
        if (window === null || display === null || !this.windowExists(window)) {
            return null;
        }
        if (
            !window.normalWindow ||
            window.specialWindow ||
            window.popupWindow ||
            window.transient ||
            window.fullScreen ||
            window.minimized ||
            !window.moveable ||
            !window.resizeable
        ) {
            return null;
        }
        const driver = this.getDriver(display);
        if (driver === undefined || !driver.hasWindow(window)) {
            return null;
        }
        if (driver.isWindowTiled(window) !== (window.tile != null)) {
            return null;
        }
        return driver;
    }

    private enterFocusMode(
        window: Window | null,
        display: Display | null,
    ): Display[] {
        const driver = this.focusTargetDriver(window, display);
        if (driver === null || window === null || display === null) {
            return [];
        }
        const tiled = driver.isWindowTiled(window) === true;
        const geometry = window.frameGeometry;
        const borders = config().borders;
        const activeBorder = tiled
            ? borders === Borders.Active || borders === Borders.FloatingActive
            : borders === Borders.Floating ||
              borders === Borders.FloatingActive;
        const stacking = this.windowHandlers
            .get(window)
            ?.pendingFullscreenStacking();
        if (stacking !== null && stacking !== undefined) {
            if (!stacking.keepAbove) {
                this.focusKeepAboveWindows.delete(window);
            }
            window.keepAbove = stacking.keepAbove;
            window.keepBelow = stacking.keepBelow;
        }
        const nativeTile = tiled ? window.tile : null;
        const rootTile = this.workspace.rootTile(
            display.output,
            display.desktop,
        );
        const nativeTilePath =
            nativeTile !== null && rootTile != null
                ? this.tilePath(rootTile, nativeTile)
                : null;
        const tileGeometry = nativeTile?.absoluteGeometry;
        this.focusMode = {
            window,
            display,
            // KWin may mutate a QRectF after resizing, so retain its numbers.
            geometry: {
                x: geometry.x,
                y: geometry.y,
                width: geometry.width,
                height: geometry.height,
            },
            keepAbove: stacking?.keepAbove ?? window.keepAbove,
            keepBelow: stacking?.keepBelow ?? window.keepBelow,
            noBorder: activeBorder ? false : window.noBorder,
            tiled,
            nativeTile,
            nativeTilePath,
            nativeTileGeometry:
                tileGeometry === undefined
                    ? null
                    : {
                          x: tileGeometry.x,
                          y: tileGeometry.y,
                          width: tileGeometry.width,
                          height: tileGeometry.height,
                      },
        };
        window.keepBelow = false;
        window.noBorder = false;
        this.lowerFocusKeepAbove(display);
        if (tiled && window.tile != null) {
            window.tile.unmanage(window);
        }
        this.applyFocusGeometry(display, driver);
        return [display];
    }

    private evToggleSingleWindowView(
        window: Window | null,
        display?: Display,
    ): Display[] {
        if (this.focusMode !== null) {
            return this.exitFocusMode();
        }
        if (
            display !== undefined &&
            this.pendingAdoption.has(display.toSymbol())
        ) {
            const id = display.toSymbol();
            if (this.pendingFocusToggles.has(id)) {
                this.pendingFocusToggles.delete(id);
            } else {
                this.pendingFocusToggles.set(id, { window, display });
            }
            return [];
        }
        return this.enterFocusMode(window, display ?? null);
    }

    cleanup() {
        this.disposed = true;
        const mode = this.focusMode;
        if (mode === null) {
            this.restoreFocusKeepAbove();
        } else {
            this.exitFocusMode();
            if (this.windowExists(mode.window)) {
                const driver = this.getDriver(mode.display);
                const rootTile = this.workspace.rootTile(
                    mode.display.output,
                    mode.display.desktop,
                );
                if (driver !== undefined && rootTile != null) {
                    driver.buildLayout(rootTile, mode.display);
                } else {
                    this.restoreFocusGeometry(mode);
                }
            }
        }
        for (const [window, handler] of this.windowHandlers) {
            const stacking = handler.fullscreenStackingForCleanup();
            if (stacking === null || !this.windowExists(window)) {
                continue;
            }
            window.keepAbove = stacking.keepAbove;
            window.keepBelow = stacking.keepBelow;
        }
        this.workspaceHandler.dispose();
        for (const handler of this.windowHandlers.values()) {
            handler.dispose();
        }
        for (const driver of this.drivers.values()) {
            driver.dispose();
        }
    }

    queueEvent(ev: Event, forcePush: boolean = false) {
        if (this.disposed) {
            return;
        }
        // dont add events if processing because processing itself causes a lot of signals to trigger
        if (this.processingEvents && !forcePush) return;
        this.eventQueue.push(ev);
        this.eventTimer.start();
    }

    queuePostEvent(ev: PostEvent, forcePush: boolean = false) {
        if (this.disposed) {
            return;
        }
        if (this.processingEvents && !forcePush) return;
        this.postEventQueue.push(ev);
        this.eventTimer.start();
    }

    private processEvents() {
        if (this.disposed) {
            return;
        }
        this.processingEvents = true;
        try {
            this.processEventBatch();
        } catch (error) {
            console().error("event batch failed", error);
        } finally {
            this.processingEvents = false;
        }
    }

    private processEventBatch() {
        const queue = simplifyEvents(this.eventQueue);
        this.eventQueue = new Queue<Event>();
        console().debug("Handling", queue.size, "event(s)");
        const rebuildDisplays = new Map<DisplaySymbol, Display>();
        while (!queue.isEmpty) {
            const ev = queue.pop();
            if (ev === undefined) {
                break;
            }
            const displays = this.handleEvent(ev);
            for (const display of displays) {
                rebuildDisplays.set(display.toSymbol(), display);
            }
        }
        for (const [_, display] of rebuildDisplays) {
            if (display.desktop == undefined || display.output == undefined) {
                continue;
            }
            // dont rebuild for other activities because tiles are shared between them
            if (display.activity !== this.workspace.currentActivity) {
                continue;
            }
            console().debug("Rebuilding for display", display.toString());
            const driver = this.getDriver(display);
            const rootTile = this.workspace.rootTile(
                display.output,
                display.desktop,
            );
            if (driver != undefined && rootTile != undefined) {
                if (this.pendingAdoption.has(display.toSymbol())) {
                    continue;
                }
                driver.buildLayout(rootTile, display);
            } else {
                console().error(
                    "no driver found for display",
                    display.toString(),
                );
                continue;
            }
        }
        const postQueue = simplifyPostEvents(this.postEventQueue);
        this.postEventQueue = new Queue<PostEvent>();
        console().debug("Handling", postQueue.size, "post event(s)");
        while (!postQueue.isEmpty) {
            const ev = postQueue.pop();
            if (ev === undefined) {
                break;
            }
            try {
                this.handlePostEvent(ev);
            } catch (error) {
                console().error("post event failed", ev.t, error);
            }
        }
    }

    // returns a list of displays that need a rebuild
    // one event returning yes guarantees a rebuild
    // error handling - break in case statement to exit and log error message
    private handleEvent(ev: Event): Display[] {
        console().debug("handling event", ev.t);
        try {
            switch (ev.t) {
                case "newWindow":
                    return this.evNewWindow(
                        ev.window,
                        ev.forceTile,
                        ev.tile,
                        ev.direction,
                    );
                case "deleteWindow":
                    return this.evDeleteWindow(ev.window, ev.displays);
                case "updateWindow":
                    return this.evUpdateWindow(ev.window);
                case "tileWindow":
                    return this.evTileWindow(ev.window);
                case "restoreTiledWindow":
                    return this.evRestoreTiledWindow(ev.window, ev.display);
                case "untileWindow":
                    return this.evUntileWindow(ev.window);
                case "placeWindow":
                    return this.evPlaceWindow(ev.window, ev.tile, ev.direction);
                case "placeWindowPoint":
                    return this.evPlaceWindowPoint(ev.window, ev.point);
                case "replayPlacement":
                    return this.evReplayPlacement(
                        ev.window,
                        ev.display,
                        ev.tilePath,
                        ev.tileGeometry,
                        ev.point,
                        ev.direction,
                    );
                case "windowActivated":
                    return this.evWindowActivated(ev.window);
                case "updateDrivers":
                    return this.updateDrivers();
                case "settingsResolved":
                    return this.evSettingsResolved(
                        ev.display,
                        ev.engineType,
                        ev.engineSettings,
                    );
                case "rebuildDisplays":
                    return this.displaysToRebuild();
                case "updateTiles":
                    return this.evUpdateTiles(ev.display, ev.rebuild);
                case "changeEngine":
                    return this.evChangeEngine(
                        ev.display,
                        ev.engineType,
                        ev.engineSettings,
                        ev.noDBusUpdate,
                    );
                case "resetEngine":
                    return this.evResetEngine(ev.display);
                case "toggleSingleWindowView":
                    return this.evToggleSingleWindowView(ev.window, ev.display);
                default: {
                    console().error("invalid event type", (ev as any).t);
                    return [];
                }
            }
        } catch (e) {
            console().error("event type", ev.t, "failed to execute");
            console().error("error message -", (e as Error).message);
        }
        return [];
    }

    private evNewWindow(
        window: Window,
        forceTile: boolean | undefined,
        tile: Tile | undefined,
        direction: Direction | undefined,
    ): Display[] {
        if (this.windowHandlers.has(window)) {
            return [];
        }
        console().log("registering window", window.resourceClass);
        const handler = new WindowHandler(window, this.workspace);
        this.windowHandlers.set(window, handler);
        this.previousDisplays.set(window, [...Display.generateWindow(window)]);
        const ret = [];
        for (const display of Display.generateWindow(window)) {
            const driver = this.getDriver(display);
            if (driver === undefined) {
                continue;
            }
            if (this.pendingAdoption.has(display.toSymbol())) {
                driver.initializeWindow(window);
                driver.markPendingNewWindow(window);
                if (
                    forceTile === false ||
                    (forceTile === undefined && !handler.wantsTiled) ||
                    !handler.canBeTiled()
                ) {
                    driver.markAdoptedUntiled(window);
                }
                continue;
            }
            if (
                forceTile === false ||
                (forceTile === undefined &&
                    (!handler.wantsTiled || !handler.canBeTiled()))
            ) {
                driver.addWindowUntiled(window);
            } else if (
                forceTile === true &&
                tile != undefined &&
                driver.hasTile(tile)
            ) {
                driver.placeWindow(window, tile, direction);
            } else {
                driver.addWindow(window, tile, direction);
            }
            ret.push(display);
        }
        if (this.focusMode !== null) {
            // Activation can precede registration. Retry after this batch builds the layout.
            // The retry is ignored if another window has become active meanwhile.
            this.queueEvent({ t: "windowActivated", window }, true);
        }
        return ret;
    }
    private evDeleteWindow(window: Window, displays: Display[]): Display[] {
        this.clearFocusSnapshot(window);
        this.clearTiledIntent(window);
        this.clearFullscreenStacking(window);
        this.focusDetachSuspensions.delete(window);
        if (this.isFocusedWindow(window)) {
            this.focusMode = null;
            this.restoreFocusKeepAbove();
        }
        this.focusKeepAboveWindows.delete(window);
        console().log("destroying window", window.resourceClass);
        if (this.previousDisplays.has(window)) {
            this.previousDisplays.delete(window);
        }
        const ret = [];
        for (const display of displays) {
            this.getDriver(display)?.removeWindow(window);
            ret.push(display);
        }
        this.windowHandlers.get(window)?.dispose();
        this.windowHandlers.delete(window);
        return ret;
    }
    private evUpdateWindow(window: Window): Display[] {
        console().log("updating window", window.resourceClass);
        if (this.focusMode !== null) {
            this.lowerFocusKeepAbove(this.focusMode.display);
        }
        const newDisplays = [...Display.generateWindow(window)];
        const mode = this.isFocusedWindow(window) ? this.focusMode : null;
        const changedDisplay =
            mode !== null && !newDisplays.some((d) => d.equals(mode.display));
        const destination =
            newDisplays.find(
                (d) =>
                    d.desktop === this.workspace.currentDesktop &&
                    d.activity === this.workspace.currentActivity,
            ) ??
            newDisplays[0] ??
            null;
        const focusDisplays = changedDisplay
            ? this.exitFocusMode(!mode.tiled, destination)
            : [];
        const oldDisplays = this.previousDisplays.get(window);
        if (oldDisplays === undefined) {
            return focusDisplays;
        }
        let tiled = false;
        const ret = [...focusDisplays];
        for (const oldDisplay of oldDisplays) {
            const driver = this.getDriver(oldDisplay);
            if (driver === undefined) {
                continue;
            }
            if (driver.isWindowTiled(window)) {
                tiled = true;
            }
            if (newDisplays.some((d) => d.equals(oldDisplay))) {
                continue;
            }
            driver.removeWindow(window);
            ret.push(oldDisplay);
        }
        for (const newDisplay of newDisplays) {
            if (oldDisplays.some((d) => d.equals(newDisplay))) {
                continue;
            }
            const driver = this.getDriver(newDisplay);
            if (driver === undefined) {
                continue;
            }
            if (this.pendingAdoption.has(newDisplay.toSymbol())) {
                driver.initializeWindow(window);
                if (!tiled) {
                    driver.markAdoptedUntiled(window);
                }
                continue;
            }
            if (tiled) {
                driver.addWindow(window);
            } else {
                driver.addWindowUntiled(window);
            }
            ret.push(newDisplay);
        }
        this.previousDisplays.set(window, newDisplays);
        return ret;
    }
    private evTileWindow(window: Window): Display[] {
        console().log("tiling window", window.resourceClass);
        const ret = [];
        for (const display of Display.generateWindow(window)) {
            const driver = this.getDriver(display);
            if (driver === undefined) {
                throw new Error(
                    "driver not found for display " + display.toString(),
                );
            }
            if (this.pendingAdoption.has(display.toSymbol())) {
                driver.recordPendingTileChange(window, true);
                continue;
            }
            ret.push(display);
            driver.tileWindow(window);
        }
        return ret;
    }
    private evRestoreTiledWindow(window: Window, display: Display): Display[] {
        if (
            !this.windowExists(window) ||
            ![...Display.generateWindow(window)].some((d) => d.equals(display))
        ) {
            return [];
        }
        const driver = this.getDriver(display);
        const handler = this.windowHandlers.get(window);
        if (
            driver === undefined ||
            !driver.hasWindow(window) ||
            driver.usesNativeLayoutFallback() ||
            driver.getEngineType() === TilingEngineType.KWin ||
            !handler?.wantsTiled ||
            !handler.canBeTiled()
        ) {
            return [];
        }
        if (this.pendingAdoption.has(display.toSymbol())) {
            driver.recordPendingTileChange(window, true);
            return [];
        }
        if (!driver.isWindowTiled(window)) {
            driver.tileWindow(window);
            return [display];
        }
        return [];
    }
    private evUntileWindow(window: Window): Display[] {
        console().log("untiling window", window.resourceClass);
        this.windowHandlers.get(window)?.clearTilePlacementSuppression();
        const ret = [];
        for (const display of Display.generateWindow(window)) {
            const driver = this.getDriver(display);
            if (driver === undefined) {
                throw new Error(
                    "driver not found for display " + display.toString(),
                );
            }
            if (this.pendingAdoption.has(display.toSymbol())) {
                driver.recordPendingTileChange(window, false);
                continue;
            }
            ret.push(display);
            driver.untileWindow(window);
        }
        return ret;
    }
    private evPlaceWindow(
        window: Window,
        tile: Tile,
        direction: Direction | undefined,
    ): Display[] {
        console().log(
            "placing window",
            window.resourceClass,
            "in tile at",
            tile.absoluteGeometry,
        );
        const displays = [];
        for (const display of Display.generateWindow(window)) {
            const driver = this.getDriver(display);
            if (driver == undefined) continue;
            if (this.pendingAdoption.has(display.toSymbol())) {
                driver.recordPendingTileChange(window, true);
                const rootTile = this.workspace.rootTile(
                    display.output,
                    display.desktop,
                );
                this.recordPendingPlacement(display, window, {
                    tilePath:
                        rootTile === null
                            ? null
                            : this.tilePath(rootTile, tile),
                    tileGeometry: {
                        x: tile.absoluteGeometry.x,
                        y: tile.absoluteGeometry.y,
                        width: tile.absoluteGeometry.width,
                        height: tile.absoluteGeometry.height,
                    },
                    direction,
                });
                continue;
            }
            if (!driver.hasTile(tile)) {
                if (driver.hasWindow(window)) {
                    driver.tileWindow(window);
                } else {
                    driver.addWindow(window);
                }
                continue;
            }
            driver.placeWindow(window, tile, direction);
            displays.push(display);
        }
        return displays;
    }
    private evPlaceWindowPoint(window: Window, point: QPoint): Display[] {
        console().log(
            "placing window",
            window.resourceClass,
            "at point",
            point,
        );
        //const output = this.workspace.screenAt(point);
        const displays = [];
        for (const display of Display.generateWindow(window)) {
            // dont do this as window.output is readonly
            /*
            let display = windowDisplay;
            // if the target output is different than the window output
            // then remove the window from the old output
            if (display.output !== output) {
                this.getDriver(display)?.removeWindow(window);
                displays.push(display);
                display = new Display(
                    display.desktop,
                    display.activity,
                    output,
                );
            }
            */
            const driver = this.getDriver(display);
            if (driver == undefined) continue;
            if (this.pendingAdoption.has(display.toSymbol())) {
                driver.recordPendingTileChange(window, true);
                this.recordPendingPlacement(display, window, {
                    point: qt().point(point.x, point.y),
                });
                continue;
            }
            displays.push(display);
            // can only get tiles for current activity
            if (display.activity !== this.workspace.currentActivity) {
                if (driver.hasWindow(window)) {
                    driver.tileWindow(window);
                } else {
                    driver.addWindow(window);
                }
                continue;
            }
            const rootTile = this.workspace.rootTile(
                display.output,
                display.desktop,
            );
            const tile =
                rootTile.tiles.length == 0 ? rootTile : rootTile.pick(point);
            if (tile === null || !driver.hasTile(tile)) {
                if (driver.hasWindow(window)) {
                    driver.tileWindow(window);
                } else {
                    driver.addWindow(window);
                }
            } else {
                const direction = directionFromPoint(
                    tile.absoluteGeometry,
                    point,
                );
                driver.placeWindow(window, tile, direction);
            }
        }
        /*
        if (output !== window.output) {
            window.output = output;
        }
        */
        return displays;
    }
    private recordPendingPlacement(
        display: Display,
        window: Window,
        placement: {
            tilePath?: number[] | null;
            tileGeometry?: FocusGeometry;
            point?: QPoint;
            direction?: Direction;
        },
    ): void {
        const id = display.toSymbol();
        let placements = this.pendingPlacements.get(id);
        if (placements === undefined) {
            placements = new Map();
            this.pendingPlacements.set(id, placements);
        }
        placements.set(window, placement);
    }

    private evReplayPlacement(
        window: Window,
        display: Display,
        path?: number[] | null,
        geometry?: FocusGeometry,
        point?: QPoint,
        direction?: Direction,
    ): Display[] {
        if (
            !this.windowExists(window) ||
            ![...Display.generateWindow(window)].some((d) => d.equals(display))
        ) {
            return [];
        }
        const driver = this.getDriver(display);
        if (driver === undefined || !driver.hasWindow(window)) {
            return [];
        }
        const rootTile =
            display.activity === this.workspace.currentActivity
                ? this.workspace.rootTile(display.output, display.desktop)
                : null;
        const tile =
            rootTile === null
                ? null
                : point !== undefined
                  ? rootTile.pick(point)
                  : path !== undefined && path !== null
                    ? this.tileAtPath(rootTile, path)
                    : null;
        if (
            tile !== null &&
            driver.hasTile(tile) &&
            (point !== undefined ||
                this.tileGeometryMatches(tile, geometry ?? null))
        ) {
            driver.placeWindow(
                window,
                tile,
                point === undefined
                    ? direction
                    : directionFromPoint(tile.absoluteGeometry, point),
            );
            return [display];
        }
        if (!driver.isWindowTiled(window)) {
            driver.tileWindow(window);
            return [display];
        }
        return [];
    }
    private evWindowActivated(window: Window | null): Display[] {
        if (window !== this.workspace.activeWindow) {
            return [];
        }
        if (window === null) {
            return this.exitFocusMode();
        }
        console().log("window activated", window.resourceClass);
        const displays = [];
        if (this.isFocusedWindow(window)) {
            this.lowerFocusKeepAbove(this.focusMode!.display);
        } else if (this.focusMode !== null) {
            const display = this.focusDisplay(window);
            if (this.focusTargetDriver(window, display) !== null) {
                displays.push(...this.exitFocusMode(true, null, true));
                displays.push(...this.enterFocusMode(window, display));
                if (this.focusMode === null) {
                    this.restoreFocusKeepAbove();
                }
            }
        }
        for (const display of Display.generateWindow(window)) {
            const driver = this.getDriver(display);
            if (driver == undefined) continue;
            if (driver.windowActivated(window)) {
                displays.push(display);
            }
        }
        return displays;
    }
    private updateDrivers(): Display[] {
        const ret = [];
        for (const display of Display.generate(
            this.workspace.desktops,
            this.workspace.activities,
            this.workspace.screens,
        )) {
            const id = display.toSymbol();
            const driver = this.drivers.get(id);
            if (driver === undefined) {
                console().debug(
                    "adding driver for display",
                    display.toString(),
                );
                const driver = new Driver(config().defaultEngine);
                if (this.dbusHandler !== null) {
                    driver.setAdoptionPending(true);
                    this.pendingAdoption.add(id);
                }
                this.drivers.set(id, driver);
                this.dbusHandler?.getSettings(display);
                ret.push(display);
            }
        }
        return ret;
    }
    private displaysToRebuild(): Display[] {
        const displays = [];
        for (const display of Display.generate(
            this.workspace.desktops,
            [this.workspace.currentActivity],
            this.workspace.screens,
        )) {
            // make sure the driver exists and if it doesnt try to create it
            if (this.getDriver(display) !== undefined) {
                displays.push(display);
            }
        }
        return displays;
    }
    private evUpdateTiles(display: Display, rebuild: boolean): Display[] {
        console().log("updating tiles for display", display.toString());
        const driver = this.getDriver(display);
        if (driver === undefined) {
            return [];
        }
        // sometimes changing tiles updates engine settings so make sure to send out for dbus
        const oldSettings = JSON.stringify(driver.getEngineSettings());
        driver.updateTiles();
        const settings = driver.getEngineSettings();
        // dont need to update dialog as it should be impossible to update tiles with it open
        if (oldSettings !== JSON.stringify(settings)) {
            this.dbusHandler?.setSettings(
                display,
                driver.getEngineType(),
                settings,
            );
        }
        return rebuild ? [display] : [];
    }
    private evSettingsResolved(
        display: Display,
        engineType: TilingEngineType | undefined,
        engineSettings: object | undefined,
    ): Display[] {
        // A user may have chosen an engine while the saver was still replying.
        // That choice has already completed adoption and must win over this reply.
        if (!this.pendingAdoption.has(display.toSymbol())) {
            return [];
        }
        let changed: Display[] = [];
        try {
            if (engineType !== undefined || engineSettings !== undefined) {
                changed = this.evChangeEngine(
                    display,
                    engineType,
                    engineSettings,
                    true,
                );
            }
        } finally {
            // A malformed saved layout must not leave this display blocked.
            const adopted = this.resolveDisplayAdoption(display);
            if (adopted.length > 0) {
                changed = adopted;
            }
        }
        return changed;
    }

    private evChangeEngine(
        display: Display,
        engineType: TilingEngineType | undefined,
        engineSettings: object | undefined,
        noDBusUpdate: boolean | undefined,
    ): Display[] {
        console().log(
            "changing engine type/settings for display",
            display.toString(),
        );
        const driver = this.getDriver(display);
        if (driver === undefined) {
            throw new Error("no driver for display " + display.toString());
        }
        const pending = this.pendingAdoption.has(display.toSymbol());
        const oldEngine = driver.getEngineType();
        const oldSettings = JSON.stringify(driver.getEngineSettings());
        driver.changeTilingEngine(engineType, engineSettings);
        // only rebuild if something changed
        const engine = driver.getEngineType();
        const settings = driver.getEngineSettings();
        const changed =
            oldEngine !== engine || oldSettings !== JSON.stringify(settings);
        if (changed && this.settingsHandler.isVisible()) {
            this.settingsHandler.show(display, engine, settings);
        }
        // Persist an explicit choice even if it equals the temporary default.
        if (!noDBusUpdate && (changed || pending)) {
            this.dbusHandler?.setSettings(display, engine, settings);
        }
        const adopted =
            pending && !noDBusUpdate
                ? this.resolveDisplayAdoption(display)
                : [];
        return changed ? [display] : adopted;
    }
    private evResetEngine(display: Display): Display[] {
        console().log(
            "resetting to default engine settings for display",
            display.toString(),
        );
        const driver = this.getDriver(display);
        if (driver === undefined) {
            throw new Error(
                "driver undefined for display " + display.toString(),
            );
        }
        const pending = this.pendingAdoption.has(display.toSymbol());
        const oldEngine = driver.getEngineType();
        const oldSettings = JSON.stringify(driver.getEngineSettings());
        driver.resetTilingEngine();
        // reset dbus handler regardless of if anything changes
        this.dbusHandler?.resetSettings(display);
        const engine = driver.getEngineType();
        const settings = driver.getEngineSettings();
        const changed =
            oldEngine !== engine || oldSettings !== JSON.stringify(settings);
        if (changed && this.settingsHandler.isVisible()) {
            this.settingsHandler.show(display, engine, settings);
        }
        const adopted = pending ? this.resolveDisplayAdoption(display) : [];
        return changed ? [display] : adopted;
    }

    private handlePostEvent(ev: PostEvent) {
        console().debug("handling post event", ev.t);
        switch (ev.t) {
            case "restoreFocusSnapshot": {
                this.restoreFocusSnapshot(ev.window, ev.snapshot);
                return;
            }
            case "setWindowProperties": {
                if (!this.windowExists(ev.window)) {
                    break;
                }
                if (ev.fullscreenStacking && ev.window.fullScreen) {
                    this.windowHandlers
                        .get(ev.window)
                        ?.clearPendingFullscreenStacking(ev.fullscreenStacking);
                    return;
                }
                console().log(
                    "setting properties for window",
                    ev.window.resourceClass,
                );
                if (ev.fullscreen !== undefined) {
                    ev.window.fullScreen = ev.fullscreen;
                }
                if (ev.noBorder !== undefined) {
                    ev.window.noBorder = ev.noBorder;
                }
                if (ev.fullscreenStacking !== undefined) {
                    if (!ev.fullscreenStacking.keepAbove) {
                        this.focusKeepAboveWindows.delete(ev.window);
                    }
                    if (this.isFocusedWindow(ev.window)) {
                        ev.window.keepAbove = false;
                        ev.window.keepBelow = false;
                    } else {
                        ev.window.keepAbove = ev.fullscreenStacking.keepAbove;
                        ev.window.keepBelow = ev.fullscreenStacking.keepBelow;
                    }
                    if (this.focusMode !== null) {
                        this.lowerFocusKeepAbove(this.focusMode.display);
                    }
                    this.windowHandlers
                        .get(ev.window)
                        ?.clearPendingFullscreenStacking(ev.fullscreenStacking);
                } else {
                    if (ev.keepAbove !== undefined) {
                        ev.window.keepAbove = ev.keepAbove;
                    }
                    if (ev.keepBelow !== undefined) {
                        ev.window.keepBelow = ev.keepBelow;
                    }
                }
                if (ev.geometry !== undefined) {
                    const { x, y, width, height } = ev.geometry;
                    ev.window.frameGeometry = qt().rect(x, y, width, height);
                }
                return;
            }
            case "toggleSettingsMenu": {
                console().log("toggling settings menu");
                if (this.settingsHandler.isVisible()) {
                    this.settingsHandler.hide();
                    return;
                }
                const driver = this.getDriver(ev.display);
                if (driver === undefined) {
                    break;
                }
                this.settingsHandler.show(
                    ev.display,
                    driver.getEngineType(),
                    driver.getEngineSettings(),
                );
                return;
            }
            default: {
                console().error("invalid post event type", (ev as any).t);
                return;
            }
        }
        console().error("post event type", ev.t, "failed to execute");
        return;
    }

    parseDisplay(display: DisplaySymbol | string): Display | undefined {
        let str: string | undefined;
        if (typeof display === "symbol") {
            str = Symbol.keyFor(display);
        } else if (typeof display === "string") {
            str = display;
        }
        if (str === undefined) {
            return undefined;
        }
        let parsed: any;
        try {
            parsed = JSON.parse(str);
        } catch (_) {
            return undefined;
        }
        const d = this.workspace.desktops.find((d) => d.id === parsed.d);
        const a = this.workspace.activities.find((a) => a === parsed.a);
        const o = this.workspace.screens.find((s) => s.name === parsed.o);
        if (d === undefined || a === undefined || o === undefined) {
            return undefined;
        }
        return new Display(d, a, o);
    }

    // gets a driver, if it doesn't exist then it calls updateDrivers and tries to get it again.
    // if it still doesn't exist, then it returns undefined.
    private getDriver(
        display: Display | DisplaySymbol | string,
    ): Driver | undefined {
        let id: DisplaySymbol;
        if (typeof display === "string") {
            id = Symbol.for(display);
        } else if (typeof display === "symbol") {
            id = display;
        } else if (typeof display === "object") {
            id = (display as Display).toSymbol();
        } else {
            console().error("Invalid call to getDriver");
            return undefined;
        }
        let driver = this.drivers.get(id);
        if (driver !== undefined) return driver;
        console().warn(
            "driver not found for id",
            id,
            "updating drivers and trying again",
        );
        this.updateDrivers();
        driver = this.drivers.get(id);
        if (driver === undefined) {
            console().error("driver was still not found for id", id);
        }
        return driver;
    }

    getWindowHandler(window: Window): WindowHandler | undefined {
        return this.windowHandlers.get(window);
    }

    // sometimes the window can be destroyed before rebuild but the ref will still exist, so make sure it exists before calling stuff on it
    windowExists(window: Window | null | undefined): boolean {
        return (
            window !== null &&
            window !== undefined &&
            this.workspace.windows.includes(window)
        );
    }
    // avoid making driver instance public and get current tiling layout to enable cycling
    getEngineType(display: Display): TilingEngineType | undefined {
        return this.drivers.get(display.toSymbol())?.getEngineType();
    }

    isWindowTiled(window: Window, display?: Display): boolean | undefined {
        if (display != undefined) {
            return this.getDriver(display)?.isWindowTiled(window);
        }
        for (const display of Display.generateWindow(window)) {
            const driver = this.getDriver(display);
            if (driver?.isWindowTiled(window)) {
                return true;
            }
        }
        return false;
    }
}

let controllerObj: Controller;
let consoleObj: Console;
let configObj: Config;
let qtObject: Qt;

export function initializeController(qmlApi: QmlApi, qmlObjects: QmlObjects) {
    configObj = new Config(qmlApi.kwin);
    consoleObj = new Console(qmlApi.console);
    qtObject = qmlApi.qt;
    console().debug("config -", JSON.stringify(config()));
    controllerObj = new Controller(qmlApi, qmlObjects);
    console().log("controller initialized. Welcome to Polonium!");
}

// controller should exist at all points other than right after initialization
// also it creates everything that would call this, so logically it should exist(?)
export function controller(): Controller {
    return controllerObj;
}
export function console(): Console {
    return consoleObj;
}
export function config(): Config {
    return configObj;
}
export function qt(): Qt {
    return qtObject;
}
