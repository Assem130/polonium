// main.qml - Entry point into script

import QtQuick;
import org.kde.kwin;
import "focus-state.js" as FocusState;

import "../code/main.mjs" as Polonium;

Item {
    id: root;

    function saveFocusSnapshot(id, snapshot) {
        FocusState.save(id, snapshot);
    }

    function getFocusSnapshot(id) {
        return FocusState.get(id);
    }

    function removeFocusSnapshot(id) {
        FocusState.remove(id);
    }

    function saveTiledIntent(id, tiled) {
        FocusState.saveTiledIntent(id, tiled);
    }

    function getTiledIntent(id) {
        return FocusState.getTiledIntent(id);
    }

    function removeTiledIntent(id) {
        FocusState.removeTiledIntent(id);
    }

    function saveFullscreenStacking(id, stacking) {
        FocusState.saveFullscreenStacking(id, stacking);
    }

    function getFullscreenStacking(id) {
        return FocusState.getFullscreenStacking(id);
    }

    function removeFullscreenStacking(id) {
        FocusState.removeFullscreenStacking(id);
    }

    Timer {
        id: eventTimer;
    }
    
    Component.onCompleted: {
        const api = {
            "workspace": Workspace,
            "options": Options,
            "kwin": KWin,
            "console": console,
            "qt": Qt,
        };
        const qmlObjects = {
            "root": root,
            "eventTimer": eventTimer,
            "shortcuts": shortcutsLoader.item,
            "settings": settingsLoader.item,
            "dbus": dbusLoader.item,
        };
        Polonium.main(api, qmlObjects);
    }
    Component.onDestruction: Polonium.cleanup()

    Loader {
        id: shortcutsLoader;
                
        source: "shortcuts.qml";
    }

    Loader {
        id: settingsLoader;
                
        source: "settings.qml";
    }
    
    Loader {
        id: dbusLoader;
        
        source: "dbus.qml";
    }
}
