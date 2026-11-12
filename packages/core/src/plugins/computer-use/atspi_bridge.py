#!/usr/bin/env python3
"""Small AT-SPI sidecar for generic Linux desktop accessibility automation."""
import base64
import json
import sys
from collections import deque


def result(ok, action, data=None, message=None, error=None):
    value = {"ok": ok, "action": action}
    if data is not None:
        value["data"] = data
    if message:
        value["message"] = message
    if error:
        value["error"] = error
    print(json.dumps(value, ensure_ascii=False, default=str))


def safe(call, default=None):
    try:
        return call()
    except Exception:
        return default


def main():
    payload = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
    action = str(payload.get("action", "observe"))
    try:
        import pyatspi
    except Exception as exc:
        raise RuntimeError(
            "Linux semantic desktop automation requires AT-SPI Python bindings. "
            "Install python3-pyatspi and at-spi2-core (for example: sudo apt install python3-pyatspi at-spi2-core), "
            "then log out/in or restart the accessibility bus."
        ) from exc

    desktop = pyatspi.Registry.getDesktop(0)

    def children(node):
        count = safe(lambda: node.getChildCount(), 0) or 0
        for index in range(min(int(count), 1000)):
            child = safe(lambda index=index: node.getChildAtIndex(index))
            if child is not None:
                yield index, child

    def role(node):
        return str(safe(lambda: node.getRoleName(), "") or "")

    def name(node):
        return str(safe(lambda: node.getName(), "") or "")

    def app_info(app, index):
        pid = safe(lambda: app.get_process_id(), 0) or 0
        return {"name": name(app), "title": name(app), "processName": name(app), "processId": int(pid), "path": str(index), "controlType": role(app)}

    apps = list(children(desktop))
    windows = []
    for app_index, app in apps:
        for window_index, window in children(app):
            current_role = role(window).lower()
            if "window" in current_role or "frame" in current_role or name(window):
                info = app_info(app, app_index)
                info.update({
                    "name": name(window), "title": name(window),
                    "controlType": role(window),
                    "path": f"{app_index}.{window_index}",
                    "active": bool(safe(lambda: window.getState().contains(pyatspi.STATE_ACTIVE), False)),
                    "focused": bool(safe(lambda: window.getState().contains(pyatspi.STATE_FOCUSED), False)),
                })
                windows.append((app, window, info, app_index, window_index))

    def match_window(entry):
        app, window, info, _, _ = entry
        wanted_title = str(payload.get("windowTitle") or payload.get("window_title") or "").lower()
        wanted_process = str(payload.get("processName") or payload.get("process_name") or "").lower()
        return (not wanted_title or wanted_title in str(info.get("title", "")).lower()) and (not wanted_process or wanted_process in str(info.get("processName", "")).lower())

    active = next((entry for entry in windows if entry[2].get("active") or entry[2].get("focused")), None)
    selected = next((entry for entry in windows if match_window(entry)), active)
    if selected is None and windows:
        selected = windows[0]

    if action == "list_windows":
        result(True, action, {"windows": [entry[2] for entry in windows], "count": len(windows)}, "Window list provided by the desktop AT-SPI accessibility tree.")
        return

    if action == "observe":
        root_entry = active if payload.get("activeOnly") or payload.get("active_only") else selected
        if root_entry is None:
            result(True, action, {"activeWindow": None, "targetWindow": None, "topWindows": [entry[2] for entry in windows], "elements": [], "elementCount": 0}, "No accessible application window is currently available.")
            return
        root = root_entry[1]
        max_elements = max(1, min(300, int(payload.get("maxElements", payload.get("max_elements", 100)) or 100)))
        query = str(payload.get("query", "")).lower()
        found = []
        queue = deque([(root, root_entry[2]["path"], 0)])
        while queue and len(found) < max_elements:
            node, node_path, depth = queue.popleft()
            rect = safe(lambda: node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS), None)
            value = safe(lambda: node.queryText().getText(0, -1), "")
            if not value:
                value = safe(lambda: str(node.queryValue().currentValue), "")
            info = {
                "name": name(node), "automationId": "", "controlType": role(node),
                "runtimeId": "", "path": node_path,
                "processName": root_entry[2].get("processName", ""),
                "processId": root_entry[2].get("processId", 0),
                "windowHandle": 0, "windowTitle": root_entry[2].get("title", ""),
                "enabled": bool(safe(lambda: node.getState().contains(pyatspi.STATE_ENABLED), True)),
                "offscreen": bool(safe(lambda: node.getState().contains(pyatspi.STATE_SHOWING), True) is False),
                "focusable": bool(safe(lambda: node.getState().contains(pyatspi.STATE_FOCUSABLE), False)),
                "value": str(value or "")[:2000],
                "rect": {"x": int(rect.x), "y": int(rect.y), "width": int(rect.width), "height": int(rect.height)} if rect else {"x": 0, "y": 0, "width": 0, "height": 0},
                "depth": depth,
            }
            haystack = " ".join(str(v) for v in (info["name"], info["controlType"], info["value"], info["windowTitle"], info["processName"])).lower()
            if not query or query in haystack:
                found.append(info)
            if depth < 12:
                for child_index, child in children(node):
                    queue.append((child, f"{node_path}.{child_index}", depth + 1))
        result(True, action, {
            "activeWindow": active[2] if active else None,
            "targetWindow": root_entry[2],
            "topWindows": [entry[2] for entry in windows[:25]],
            "elements": found,
            "elementCount": len(found),
        }, "Observed native application controls through Linux AT-SPI.")
        return

    if action == "focus":
        if not selected:
            raise RuntimeError("No matching accessible application window was found.")
        selected[1].queryComponent().grabFocus()
        result(True, action, selected[2], "Focused application window through AT-SPI.")
        return

    locator = payload.get("locator") or {}
    target_path = str(locator.get("path") or "")
    if not selected or not target_path:
        raise RuntimeError("A current accessible element path and target window are required. Call computer_observe again first.")
    path_parts = [int(part) for part in target_path.split(".") if part.isdigit()]
    node = desktop
    for index in path_parts:
        node = node.getChildAtIndex(index)
        if node is None:
            raise RuntimeError("The requested UI element no longer exists. Observe the current application again.")

    if action == "invoke":
        action_iface = safe(lambda: node.queryAction(), None)
        if action_iface is None or action_iface.nActions <= 0:
            raise RuntimeError("The selected UI element exposes no AT-SPI action. Use focus and keyboard/mouse input instead.")
        preferred = ["click", "press", "activate", "toggle", "open"]
        action_names = [str(safe(lambda i=i: action_iface.getName(i), "")).lower() for i in range(action_iface.nActions)]
        chosen = next((i for candidate in preferred for i, candidate_name in enumerate(action_names) if candidate in candidate_name), 0)
        ok = bool(action_iface.doAction(chosen))
        result(ok, action, {"name": name(node), "role": role(node), "action": action_names[chosen]}, "Invoked accessible application control." if ok else None, None if ok else "AT-SPI action returned false.")
        return

    if action == "set_text":
        text = str(payload.get("text", ""))
        editable = safe(lambda: node.queryEditableText(), None)
        if editable is not None:
            ok = editable.setTextContents(text)
            if ok is False:
                raise RuntimeError("The application rejected the text update.")
        else:
            value_iface = safe(lambda: node.queryValue(), None)
            if value_iface is None:
                raise RuntimeError("The selected UI element is not an editable text/value control.")
            value_iface.currentValue = float(text)
        result(True, action, {"name": name(node), "role": role(node), "length": len(text)}, "Updated application field through AT-SPI.")
        return

    raise RuntimeError(f"Unsupported AT-SPI action: {action}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        action_name = "unknown"
        try:
            action_name = str(json.loads(base64.b64decode(sys.argv[1]).decode("utf-8")).get("action", "unknown"))
        except Exception:
            pass
        result(False, action_name, error=str(exc))
