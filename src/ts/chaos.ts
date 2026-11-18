import { getFromStorage, setIntoStorage } from "./utils.js";
import { render } from "./rendering.js";
import { showToast } from "./forms.js";
import { vm } from "./virtual-machine.js";

/**CHAOS mode: when enabled, every function call (jal, jalr, bal, bgezal, bltzal) assigns random
 * values to all the $t registers. Programs that wrongly expect $t registers to be preserved
 * across calls (instead of using $s registers or saving them on the stack) will then misbehave,
 * making the error visible.*/
export function isChaosMode(): boolean {
    return getFromStorage("local", "chaosMode") === true;
}

export function setChaosMode(enabled: boolean) {
    setIntoStorage("local", "chaosMode", enabled);
    vm.cpu.chaosMode = enabled;
}

(window as any).toggleChaosOnClick = async function () {
    const enabled = !isChaosMode();
    setChaosMode(enabled);
    await render("vm-buttons", "/app/vm-buttons.ejs", undefined, false);
    showToast(
        enabled
            ? "CHAOS mode on: every function call scrambles the $t registers"
            : "CHAOS mode off",
        3000,
    );
};

(window as any).isChaosMode = isChaosMode;
