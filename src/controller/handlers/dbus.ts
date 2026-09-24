import { console, controller as ctrl } from "..";
import { Display } from "../event";
import { TilingEngineType } from "../../engine";
import { DBus as DBusQml } from "../../extern";

interface SettingsBundle {
    engineType?: TilingEngineType;
    engineSettings?: object;
}

function settingsBundle(
    engineType: TilingEngineType,
    engineSettings: object,
): string {
    const bundle = {
        engineType: engineType,
        engineSettings: engineSettings,
    };
    return JSON.stringify(bundle);
}

export class DBusHandler {
    private dbusQml: DBusQml;
    private queuedGets: Display[] = [];
    private activeGet: Display | null = null;

    constructor(dbusQml: DBusQml) {
        this.dbusQml = dbusQml;
        const getSettings = dbusQml.getSettings();
        getSettings.finished.connect(this.getSettingsCallback.bind(this));
        getSettings.failed.connect(this.getSettingsFailed.bind(this));
    }

    getSettings(display: Display): void {
        console().debug("getSettings called");
        // DBusCall.failed has no arguments, so only one request may be active.
        this.queuedGets.push(display);
        this.startNextGet();
    }

    private startNextGet(): void {
        if (this.activeGet !== null) {
            return;
        }
        const display = this.queuedGets.shift();
        if (display === undefined) {
            return;
        }
        this.activeGet = display;
        try {
            const request = this.dbusQml.getSettings();
            request.arguments = [display.toString()];
            request.call();
        } catch (e) {
            console().error(e);
            this.resolveActiveGet();
        }
    }

    private resolveActiveGet(settingsBundle?: SettingsBundle): void {
        const display = this.activeGet;
        this.activeGet = null;
        if (display !== null) {
            ctrl().queueEvent(
                {
                    t: "settingsResolved",
                    display,
                    engineType: settingsBundle?.engineType,
                    engineSettings: settingsBundle?.engineSettings,
                },
                true,
            );
        }
        this.startNextGet();
    }

    private getSettingsCallback(returnValue: any[]): void {
        const display = this.activeGet;
        if (display === null) {
            return;
        }
        try {
            const [desktopIdStr, settingsBundleStr] = returnValue;
            console().debug(
                "getSettings dbus callback activated -",
                desktopIdStr,
                settingsBundleStr,
            );
            if (desktopIdStr !== display.toString()) {
                throw new Error(
                    "saver returned settings for a different display",
                );
            }
            const settingsBundle = JSON.parse(
                settingsBundleStr as string,
            ) as SettingsBundle;
            this.resolveActiveGet(settingsBundle);
        } catch (e) {
            console().error(e);
            // An unreadable saver response leaves the configured default engine in place.
            this.resolveActiveGet();
        }
    }

    private getSettingsFailed(): void {
        console().warn("getSettings dbus call failed");
        this.resolveActiveGet();
    }

    setSettings(
        display: Display,
        engineType: TilingEngineType,
        engineSettings: object,
    ): void {
        console().debug("setSettings called");
        this.dbusQml.setSettings().arguments = [
            display.toString(),
            settingsBundle(engineType, engineSettings),
        ];
        this.dbusQml.setSettings().call();
    }

    resetSettings(display: Display): void {
        console().debug("resetSettings called");
        this.dbusQml.resetSettings().arguments = [display.toString()];
        this.dbusQml.resetSettings().call();
    }
}
