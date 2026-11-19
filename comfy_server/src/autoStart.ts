import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const startupFileName = 'ComfyAppServer.vbs';

function quoteVbs(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function setWindowsAutoStart(enabled: boolean): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Windows 自启设置仅支持 Windows。');
  const appData = process.env.APPDATA;
  if (!appData) throw new Error('无法找到当前 Windows 用户的 AppData 目录。');

  const startupDirectory = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const startupFile = path.join(startupDirectory, startupFileName);
  if (!enabled) {
    await rm(startupFile, { force: true });
    return;
  }

  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  const serverDirectory = path.resolve(sourceDirectory, '..');
  const entryPoint = path.join(serverDirectory, 'src', 'main.ts');
  const tsxEntrypoint = path.join(serverDirectory, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  await access(entryPoint);
  await access(tsxEntrypoint);
  await mkdir(startupDirectory, { recursive: true });

  const command = `${quoteVbs(process.execPath)} ${quoteVbs(tsxEntrypoint)} ${quoteVbs(entryPoint)}`;
  const script = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.CurrentDirectory = ${quoteVbs(serverDirectory)}`,
    `WshShell.Run ${quoteVbs(command)}, 0, False`
  ].join('\r\n');
  await writeFile(startupFile, script, { encoding: 'utf8', mode: 0o600 });
}
