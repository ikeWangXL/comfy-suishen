import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { getWindowsPowerShellEnvironment, getWindowsPowerShellPath } from './powerShell.js';

function runPowerShell(script: string, input: string): Promise<string> {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('API 密钥保护仅支持 Windows 用户级 DPAPI。'));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(getWindowsPowerShellPath(), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: getWindowsPowerShellEnvironment() });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => stdout += chunk);
    child.stderr.on('data', (chunk: string) => stderr += chunk);
    child.on('error', () => reject(new Error('无法启动 Windows 密钥保护进程。')));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Windows 密钥保护失败：${stderr.trim() || '未知错误'}`));
      } else {
        resolve(stdout.trim());
      }
    });
    child.stdin.end(Buffer.from(input, 'utf8').toString('base64'), 'utf8');
  });
}

export async function protectSecret(secret: string): Promise<string> {
  if (secret.length === 0) throw new Error('密钥不能为空。');
  const script = [
    'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop',
    '$encoded = [Console]::In.ReadToEnd()',
    '$plain = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))',
    '$secure = ConvertTo-SecureString $plain -AsPlainText -Force',
    '$secure | ConvertFrom-SecureString'
  ].join('; ');
  return runPowerShell(script, secret);
}

export async function unprotectSecret(protectedSecret: string): Promise<string> {
  if (protectedSecret.length === 0) throw new Error('电脑端尚未配置 LLM 密钥。');
  const script = [
    'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop',
    '$encoded = [Console]::In.ReadToEnd()',
    '$encrypted = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))',
    '$secure = ConvertTo-SecureString $encrypted',
    '$credential = New-Object System.Net.NetworkCredential("", $secure)',
    '[Console]::Out.Write($credential.Password)'
  ].join('; ');
  return runPowerShell(script, protectedSecret);
}

// 账号凭据摘要（SERVER §4）：密码只存 scrypt 随机盐摘要（参数内嵌：scrypt$N$r$p$salt$hash），token 只存 sha256。
const SCRYPT_DEFAULT_N = 16384;
const SCRYPT_DEFAULT_R = 8;
const SCRYPT_DEFAULT_P = 1;
const SCRYPT_KEYLEN = 64;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_DEFAULT_N, r: SCRYPT_DEFAULT_R, p: SCRYPT_DEFAULT_P });
  return `scrypt$${SCRYPT_DEFAULT_N}$${SCRYPT_DEFAULT_R}$${SCRYPT_DEFAULT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 16384 || n > 2097152 || r < 8 || r > 64 || p < 1 || p > 8) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const derived = scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: 256 * 1024 * 1024 });
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}
