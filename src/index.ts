// index.ts - Entry point from QML to TypeScript

import { QmlApi, QmlObjects } from "./extern";
import { controller, initializeController } from "./controller";
import { Display } from "./controller/event";

export function main(api: QmlApi, qmlObjects: QmlObjects) {
    Display.setWorkspace(api.workspace);
    initializeController(api, qmlObjects);
    controller().adoptOpenWindows();
}

export function cleanup() {
    controller()?.cleanup();
}
