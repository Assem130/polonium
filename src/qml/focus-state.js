.pragma library

var snapshots = {};
var tiledIntents = {};
var fullscreenStackings = {};

function save(id, snapshot) {
    snapshots[id] = JSON.parse(JSON.stringify(snapshot));
}

function get(id) {
    return snapshots[id] === undefined
        ? null
        : JSON.parse(JSON.stringify(snapshots[id]));
}

function remove(id) {
    delete snapshots[id];
}

function saveTiledIntent(id, tiled) {
    tiledIntents[id] = tiled;
}

function getTiledIntent(id) {
    return tiledIntents[id] === undefined ? null : tiledIntents[id];
}

function removeTiledIntent(id) {
    delete tiledIntents[id];
}

function saveFullscreenStacking(id, stacking) {
    fullscreenStackings[id] = {
        keepAbove: stacking.keepAbove,
        keepBelow: stacking.keepBelow,
    };
}

function getFullscreenStacking(id) {
    return fullscreenStackings[id] === undefined
        ? null
        : {
              keepAbove: fullscreenStackings[id].keepAbove,
              keepBelow: fullscreenStackings[id].keepBelow,
          };
}

function removeFullscreenStacking(id) {
    delete fullscreenStackings[id];
}
