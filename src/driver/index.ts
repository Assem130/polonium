import {
    Tile as KwinTile,
    Window as KwinWindow,
    LayoutDirection,
} from "kwin-api";
import {
    Tile as EngineTile,
    Window as EngineWindow,
    TilingEngine,
    TilingEngineType,
} from "../engine";
import { buildLayout } from "./buildlayout";
import { config, console, controller as ctrl } from "../controller";
import { Direction } from "../util";
import { Borders, UltrawidePosition } from "../controller/config";
import { updateTiles } from "./updatetiles";
import { Display } from "../controller/event";

export class Driver {
    private engineRootTile: EngineTile | null = null;
    private tileMap: Map<KwinTile, EngineTile> = new Map();
    private placementTileMap: Map<KwinTile, EngineTile> = new Map();
    private hookedTiles: Set<KwinTile> = new Set();
    private tileCallbacks: Map<
        KwinTile,
        { geometry: () => void; children: () => void }
    > = new Map();
    private windowMap: Map<KwinWindow, EngineWindow> = new Map();
    private untiledWindows: Set<KwinWindow> = new Set();
    private pendingNewWindows: Set<KwinWindow> = new Set();
    private pendingTileChanges: Map<KwinWindow, boolean> = new Map();
    private savedActiveWindow: KwinWindow | null = null;
    private adoptionPending = false;
    private nativeLayoutFallback = false;
    private nativeRootTile: KwinTile | null = null;
    private kwinImportPending = false;
    private preserveNativeLayoutOnce = false;

    private tilingEngine: TilingEngine;

    constructor(engineType: TilingEngineType, engineSettings?: object) {
        if (engineSettings === undefined) {
            engineSettings = getConfigEngineSettings(engineType);
        }
        this.tilingEngine = new TilingEngine(engineType, engineSettings);
    }

    private setEngineType(
        engineType: TilingEngineType,
        engineSettings: object,
    ): void {
        const wasNativeLayout = this.nativeLayoutFallback;
        this.tilingEngine = new TilingEngine(engineType, engineSettings);
        this.nativeLayoutFallback = false;
        this.kwinImportPending = engineType === TilingEngineType.KWin;
        this.preserveNativeLayoutOnce = false;
        if (!this.adoptionPending) {
            for (const [kwinWindow, engineWindow] of this.windowMap) {
                const tiled = wasNativeLayout
                    ? kwinWindow.tile != null ||
                      ctrl().isFocusedWindow(kwinWindow) ||
                      !this.untiledWindows.has(kwinWindow)
                    : !this.untiledWindows.has(kwinWindow);
                if (wasNativeLayout) {
                    if (tiled) {
                        this.untiledWindows.delete(kwinWindow);
                    } else {
                        this.untiledWindows.add(kwinWindow);
                    }
                }
                if (tiled && !this.kwinImportPending) {
                    this.tilingEngine.addWindow(engineWindow);
                }
            }
        }
    }

    changeTilingEngine(
        engineType?: TilingEngineType,
        engineSettings?: object,
    ): void {
        if (
            engineType !== undefined &&
            this.tilingEngine.engineType != engineType
        ) {
            if (engineSettings === undefined) {
                engineSettings = getConfigEngineSettings(engineType);
            }
            this.setEngineType(engineType, engineSettings);
        } else if (engineSettings !== undefined) {
            if (!this.adoptionPending) {
                this.preserveNativeLayoutOnce = false;
                this.leaveNativeLayoutFallback();
            }
            this.tilingEngine.setEngineSettings(engineSettings);
        }
    }

    hasWindow(kwinWindow: KwinWindow): boolean {
        return this.windowMap.has(kwinWindow);
    }

    hasTile(kwinTile: KwinTile): boolean {
        return this.tileMap.has(kwinTile);
    }

    getEngineType(): TilingEngineType {
        return this.tilingEngine.engineType;
    }

    getEngineSettings(): object {
        return this.tilingEngine.getEngineSettings();
    }

    isWindowTiled(kwinWindow: KwinWindow): boolean | undefined {
        if (!this.windowMap.has(kwinWindow)) {
            return undefined;
        }
        // Focus view and fullscreen can detach a window without changing the
        // preserved native layout. Treat only live native membership as tiled
        // while startup preservation is active.
        if (this.nativeLayoutFallback) {
            return kwinWindow.tile != null;
        }
        return !this.untiledWindows.has(kwinWindow);
    }

    setAdoptionPending(pending: boolean): void {
        this.adoptionPending = pending;
    }

    usesNativeLayoutFallback(): boolean {
        return this.nativeLayoutFallback;
    }

    preserveNativeLayout(rootTile: KwinTile | null): void {
        this.nativeRootTile = rootTile;
        this.nativeLayoutFallback = true;
        this.preserveNativeLayoutOnce = false;
    }

    resetTilingEngine(): void {
        const defaultEngine = config().defaultEngine;
        const defaultSettings = getConfigEngineSettings(defaultEngine);
        if (this.tilingEngine.engineType !== defaultEngine) {
            this.setEngineType(defaultEngine, defaultSettings);
        } else {
            this.preserveNativeLayoutOnce = false;
            if (this.nativeLayoutFallback) {
                this.nativeLayoutFallback = false;
                for (const [kwinWindow, engineWindow] of this.windowMap) {
                    if (
                        !this.untiledWindows.has(kwinWindow) ||
                        kwinWindow.tile != null ||
                        ctrl().isFocusedWindow(kwinWindow)
                    ) {
                        this.untiledWindows.delete(kwinWindow);
                        this.tilingEngine.addWindow(engineWindow);
                    }
                }
            }
            this.tilingEngine.setEngineSettings(defaultSettings);
        }
    }

    buildLayout(rootTile: KwinTile, display: Display): void {
        this.nativeRootTile = rootTile;
        if (!this.adoptionPending && this.nativeLayoutFallback) {
            const pending =
                this.pendingNewWindows.size + this.pendingTileChanges.size;
            this.leaveNativeLayoutFallback(false);
            if (this.nativeLayoutFallback) {
                ctrl().applyFocusGeometry(display, this);
                return;
            }
            if (pending === 0) {
                for (const tile of Array.from(this.hookedTiles)) {
                    if (!this.tileMap.has(tile)) {
                        this.disconnectTileHooks(tile);
                    }
                }
                this.installTileHooks(display);
                ctrl().applyFocusGeometry(display, this);
                return;
            }
        }
        if (this.adoptionPending || this.nativeLayoutFallback) {
            ctrl().applyFocusGeometry(display, this);
            return;
        }
        if (this.preserveNativeLayoutOnce) {
            this.preserveNativeLayoutOnce = false;
            this.installTileHooks(display);
            ctrl().applyFocusGeometry(display, this);
            return;
        }
        if (this.kwinImportPending) {
            this.importKWinLayout(rootTile);
            this.kwinImportPending = false;
        }
        // remove non-extant windows or windows that are not on the desktop/activity/output
        // should prevent ghost tiles even if code elsewhere is buggy
        for (const [kwinWindow, _ew] of this.windowMap) {
            if (
                !ctrl().windowExists(kwinWindow) ||
                !(
                    kwinWindow.desktops.includes(display.desktop) ||
                    kwinWindow.onAllDesktops
                ) ||
                (kwinWindow.activities.length > 0 &&
                    !kwinWindow.activities.includes(display.activity)) ||
                kwinWindow.output !== display.output
            ) {
                console().warn("invalid window in windowMap");
                this.removeWindow(kwinWindow);
            }
        }

        const engineRootTile = this.tilingEngine.buildLayout();
        this.engineRootTile = applySingleWindowSizing(engineRootTile, display);
        this.tileMap = buildLayout(rootTile, this.engineRootTile);
        this.placementTileMap = new Map(this.tileMap);
        if (this.engineRootTile !== engineRootTile) {
            for (const kwinTile of this.placementTileMap.keys()) {
                this.placementTileMap.set(kwinTile, engineRootTile);
            }
        }
        // clean out old hooked (callback set) tiles
        for (const hookedTile of this.hookedTiles) {
            if (!this.tileMap.has(hookedTile)) {
                this.disconnectTileHooks(hookedTile);
            }
        }

        const invertedWindowMap = new Map(
            Array.from(this.windowMap, (a) => [a[1], a[0]]),
        );
        const tiledWindows: Set<KwinWindow> = new Set();
        for (const [kwinTile, engineTile] of this.tileMap) {
            for (const engineWindow of engineTile.windows) {
                const kwinWindow = invertedWindowMap.get(engineWindow);
                if (kwinWindow === undefined) {
                    continue;
                }
                if (
                    ctrl().isFocusedWindow(kwinWindow, display) ||
                    ctrl().isFocusDetachSuspended(kwinWindow, display)
                ) {
                    tiledWindows.add(kwinWindow);
                    continue;
                }
                console().debug(
                    "setting",
                    kwinWindow.resourceClass,
                    "as tiled",
                );
                if (this.untiledWindows.has(kwinWindow)) {
                    this.untiledWindows.delete(kwinWindow);
                }
                setTiledProps(kwinWindow);
                if (kwinWindow.tile !== kwinTile) kwinTile.manage(kwinWindow);
                //setWindowSize(kwinWindow, kwinTile);
                tiledWindows.add(kwinWindow);
            }
        }
        this.installTileHooks(display);
        // untile windows that aren't tiled
        for (const kwinWindow of this.windowMap.keys()) {
            if (!tiledWindows.has(kwinWindow)) {
                console().debug(
                    "setting",
                    kwinWindow.resourceClass,
                    "as untiled",
                );
                this.untiledWindows.add(kwinWindow);
                // dont set untiled props if the tile isnt null and this driver doesnt manage it
                // (in all likelihood another driver does)
                if (
                    kwinWindow.tile != null &&
                    this.tileMap.has(kwinWindow.tile)
                ) {
                    kwinWindow.tile.unmanage(kwinWindow);
                    setUntiledProps(kwinWindow);
                } else if (kwinWindow.tile == null) {
                    setUntiledProps(kwinWindow);
                }
            }
        }
        ctrl().applyFocusGeometry(display, this);
    }

    private installTileHooks(display: Display): void {
        for (const kwinTile of this.tileMap.keys()) {
            if (this.hookedTiles.has(kwinTile)) {
                continue;
            }
            const geometry = this.updateTileSizesCallback.bind(this, display);
            const children = this.updateTileCountCallback.bind(this, display);
            kwinTile.relativeGeometryChanged.connect(geometry);
            kwinTile.childTilesChanged.connect(children);
            this.tileCallbacks.set(kwinTile, { geometry, children });
            this.hookedTiles.add(kwinTile);
        }
    }

    private disconnectTileHooks(tile: KwinTile): void {
        const callbacks = this.tileCallbacks.get(tile);
        this.tileCallbacks.delete(tile);
        this.hookedTiles.delete(tile);
        if (callbacks === undefined) {
            return;
        }
        try {
            tile.relativeGeometryChanged.disconnect(callbacks.geometry);
            tile.childTilesChanged.disconnect(callbacks.children);
        } catch (error) {
            // The native tile can already be destroyed when its tree changes.
            console().debug("tile signal disconnect skipped", error);
        }
    }

    dispose(): void {
        for (const tile of Array.from(this.hookedTiles)) {
            this.disconnectTileHooks(tile);
        }
    }

    initializeWindow(kwinWindow: KwinWindow): EngineWindow {
        if (this.windowMap.has(kwinWindow)) {
            return this.windowMap.get(kwinWindow)!;
        }
        const engineWindow = new EngineWindow(
            kwinWindow.internalId,
            kwinWindow.caption,
            kwinWindow.minSize,
        );
        this.windowMap.set(kwinWindow, engineWindow);
        return engineWindow;
    }

    markAdoptedUntiled(kwinWindow: KwinWindow): void {
        const wasTiled = !this.untiledWindows.has(kwinWindow);
        this.untiledWindows.add(kwinWindow);
        if (wasTiled && !this.adoptionPending && !this.nativeLayoutFallback) {
            const engineWindow = this.windowMap.get(kwinWindow);
            if (engineWindow !== undefined) {
                this.tilingEngine.removeWindow(engineWindow);
            }
        }
    }

    markPendingNewWindow(kwinWindow: KwinWindow): void {
        this.pendingNewWindows.add(kwinWindow);
    }

    recordPendingTileChange(kwinWindow: KwinWindow, tiled: boolean): void {
        this.pendingTileChanges.set(kwinWindow, tiled);
        if (tiled) {
            this.markAdoptedTiled(kwinWindow);
        } else {
            this.markAdoptedUntiled(kwinWindow);
        }
    }

    markAdoptedTiled(kwinWindow: KwinWindow): void {
        const wasUntiled = this.untiledWindows.delete(kwinWindow);
        const engineWindow = this.windowMap.get(kwinWindow);
        const engineTile =
            kwinWindow.tile === null
                ? undefined
                : this.tileMap.get(kwinWindow.tile);
        if (
            this.adoptionPending ||
            this.nativeLayoutFallback ||
            engineWindow === undefined
        ) {
            return;
        }
        if (
            this.tilingEngine.engineType === TilingEngineType.KWin &&
            engineTile !== undefined
        ) {
            this.tilingEngine.placeWindow(engineWindow, engineTile);
        } else if (
            this.tilingEngine.engineType !== TilingEngineType.KWin &&
            wasUntiled
        ) {
            this.tilingEngine.addWindow(engineWindow);
        }
    }

    private tiledEngineWindows(excludePendingNew = false): Set<EngineWindow> {
        return new Set(
            Array.from(this.windowMap, ([kwinWindow, engineWindow]) =>
                this.untiledWindows.has(kwinWindow) ||
                (excludePendingNew &&
                    this.pendingNewWindows.has(kwinWindow) &&
                    kwinWindow.tile == null)
                    ? null
                    : engineWindow,
            ).filter((window): window is EngineWindow => window !== null),
        );
    }

    private replayPendingNewWindows(): boolean {
        const newWindows = Array.from(this.pendingNewWindows).filter(
            (window) =>
                this.windowMap.has(window) &&
                !this.untiledWindows.has(window) &&
                window.tile == null,
        );
        if (newWindows.length === 0) {
            this.pendingNewWindows.clear();
            return false;
        }
        if (this.nativeLayoutFallback) {
            return false;
        }
        this.pendingNewWindows.clear();
        this.preserveNativeLayoutOnce = false;
        for (const kwinWindow of newWindows) {
            this.tilingEngine.addWindow(this.windowMap.get(kwinWindow)!);
        }
        return true;
    }

    private preparePendingTileChanges(): void {
        // Import the live native tree as it was when the saver reply arrived.
        // Shortcut changes made during adoption have not yet changed KWin tiles.
        for (const kwinWindow of this.pendingTileChanges.keys()) {
            if (!this.windowMap.has(kwinWindow)) {
                continue;
            }
            if (kwinWindow.tile === null) {
                this.untiledWindows.add(kwinWindow);
            } else {
                this.untiledWindows.delete(kwinWindow);
            }
        }
    }

    private replayPendingTileChanges(): boolean {
        const changes = Array.from(this.pendingTileChanges);
        this.pendingTileChanges.clear();
        let changed = false;
        for (const [kwinWindow, tiled] of changes) {
            if (!this.windowMap.has(kwinWindow)) {
                continue;
            }
            if (tiled) {
                if (kwinWindow.tile !== null) {
                    this.markAdoptedTiled(kwinWindow);
                    continue;
                }
                this.tileWindow(kwinWindow);
            } else {
                if (kwinWindow.tile === null) {
                    this.markAdoptedUntiled(kwinWindow);
                    continue;
                }
                this.untileWindow(kwinWindow);
            }
            changed = true;
        }
        return changed;
    }

    private importKWinLayout(rootTile: KwinTile): void {
        this.tileMap = this.tilingEngine.restoreExistingKWin(
            rootTile,
            this.windowMap,
            this.tiledEngineWindows(),
        );
        this.placementTileMap = new Map(this.tileMap);
        this.engineRootTile = this.tilingEngine.buildLayout();
    }

    private leaveNativeLayoutFallback(allowReconstruction = true): void {
        if (!this.nativeLayoutFallback) {
            return;
        }
        const rootTile = this.nativeRootTile;
        if (rootTile === null) {
            // A noncurrent activity has no native tree to import yet.
            return;
        }
        const nativeTiles = this.syncNativeLayoutMembership(rootTile);
        if (this.tilingEngine.engineType === TilingEngineType.KWin) {
            this.importKWinLayout(rootTile);
            this.nativeLayoutFallback = false;
            this.replayPendingNewWindows();
            this.replayPendingTileChanges();
            return;
        }
        const tiledWindows = this.tiledEngineWindows();
        const nativeTiledWindows = new Set(
            Array.from(this.windowMap, ([window, engineWindow]) =>
                window.tile !== null && nativeTiles.has(window.tile)
                    ? engineWindow
                    : null,
            ).filter((window): window is EngineWindow => window !== null),
        );
        const deferredWindows = new Set(
            Array.from(this.pendingNewWindows, (window) =>
                this.windowMap.get(window),
            ),
        );
        for (const [window, tiled] of this.pendingTileChanges) {
            if (tiled && window.tile === null) {
                deferredWindows.add(this.windowMap.get(window));
            }
        }
        const existingTiledWindows = new Set(
            Array.from(tiledWindows).filter(
                (window) => !deferredWindows.has(window),
            ),
        );
        if (
            existingTiledWindows.size > 0 &&
            existingTiledWindows.size === nativeTiledWindows.size &&
            this.tilingEngine.restoreExistingBTree(
                rootTile,
                this.windowMap,
                nativeTiledWindows,
            )
        ) {
            const engineRootTile = this.tilingEngine.buildLayout();
            const tileMap = this.mapMatchingNativeTiles(
                rootTile,
                engineRootTile,
            );
            if (tileMap !== null) {
                this.nativeLayoutFallback = false;
                this.engineRootTile = engineRootTile;
                this.tileMap = tileMap;
                this.placementTileMap = new Map(tileMap);
                this.replayPendingNewWindows();
                this.replayPendingTileChanges();
                return;
            }
        }
        const emptyNativeRoot =
            rootTile.tiles.length === 0 && rootTile.windows.length === 0;
        const suspendedTile = Array.from(this.windowMap.keys()).some(
            (window) =>
                window.tile === null &&
                (ctrl().isFocusedWindow(window) ||
                    ctrl().tiledIntentForWindow(window) === true),
        );
        if (suspendedTile || (!allowReconstruction && !emptyNativeRoot)) {
            return;
        }
        // An unimportable native tree needs a fresh engine. Reusing the old
        // engine would retain closed windows and stale tile positions.
        this.nativeLayoutFallback = false;
        const engineType = this.tilingEngine.engineType;
        const engineSettings = this.tilingEngine.getEngineSettings();
        this.tilingEngine = new TilingEngine(engineType, engineSettings);
        for (const window of tiledWindows) {
            this.tilingEngine.addWindow(window);
        }
        this.engineRootTile = null;
        this.tileMap.clear();
        this.placementTileMap.clear();
        this.replayPendingNewWindows();
        this.replayPendingTileChanges();
    }

    private mapMatchingNativeTiles(
        rootTile: KwinTile,
        engineRootTile: EngineTile,
    ): Map<KwinTile, EngineTile> | null {
        const tileMap = new Map<KwinTile, EngineTile>();
        const queue: Array<[KwinTile, EngineTile]> = [
            [rootTile, engineRootTile],
        ];
        while (queue.length > 0) {
            const [nativeTile, engineTile] = queue.pop()!;
            if (nativeTile.tiles.length !== engineTile.children.length) {
                return null;
            }
            tileMap.set(nativeTile, engineTile);
            for (let index = 0; index < nativeTile.tiles.length; index += 1) {
                queue.push([
                    nativeTile.tiles[index],
                    engineTile.children[index],
                ]);
            }
        }
        return tileMap;
    }

    private syncNativeLayoutMembership(rootTile: KwinTile): Set<KwinTile> {
        const nativeTiles = new Set<KwinTile>();
        const queue = [rootTile];
        while (queue.length > 0) {
            const tile = queue.pop()!;
            nativeTiles.add(tile);
            queue.push(...tile.tiles);
        }
        for (const kwinWindow of this.windowMap.keys()) {
            if (kwinWindow.tile !== null && nativeTiles.has(kwinWindow.tile)) {
                this.untiledWindows.delete(kwinWindow);
            } else if (
                ctrl().isFocusedWindow(kwinWindow) ||
                ctrl().tiledIntentForWindow(kwinWindow) === true
            ) {
                this.untiledWindows.delete(kwinWindow);
            } else if (!this.pendingNewWindows.has(kwinWindow)) {
                this.untiledWindows.add(kwinWindow);
            }
        }
        return nativeTiles;
    }

    adoptExistingWindows(rootTile: KwinTile | null): boolean {
        this.adoptionPending = false;
        this.nativeRootTile = rootTile;
        this.preparePendingTileChanges();
        const existingTiledWindows = this.tiledEngineWindows(true);
        const hasNativeLayout =
            rootTile !== null
                ? rootTile.tiles.length > 0 || rootTile.windows.length > 0
                : Array.from(this.windowMap.keys()).some(
                      (window) => window.tile != null,
                  );
        if (this.tilingEngine.engineType === TilingEngineType.KWin) {
            if (rootTile !== null && hasNativeLayout) {
                this.importKWinLayout(rootTile);
                this.kwinImportPending = false;
                this.preserveNativeLayoutOnce = true;
                this.pendingNewWindows.clear();
                this.replayPendingTileChanges();
                return true;
            }
            this.nativeLayoutFallback = hasNativeLayout;
            this.kwinImportPending = false;
            this.pendingNewWindows.clear();
            // An empty native root can be populated from KWin's saved tiles.
            return (
                this.replayPendingTileChanges() ||
                (rootTile !== null && !hasNativeLayout)
            );
        }
        if (
            rootTile !== null &&
            this.tilingEngine.engineType === TilingEngineType.BTree &&
            (existingTiledWindows.size > 0 || !hasNativeLayout)
        ) {
            if (
                this.tilingEngine.restoreExistingBTree(
                    rootTile,
                    this.windowMap,
                    existingTiledWindows,
                )
            ) {
                console().log(
                    "restored existing binary-tree layout",
                    existingTiledWindows.size,
                );
                const newWindowBuild = this.replayPendingNewWindows();
                const tileChangeBuild = this.replayPendingTileChanges();
                return (
                    existingTiledWindows.size > 0 ||
                    newWindowBuild ||
                    tileChangeBuild
                );
            }
            console().warn("could not import existing binary-tree layout");
        }
        if (hasNativeLayout) {
            this.nativeLayoutFallback = true;
            const newWindowBuild = this.replayPendingNewWindows();
            return this.replayPendingTileChanges() || newWindowBuild;
        }
        for (const window of existingTiledWindows) {
            this.tilingEngine.addWindow(window);
        }
        const newWindowBuild = this.replayPendingNewWindows();
        const tileChangeBuild = this.replayPendingTileChanges();
        return (
            existingTiledWindows.size > 0 || newWindowBuild || tileChangeBuild
        );
    }

    addWindow(
        kwinWindow: KwinWindow,
        tile?: KwinTile,
        direction?: Direction,
    ): void {
        this.preserveNativeLayoutOnce = false;
        this.leaveNativeLayoutFallback();
        if (this.windowMap.has(kwinWindow)) {
            console().warn(
                "initializeWindow error - window already exists in map",
            );
            return;
        }
        const window = this.initializeWindow(kwinWindow);
        if (this.nativeLayoutFallback) {
            this.pendingNewWindows.add(kwinWindow);
            return;
        }
        this.tilingEngine.addWindow(
            window,
            tile ? this.tileMap.get(tile) : undefined,
            direction,
        );
        // sometimes windowActivated is called before addWindow so rectify that here
        if (this.savedActiveWindow === kwinWindow) {
            // return value doesnt matter as we rebuild on add regardless
            this.tilingEngine.windowActivated(window);
        }
    }

    addWindowUntiled(kwinWindow: KwinWindow) {
        if (this.windowMap.has(kwinWindow)) {
            console().warn(
                "initializeWindow error - window already exists in map",
            );
            return;
        }
        this.initializeWindow(kwinWindow);
    }

    tileWindow(kwinWindow: KwinWindow) {
        if (this.nativeLayoutFallback && kwinWindow.tile != null) {
            this.untiledWindows.delete(kwinWindow);
            this.pendingTileChanges.delete(kwinWindow);
            return;
        }
        this.preserveNativeLayoutOnce = false;
        this.leaveNativeLayoutFallback();
        const window = this.windowMap.get(kwinWindow);
        if (window === undefined) {
            console().warn("tileWindow error - window not found in map");
            return;
        }
        if (this.nativeLayoutFallback) {
            this.recordPendingTileChange(kwinWindow, true);
            return;
        }
        this.tilingEngine.addWindow(window);
        if (this.savedActiveWindow === kwinWindow) {
            // return value doesnt matter as we rebuild on add regardless
            this.tilingEngine.windowActivated(window);
        }
    }

    untileWindow(kwinWindow: KwinWindow) {
        this.preserveNativeLayoutOnce = false;
        this.leaveNativeLayoutFallback();
        const window = this.windowMap.get(kwinWindow);
        if (window === undefined) {
            console().warn("untileWindow error - window not found in map");
            return;
        }
        if (this.nativeLayoutFallback) {
            this.recordPendingTileChange(kwinWindow, false);
            return;
        }
        this.tilingEngine.removeWindow(window);
    }

    placeWindow(
        kwinWindow: KwinWindow,
        kwinTile: KwinTile,
        direction?: Direction,
    ): void {
        this.preserveNativeLayoutOnce = false;
        this.leaveNativeLayoutFallback();
        let window = this.initializeWindow(kwinWindow);
        if (this.nativeLayoutFallback) {
            this.pendingNewWindows.add(kwinWindow);
            return;
        }
        const tile = this.placementTileMap.get(kwinTile);
        if (tile == undefined) {
            console().warn("tile undefined during window placement");
            // place like normal if no tile
            this.tilingEngine.addWindow(window);
            return;
        }
        this.tilingEngine.placeWindow(window, tile, direction);
        // see comments in addWindow
        if (this.savedActiveWindow === kwinWindow) {
            this.tilingEngine.windowActivated(window);
        }
    }

    windowActivated(kwinWindow: KwinWindow): boolean {
        this.savedActiveWindow = kwinWindow;
        const engineWindow = this.windowMap.get(kwinWindow);
        if (engineWindow === undefined) {
            // dont panic as windowActivated may be called before addWindow
            // so we resolve this with savedActiveWindow in place/addWindow
            return false;
        }
        return this.tilingEngine.windowActivated(engineWindow);
    }

    removeWindow(kwinWindow: KwinWindow): void {
        this.pendingNewWindows.delete(kwinWindow);
        this.pendingTileChanges.delete(kwinWindow);
        if (this.adoptionPending || this.nativeLayoutFallback) {
            if (this.nativeLayoutFallback) {
                const engineWindow = this.windowMap.get(kwinWindow);
                if (engineWindow !== undefined) {
                    this.tilingEngine.removeWindow(engineWindow);
                }
            }
            this.untiledWindows.delete(kwinWindow);
            this.windowMap.delete(kwinWindow);
            return;
        }
        if (this.untiledWindows.has(kwinWindow)) {
            this.untiledWindows.delete(kwinWindow);
        } else if (ctrl().windowExists(kwinWindow)) {
            setUntiledProps(kwinWindow);
            if (kwinWindow.tile != null && this.tileMap.has(kwinWindow.tile)) {
                kwinWindow.tile.unmanage(kwinWindow);
            }
        }

        const engineWindow = this.windowMap.get(kwinWindow);
        if (engineWindow === undefined) {
            console().warn(
                "Window",
                kwinWindow?.resourceClass,
                "not registered in windowMap",
            );
            return;
        }
        this.tilingEngine.removeWindow(engineWindow);
        this.windowMap.delete(kwinWindow);
    }

    // as of right now, can only update sizes (ie cannot add/remove tiles)
    updateTiles(): void {
        if (this.adoptionPending || this.nativeLayoutFallback) {
            return;
        }
        if (this.engineRootTile === null) {
            console().warn("updateTiles called, but engine layout not built");
            return;
        }
        const tile = updateTiles(this.engineRootTile, this.tileMap);
        this.tilingEngine.updateTiles(tile);
    }

    private updateTileSizesCallback(display: Display) {
        ctrl().queueEvent({
            t: "updateTiles",
            display: display,
            rebuild: false,
        });
    }
    // when updating tile count we want to rebuild as for most engines this is an error
    // for kwin this is fine though
    private updateTileCountCallback(display: Display) {
        ctrl().queueEvent({
            t: "updateTiles",
            display: display,
            rebuild: true,
        });
    }
}

// want to completely separate the engine and kwin, so we set config defaults here not in engine
function getConfigEngineSettings(engineType: TilingEngineType): object {
    switch (engineType) {
        case TilingEngineType.BTree:
            return config().btreeSettings;
        case TilingEngineType.Half:
            return config().halfSettings;
        case TilingEngineType.ThreeColumn:
            return config().threeColumnSettings;
        case TilingEngineType.Pillars:
            return config().pillarSettings;
        case TilingEngineType.Pager:
            return config().pagerSettings;
        case TilingEngineType.KWin:
            // no settings for kwin
            return {};
        default:
            console().error("engine type", engineType, "is invalid");
            return {};
    }
}

function setTiledProps(window: KwinWindow) {
    if (config().tiledWindowsBelow) {
        window.keepBelow = true;
    }
    if (
        config().borders === Borders.Floating ||
        config().borders === Borders.None ||
        ((config().borders === Borders.Active ||
            config().borders === Borders.FloatingActive) &&
            !window.active)
    ) {
        window.noBorder = true;
    }
    window.setMaximize(false, false);
}

function setUntiledProps(window: KwinWindow) {
    if (config().tiledWindowsBelow) {
        window.keepBelow = false;
    }
    if (
        config().borders === Borders.Floating ||
        config().borders === Borders.FloatingActive
    ) {
        window.noBorder = false;
    }
}

function getEngineWindows(tile: EngineTile): EngineWindow[] {
    const windows: EngineWindow[] = [...tile.windows];
    for (const child of tile.children) {
        windows.push(...getEngineWindows(child));
    }
    return windows;
}

const ultrawideAspectRatioThreshold = 2;

function applySingleWindowSizing(
    engineRootTile: EngineTile,
    display: Display,
): EngineTile {
    if (!config().ultrawideSingleWindow) {
        console().debug("single-window sizing disabled");
        return engineRootTile;
    }
    if (config().ultrawideOnly) {
        const geom = display.output?.geometry;
        if (!geom || geom.height <= 0) {
            console().debug("single-window sizing: invalid output geometry");
            return engineRootTile;
        }
        const aspectRatio = geom.width / geom.height;
        console().debug(
            "single-window sizing check - output",
            display.output.name,
            "geometry",
            `${geom.width}x${geom.height}`,
            "ratio",
            aspectRatio,
            "threshold",
            ultrawideAspectRatioThreshold,
        );
        if (aspectRatio < ultrawideAspectRatioThreshold) {
            return engineRootTile;
        }
    } else {
        console().debug("single-window sizing enabled for all screens");
    }
    const windows = getEngineWindows(engineRootTile);
    console().debug("single-window sizing window count", windows.length);
    if (windows.length !== 1) {
        return engineRootTile;
    }

    const singleWindow = windows[0];
    const widthShare = config().ultrawideSingleWindowWidth;
    const position = config().ultrawideSingleWindowPosition;
    console().debug(
        "applying single-window sizing - width",
        widthShare,
        "position",
        position,
    );

    const newRoot = new EngineTile();
    newRoot.layoutDirection = LayoutDirection.Horizontal;

    if (position === UltrawidePosition.Center) {
        const sideShare = (1 - widthShare) / 2;
        const leftTile = newRoot.addChild();
        leftTile.size = sideShare;

        const centerTile = newRoot.addChild();
        centerTile.size = widthShare;
        centerTile.windows.push(singleWindow);

        const rightTile = newRoot.addChild();
        rightTile.size = sideShare;
    } else if (position === UltrawidePosition.Left) {
        const leftTile = newRoot.addChild();
        leftTile.size = widthShare;
        leftTile.windows.push(singleWindow);

        const rightTile = newRoot.addChild();
        rightTile.size = 1 - widthShare;
    } else if (position === UltrawidePosition.Right) {
        const leftTile = newRoot.addChild();
        leftTile.size = 1 - widthShare;

        const rightTile = newRoot.addChild();
        rightTile.size = widthShare;
        rightTile.windows.push(singleWindow);
    }

    return newRoot;
}
