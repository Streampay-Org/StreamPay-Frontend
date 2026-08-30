/**
 * Determines if a keyboard event originated from a text-entry context.
 * 
 * Used to prevent bare keyboard shortcuts (like "?" or "c") from accidentally
 * triggering when the user is typing inside an input, textarea, or content-editable element.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!target || typeof (target as any).tagName !== "string") {
    return false;
  }

  const el = target as HTMLElement;
  const tagName = el.tagName.toLowerCase();

  if (tagName === "input") {
    const type = (target as HTMLInputElement).type;
    // Types of input that do not receive text characters
    const nonTextTypes = [
      "button",
      "checkbox",
      "color",
      "file",
      "hidden",
      "image",
      "radio",
      "range",
      "reset",
      "submit",
    ];
    if (nonTextTypes.includes(type)) {
      return false;
    }
    return true;
  }

  if (tagName === "textarea" || tagName === "select") {
    return true;
  }

  // Check if it's a content-editable element
  if (
    el.isContentEditable ||
    el.getAttribute?.("contenteditable") === "true" ||
    el.getAttribute?.("contenteditable") === ""
  ) {
    return true;
  }

  return false;
}
