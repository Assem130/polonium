import {
    LayoutDirection,
    Tile as KwinTile,
    Window as KwinWindow,
} from "kwin-api";
import { Direction, Tile, TilingEngineInterface, Window } from "../engine";

export class KwinEngine implements TilingEngineInterface {
    private rootTile: Tile = new Tile();
    private windowTiles: Map<Window, Tile> = new Map();
    getEngineSettings(): object {
        return {
            tiles: this.rootTile.toJSON(),
        };
    }
    setEngineSettings(settings: object): void {
        const tiles = (settings as any).tiles;
        if (tiles == undefined) {
            return;
        }
        this.rootTile = Tile.fromJSON(tiles);
    }

    restoreExistingLayout(
        rootTile: KwinTile,
        windowMap: Map<KwinWindow, Window>,
        tiledWindows: Set<Window>,
    ): Map<KwinTile, Tile> {
        this.windowTiles.clear();
        const tileMap = new Map<KwinTile, Tile>();
        const importTile = (nativeTile: KwinTile, parent?: Tile): Tile => {
            const tile = new Tile(parent);
            tileMap.set(nativeTile, tile);
            if (parent !== undefined) {
                parent.children.push(tile);
            }
            tile.layoutDirection = nativeTile.layoutDirection;
            for (const nativeWindow of nativeTile.windows) {
                const window = windowMap.get(nativeWindow);
                if (window === undefined || !tiledWindows.has(window)) {
                    continue;
                }
                tile.windows.push(window);
                this.windowTiles.set(window, tile);
            }
            const dimension =
                nativeTile.layoutDirection === LayoutDirection.Horizontal
                    ? "width"
                    : "height";
            const parentSize = nativeTile.absoluteGeometry[dimension];
            for (const nativeChild of nativeTile.tiles) {
                const child = importTile(nativeChild, tile);
                child.size =
                    parentSize > 0
                        ? nativeChild.absoluteGeometry[dimension] / parentSize
                        : 1;
            }
            return tile;
        };
        this.rootTile = importTile(rootTile);
        return tileMap;
    }

    buildLayout(): Tile {
        return this.rootTile;
    }
    addWindow(_window: Window, _tile?: Tile, _direction?: Direction): void {
        return;
    }
    removeWindow(window: Window): void {
        const tile = this.windowTiles.get(window);
        this.windowTiles.delete(window);
        if (tile === undefined) {
            return;
        }
        const index = tile.windows.indexOf(window);
        if (index >= 0) {
            tile.windows.splice(index, 1);
        }
    }
    placeWindow(window: Window, tile: Tile, _direction?: Direction): void {
        if (this.windowTiles.has(window)) {
            const oldTile = this.windowTiles.get(window)!;
            const index = oldTile.windows.indexOf(window);
            if (index >= 0) {
                oldTile.windows.splice(index, 1);
            }
        }
        if (!tile.windows.includes(window)) {
            tile.windows.push(window);
        }
        this.windowTiles.set(window, tile);
    }
    windowActivated(_window: Window): boolean {
        return false;
    }
    updateTiles(rootTile: Tile): void {
        this.rootTile = rootTile;
    }
}
