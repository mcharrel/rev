import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('registers and grants every native command used by the localhost desktop frontend', () => {
  const source = readFileSync('src-tauri/src/lib.rs', 'utf8');
  const handler = /generate_handler!\[([\s\S]*?)\]/.exec(source)![1];
  const registered = readFileSync('src-tauri/build.rs', 'utf8');
  const capability = JSON.parse(readFileSync('src-tauri/capabilities/remote-localhost.json', 'utf8'));
  for (const entry of handler.split(',').map(s => s.trim()).filter(Boolean)) {
    const command = entry.split('::').at(-1)!;
    expect(registered, command).toContain(`"${command}"`);
    expect(capability.permissions, command).toContain('allow-' + command.replaceAll('_', '-'));
  }
  expect(capability.remote.urls).toContain('http://127.0.0.1:*');
  expect(capability.remote.urls).toContain('http://localhost:*');
});
