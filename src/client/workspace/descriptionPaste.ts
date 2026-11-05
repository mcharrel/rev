/** Only a single web URL turns a nonempty selection into a Markdown link. */
export function descriptionLink(selected: string, clipboard: string): string | null {
  const url = clipboard.trim();
  if (!selected.trim() || !/^https?:\/\/[^\s<>]+$/i.test(url)
    || Array.from(url).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  let destination: string;
  try { destination = new URL(url).href; } catch { return null; }
  const label = selected.trim().replace(/[\\[\]]/g, '\\$&');
  const leading = selected.slice(0, selected.length - selected.trimStart().length);
  const trailing = selected.slice(selected.trimEnd().length);
  // Angle brackets keep parentheses and other URL punctuation out of Markdown syntax.
  return `${leading}[${label}](<${destination}>)${trailing}`;
}

export function pasteDescriptionLink(event: ClipboardEvent, textarea: HTMLTextAreaElement): void {
  if (event.defaultPrevented || textarea.readOnly || textarea.disabled || (event.clipboardData?.files.length ?? 0) > 0) return;
  const start = textarea.selectionStart, end = textarea.selectionEnd;
  if (start === end) return;
  const before = textarea.value;
  const link = descriptionLink(before.slice(start, end), event.clipboardData?.getData('text/plain') ?? '');
  if (link === null) return;
  event.preventDefault();
  // Native insertion retains the editor's undo history; direct range changes do not.
  const input = { fired: false };
  const onInput = () => { input.fired = true; };
  textarea.addEventListener('input', onInput);
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Native insertText preserves undo; the standard range fallback does not.
    if (textarea.ownerDocument.activeElement === textarea) textarea.ownerDocument.execCommand('insertText', false, link);
  } catch { /* Use the range API when unavailable. */ }
  finally { textarea.removeEventListener('input', onInput); }
  if (textarea.value === before) {
    textarea.setRangeText(link, start, end, 'end');
    input.fired = false;
  }
  if (!input.fired) textarea.dispatchEvent(new Event('input', { bubbles: true }));
}
