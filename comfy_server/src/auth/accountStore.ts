import { randomBytes } from 'node:crypto';
import type { AppDatabase } from '../database.js';
import { hashPassword, hashToken, verifyPassword } from '../secretStore.js';

export const DEFAULT_OWNER_USERNAME = 'admin';
export const DEFAULT_OWNER_PASSWORD = 'admin';

/**
 * owner 账号与 opaque token 门面（持久化在 AppDatabase）。
 * 语义（SERVER §4 / API §3）：单 owner；首次初始化 admin/admin，不强制改密；
 * 密码只存 scrypt 摘要，token 只存 sha256 摘要；多设备登录 = 多条 token 并存。
 */
export class AccountStore {
  constructor(private readonly database: AppDatabase) {}

  /** 每次启动调用：owner 未初始化时落 admin/admin；已初始化则原样保留（用户可能已改凭据）。 */
  async ensureOwnerAccount(): Promise<void> {
    if (this.database.getOwnerAccount()) return;
    await this.setCredentials(DEFAULT_OWNER_USERNAME, DEFAULT_OWNER_PASSWORD);
  }

  async verifyCredentials(username: string, password: string): Promise<boolean> {
    const record = this.database.getOwnerAccount();
    if (!record) return false;
    const passwordOk = await verifyPassword(password, record.passwordHash);
    if (!passwordOk) return false;
    return record.username === username;
  }

  /** PUT /auth/account 只拿得到当前密码（API §3），与用户名无关地校验。 */
  async verifyPassword(password: string): Promise<boolean> {
    const record = this.database.getOwnerAccount();
    if (!record) return false;
    return verifyPassword(password, record.passwordHash);
  }

  async setCredentials(username: string, password: string): Promise<void> {
    this.database.saveOwnerAccount(username, await hashPassword(password));
  }

  /** 只改其一：省略字段保持原值（API §3 PUT /auth/account）。 */
  async changeCredentials(newUsername?: string, newPassword?: string): Promise<void> {
    const record = this.database.getOwnerAccount();
    if (!record) throw new Error('owner 账号未初始化。');
    const username = newUsername ?? record.username;
    const passwordHash = newPassword === undefined ? record.passwordHash : await hashPassword(newPassword);
    this.database.saveOwnerAccount(username, passwordHash);
  }

  getUsername(): string | null {
    return this.database.getOwnerAccount()?.username ?? null;
  }

  /** 32 字节 opaque token（base64url），DB 只存 sha256 摘要与签发时间。 */
  issueToken(): string {
    const token = randomBytes(32).toString('base64url');
    this.database.saveAuthToken(hashToken(token));
    return token;
  }

  verifyToken(token: string): boolean {
    return this.database.hasAuthToken(hashToken(token));
  }

  revokeToken(token: string): void {
    this.database.deleteAuthToken(hashToken(token));
  }

  revokeAllTokens(): void {
    this.database.deleteAllAuthTokens();
  }
}
