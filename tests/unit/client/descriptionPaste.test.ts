import { expect, it, vi } from 'vitest';
import { descriptionLink, pasteDescriptionLink } from '../../../src/client/workspace/descriptionPaste.js';
import { renderGitHubMarkdown } from '../../../src/utils/githubMarkdown.js';

it('links the selected words while preserving surrounding whitespace and URL punctuation', () => {
  const link = descriptionLink('  selected words\n', ' https://example.com/path(a)?q=one&x=two#part\n');
  expect(link).toBe('  [selected words](<https://example.com/path(a)?q=one&x=two#part>)\n');
  const html = String(renderGitHubMarkdown(link!));
  expect(html).toContain('href="https://example.com/path(a)?q=one&amp;x=two#part"');
  expect(html).toContain('>selected words</a>');
});
it('keeps brackets, backslashes, Unicode and inline formatting in the label', () => {
  const link = descriptionLink('Review [v2] \\ **résumé**', 'https://example.com/guide');
  const html = String(renderGitHubMarkdown(link!));
  expect(html).toContain('>Review [v2] \\ <strong>résumé</strong></a>');
  expect(html.match(/<a /g)).toHaveLength(1);
});
it.each(['', 'ordinary text', 'www.example.com', '/relative/path', 'https://', 'http://[invalid',
  'https://one.example https://two.example', 'https://example.com/\nnext', 'javascript:alert(1)', 'file:///tmp/file',
  'data:text/html,<script>', '<https://example.com>', 'https://example.com/\u0000'])('leaves ordinary paste alone for %j', clipboard => {
  expect(descriptionLink('selected words', clipboard)).toBeNull();
});
it.each(['', ' ', '\n\t'])('does not turn an empty or whitespace-only selection into a link', selected => {
  expect(descriptionLink(selected, 'https://example.com')).toBeNull();
});

function fixture(clipboard = 'https://example.com/guide') {
  class Textarea extends EventTarget {
    value = 'Before selected words after';
    selectionStart = 7;
    selectionEnd = 21;
    readOnly = false;
    disabled = false;
    ownerDocument = { activeElement: this as unknown, execCommand: vi.fn(() => false) };
    setRangeText = vi.fn((replacement: string, start: number, end: number, _mode: string) => {
      this.value = this.value.slice(0, start) + replacement + this.value.slice(end);
      this.selectionStart = this.selectionEnd = start + replacement.length;
    });
  }
  const textarea = new Textarea();
  const event = new Event('paste', { cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files: [], getData: () => clipboard }, configurable: true });
  const input = vi.fn(); textarea.addEventListener('input', input);
  const paste = () => pasteDescriptionLink(event as ClipboardEvent, textarea as unknown as HTMLTextAreaElement);
  return { textarea, event, input, paste };
}
it.each([true, false])('uses native insertion without replacing the whole draft or duplicating input (native event: %s)', firesInput => {
  const { textarea, event, input, paste } = fixture();
  textarea.ownerDocument.execCommand.mockImplementation((_command?: string, _ui?: boolean, replacement?: string) => {
    textarea.value = `Before ${replacement} after`;
    if (firesInput) textarea.dispatchEvent(new Event('input'));
    return true;
  });
  paste();
  expect(event.defaultPrevented).toBe(true);
  expect(textarea.ownerDocument.execCommand).toHaveBeenCalledWith('insertText', false, '[selected words](<https://example.com/guide>)');
  expect(textarea.setRangeText).not.toHaveBeenCalled();
  expect(input).toHaveBeenCalledOnce();
  expect(String(renderGitHubMarkdown(textarea.value))).toContain('>selected words</a> after');
});
it.each(['false', 'throws', 'inactive'])('falls back to a selection-only replacement when native insertion %s', mode => {
  const { textarea, event, input, paste } = fixture();
  if (mode === 'throws') textarea.ownerDocument.execCommand.mockImplementation(() => { throw new Error('Unavailable'); });
  if (mode === 'inactive') textarea.ownerDocument.activeElement = null;
  paste();
  expect(event.defaultPrevented).toBe(true);
  expect(textarea.value).toBe('Before [selected words](<https://example.com/guide>) after');
  expect(textarea.selectionStart).toBe(textarea.value.length - ' after'.length);
  expect(textarea.selectionEnd).toBe(textarea.selectionStart);
  expect(input).toHaveBeenCalledOnce();
});
it.each(['no selection', 'read only', 'disabled', 'canceled', 'file', 'no clipboard', 'plain text'])('preserves browser paste for %s', mode => {
  const { textarea, event, input, paste } = fixture(mode === 'plain text' ? 'new text' : undefined);
  if (mode === 'no selection') textarea.selectionEnd = textarea.selectionStart;
  if (mode === 'read only') textarea.readOnly = true;
  if (mode === 'disabled') textarea.disabled = true;
  if (mode === 'canceled') event.preventDefault();
  if (mode === 'file') Object.defineProperty(event, 'clipboardData', { value: { files: [{}] } });
  if (mode === 'no clipboard') Object.defineProperty(event, 'clipboardData', { value: null });
  paste();
  expect(event.defaultPrevented).toBe(mode === 'canceled');
  expect(textarea.value).toBe('Before selected words after');
  expect(textarea.ownerDocument.execCommand).not.toHaveBeenCalled();
  expect(textarea.setRangeText).not.toHaveBeenCalled();
  expect(input).not.toHaveBeenCalled();
});
