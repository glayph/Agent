import * as fs from "node:fs";
/** Return stable Linux USB topology device identifiers (for example `1-2`, `2-1.3`). */
export function scanLinuxUsbDevices(root = "/sys/bus/usb/devices") {
    if (!fs.existsSync(root))
        return [];
    return fs
        .readdirSync(root)
        .filter((name) => /^\d+-\d+(?:\.\d+)*$/.test(name))
        .sort();
}
/** Compare two snapshots and report exact plug/unplug changes. */
export function diffUsbDevices(previous, current) {
    if (previous === undefined)
        return { added: [], removed: [] };
    const before = new Set(previous);
    const after = new Set(current);
    return {
        added: current.filter((id) => !before.has(id)),
        removed: previous.filter((id) => !after.has(id)),
    };
}
