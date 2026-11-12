(() => {
  if (globalThis.__mikiBrowserAgentInstalled) return;
  globalThis.__mikiBrowserAgentInstalled = true;

  const visible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const accessibleName = (element) => normalize(
    element.getAttribute("aria-label") || element.getAttribute("title") ||
    element.labels?.[0]?.innerText || element.innerText || element.textContent ||
    element.getAttribute("placeholder") || element.getAttribute("alt") || ""
  );
  const find = (selector) => {
    const value = String(selector || "").trim();
    if (!value) throw new Error("A CSS selector or semantic target is required.");
    if (value.startsWith("text=")) {
      const needle = normalize(value.slice(5));
      return [...document.querySelectorAll("button,a,[role=button],label,[role=link],input,textarea,[contenteditable=true]")]
        .find((element) => visible(element) && (normalize(element.innerText) === needle || accessibleName(element) === needle));
    }
    if (value.startsWith("label=")) {
      const label = [...document.querySelectorAll("label")].find((element) => normalize(element.innerText) === normalize(value.slice(6)));
      return label?.control || label;
    }
    if (value.startsWith("placeholder=")) return document.querySelector(`[placeholder="${CSS.escape(value.slice(12))}"]`);
    if (value.startsWith("role=")) {
      const match = /^role=([^\[]+)(?:\[name=(.*)\])?$/.exec(value);
      if (!match) throw new Error("Semantic role selector must be role=button[name=Save].");
      const role = match[1].trim();
      const name = normalize((match[2] || "").replace(/^['"]|['"]$/g, ""));
      const native = role === "button" ? "button" : role === "link" ? "a" : "[data-miki-role-fallback]";
      return [...document.querySelectorAll(`[role="${CSS.escape(role)}"],${native}`)]
        .find((element) => visible(element) && (!name || accessibleName(element) === name));
    }
    return document.querySelector(value);
  };
  const snapshot = () => ({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    text: (document.body?.innerText || "").slice(0, 12_000),
    elements: [...document.querySelectorAll("button,a,input,textarea,select,[role=button],[role=link],[contenteditable=true]")]
      .filter(visible).slice(0, 160).map((element) => ({
        tag: element.tagName.toLowerCase(), role: element.getAttribute("role") || "",
        name: accessibleName(element), type: element.getAttribute("type") || "",
        disabled: Boolean(element.disabled), value: "value" in element ? String(element.value || "").slice(0, 500) : ""
      }))
  });

  const handle = async ({ action, payload = {} }) => {
    if (action === "snapshot" || action === "extract") {
      const state = snapshot();
      if (action === "extract" && payload.selector) {
        const element = find(payload.selector);
        if (!element) throw new Error(`No browser element matched '${payload.selector}'.`);
        state.text = normalize(element.innerText || element.textContent || element.value || "").slice(0, 12_000);
      }
      return state;
    }
    if (action === "click" || action === "invoke") {
      const target = action === "invoke" ? payload.target : { selector: payload.selector };
      const selector = target?.selector || (target?.role ? `role=${target.role}[name=${target.name || target.text || ""}]` : target?.label ? `label=${target.label}` : target?.placeholder ? `placeholder=${target.placeholder}` : target?.text ? `text=${target.text}` : "");
      const element = find(selector);
      if (!element) throw new Error(`No browser element matched '${selector}'.`);
      if (element.disabled) throw new Error("Target browser element is disabled.");
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      element.focus?.();
      element.click();
      return { clicked: true, name: accessibleName(element), tag: element.tagName.toLowerCase() };
    }
    if (action === "type") {
      const element = find(payload.selector);
      if (!element) throw new Error(`No browser field matched '${payload.selector}'.`);
      if (element.disabled || element.readOnly) throw new Error("Target browser field is not editable.");
      element.focus?.();
      const text = String(payload.text || "");
      if (element.isContentEditable) element.textContent = text;
      else {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (!setter) throw new Error("Target element does not expose a writable value.");
        setter.call(element, text);
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      if (payload.enter) element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      return { typed: true, length: text.length, name: accessibleName(element) };
    }
    if (action === "press") {
      const target = payload.target;
      const selector = target?.selector || (target?.label ? `label=${target.label}` : target?.text ? `text=${target.text}` : "");
      const element = (selector && find(selector)) || document.activeElement || document.body;
      element.dispatchEvent(new KeyboardEvent("keydown", { key: String(payload.key || ""), bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", { key: String(payload.key || ""), bubbles: true, cancelable: true }));
      return { dispatched: true, key: payload.key };
    }
    if (action === "scroll") {
      if (payload.direction === "bottom") window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      else window.scrollBy({ top: payload.direction === "up" ? -Number(payload.pixels || 500) : Number(payload.pixels || 500), behavior: "smooth" });
      return { scrolled: true, x: scrollX, y: scrollY };
    }
    throw new Error(`Unsupported content action '${action}'.`);
  };

  const extensionApi = globalThis.browser || globalThis.chrome;
  extensionApi?.runtime?.onMessage?.addListener((message) => {
    if (message?.source !== "miki-browser-agent") return undefined;
    return handle(message);
  });
})();
