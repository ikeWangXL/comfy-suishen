import path from "node:path";
import { execFile } from "node:child_process";

export interface WindowsDrive {
  /** 形如 "C:"（不含尾反斜杠；路由层补全为 "C:\\"）。 */
  letter: string;
  label: string;
  driveType: number;
}

export function getWindowsPowerShellPath(): string {
  const windowsDirectory = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return path.join(windowsDirectory, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function getWindowsPowerShellEnvironment(): NodeJS.ProcessEnv {
  const windowsDirectory = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const modules = [
    path.join(windowsDirectory, "System32", "WindowsPowerShell", "v1.0", "Modules"),
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "WindowsPowerShell", "Modules") : "",
  ].filter(Boolean);
  return { ...process.env, PSModulePath: modules.join(path.delimiter) };
}

/**
 * 盘符枚举（S6 / API §7）：DriveInfo 枚举可浏览盘符——
 * DriveType 2（可移动）/3（本地固定）/4（网络）；光驱(5)排除。readable 由路由层按盘符根逐一探测。
 */
export async function listWindowsDrives(timeoutMs = 10_000): Promise<WindowsDrive[]> {
  const script = "$utf8 = New-Object System.Text.UTF8Encoding($false); " +
    "[Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8; " +
    "$drives = [System.IO.DriveInfo]::GetDrives() | Where-Object { [int]$_.DriveType -in 2,3,4 } | " +
    "ForEach-Object { $label = if ($_.IsReady) { $_.VolumeLabel } else { '' }; " +
    "[PSCustomObject]@{ DeviceID = $_.Name.Substring(0,2); VolumeName = $label; DriveType = [int]$_.DriveType } }; " +
    "ConvertTo-Json -InputObject @($drives) -Compress";
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(getWindowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: getWindowsPowerShellEnvironment(),
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdoutData, stderrData) => {
      if (error) {
        reject(new Error(`盘符枚举失败：${error.message}${stderrData ? `（${String(stderrData).trim()}）` : ""}`));
        return;
      }
      resolve(String(stdoutData));
    });
  });
  const parsed: unknown = JSON.parse(stdout || "[]");
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const drives: WindowsDrive[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const letter = typeof record.DeviceID === "string" ? record.DeviceID.trim() : "";
    if (!/^[A-Za-z]:$/.test(letter)) continue;
    drives.push({
      letter: `${letter[0].toUpperCase()}:`,
      label: typeof record.VolumeName === "string" ? record.VolumeName : "",
      driveType: typeof record.DriveType === "number" ? record.DriveType : Number(record.DriveType ?? 0),
    });
  }
  return drives.sort((a, b) => a.letter.localeCompare(b.letter));
}
