// Observation-only KWin 6 bridge for the OpenAGI Linux companion.
// It never activates, closes, resizes, moves, or otherwise mutates a window.

const service = "org.openagi.LinuxCompanion";
const objectPath = "/org/openagi/LinuxCompanion";
const interfaceName = "org.openagi.LinuxCompanion";
let trackedWindow = null;
let trackedCaptionHandler = null;
let trackedGeometryHandler = null;

function geometryObject(rect) {
    return {
        x: Number(rect.x),
        y: Number(rect.y),
        width: Number(rect.width),
        height: Number(rect.height)
    };
}

function snapshot(window) {
    if (!window) {
        return null;
    }
    return {
        internalId: String(window.internalId),
        pid: Number(window.pid),
        caption: String(window.caption || ""),
        desktopFileName: String(window.desktopFileName || ""),
        resourceClass: String(window.resourceClass || ""),
        resourceName: String(window.resourceName || ""),
        frameGeometry: geometryObject(window.frameGeometry),
        output: window.output ? String(window.output.name || "") : "",
        fullScreen: Boolean(window.fullScreen),
        minimized: Boolean(window.minimized),
        specialWindow: Boolean(window.specialWindow)
    };
}

function reportWindow(window) {
    const value = snapshot(window);
    callDBus(service, objectPath, interfaceName, "ReportWindow", JSON.stringify(value));
}

function disconnectTrackedWindow() {
    if (trackedWindow && trackedCaptionHandler) {
        trackedWindow.captionChanged.disconnect(trackedCaptionHandler);
    }
    if (trackedWindow && trackedGeometryHandler) {
        trackedWindow.frameGeometryChanged.disconnect(trackedGeometryHandler);
    }
    trackedCaptionHandler = null;
    trackedGeometryHandler = null;
}

function trackWindow(window) {
    disconnectTrackedWindow();
    trackedWindow = window;
    reportWindow(window);
    if (!window) {
        return;
    }
    trackedCaptionHandler = function () {
        if (trackedWindow === window && workspace.activeWindow === window) {
            reportWindow(window);
        }
    };
    trackedGeometryHandler = function () {
        if (trackedWindow === window && workspace.activeWindow === window) {
            reportWindow(window);
        }
    };
    window.captionChanged.connect(trackedCaptionHandler);
    window.frameGeometryChanged.connect(trackedGeometryHandler);
}

workspace.windowActivated.connect(trackWindow);
registerShortcut(
    "OpenAGI Quick Ask",
    "Show OpenAGI Quick Ask",
    "Ctrl+Alt+Space",
    function () {
        callDBus(service, objectPath, interfaceName, "ToggleQuickAsk");
    }
);
trackWindow(workspace.activeWindow);
