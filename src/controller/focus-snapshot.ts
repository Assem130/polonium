export interface FocusGeometry {
    x: number;
    y: number;
    width: number;
    height: number;
}

export function copyFocusGeometry(geometry: FocusGeometry): FocusGeometry {
    return {
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height,
    };
}

export interface FocusSnapshot {
    windowId: string;
    desktopId: string;
    activity: string;
    outputName: string;
    geometry: FocusGeometry;
    keepAbove: boolean;
    keepBelow: boolean;
    noBorder: boolean;
    tiled: boolean;
    tilePath: number[] | null;
    tileGeometry: FocusGeometry | null;
}

function isGeometry(value: any): value is FocusGeometry {
    return (
        value !== null &&
        typeof value === "object" &&
        [value.x, value.y, value.width, value.height].every(
            (number) => typeof number === "number" && Number.isFinite(number),
        ) &&
        value.width > 0 &&
        value.height > 0
    );
}

export function isFocusSnapshot(value: any): value is FocusSnapshot {
    return (
        value !== null &&
        typeof value === "object" &&
        typeof value.windowId === "string" &&
        typeof value.desktopId === "string" &&
        typeof value.activity === "string" &&
        typeof value.outputName === "string" &&
        isGeometry(value.geometry) &&
        typeof value.keepAbove === "boolean" &&
        typeof value.keepBelow === "boolean" &&
        typeof value.noBorder === "boolean" &&
        typeof value.tiled === "boolean" &&
        (value.tilePath === null ||
            (Array.isArray(value.tilePath) &&
                value.tilePath.every(
                    (index: any) => Number.isInteger(index) && index >= 0,
                ))) &&
        (value.tileGeometry === null || isGeometry(value.tileGeometry))
    );
}
