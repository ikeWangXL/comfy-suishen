import { readFileSync } from 'node:fs';

/** 本机控制台静态 UI。路由与数据操作由现有 API 域提供。 */
export const consolePage = readFileSync(new URL('./console.html', import.meta.url), 'utf8');
export const consoleCss = readFileSync(new URL('./console.css', import.meta.url), 'utf8');
export const consoleJs = readFileSync(new URL('./console.js', import.meta.url), 'utf8');
