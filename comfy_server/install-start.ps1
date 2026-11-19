# Comfy App Server 一键安装/启动（SERVER 开发文档 §3.1 交付物）。
# 用法：
#   双击 install-start.cmd，或命令行：
#     powershell -NoProfile -ExecutionPolicy Bypass -File install-start.ps1 [-NoBrowser]
#   -NoBrowser：启动后不自动打开控制台浏览器（脚本/自动化测试用）。
# 行为：
#   1) 检查 Windows 与 Node.js 26+（缺失时打开官方下载页，安装完成后按回车继续）。
#   2) 安装/更新 server 依赖（npm install）。
#   3) 打印迁移说明：真实数据目录首次启动将自动执行数据库迁移（迁移前自动备份数据库到
#      <数据目录>\backups\db-pre-migration-*.sqlite；迁移在事务中进行，失败回滚）。
#   4) 启动 server（前台窗口内运行，Ctrl+C 退出）；就绪后打开控制台 http://127.0.0.1:8787/。
#   5) 就绪后扫描 server/data/workflow/upload 与 create 中的 JSON 工作流；
#      工作流文件始终相对 server 安装目录存放。
# 脚本不覆盖用户数据目录或图库；数据目录 = %LOCALAPPDATA%\ComfyAppServer。
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
# 控制台统一 UTF-8（Win10+ conhost 支持）：中文输出不随系统 GBK 码页乱码，重定向日志同为 UTF-8。
try {
  & chcp.com 65001 | Out-Null
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }
$serverDirectory = $PSScriptRoot
$apiHealthUrl = 'http://127.0.0.1:8788/api/v1/health'
$consoleUrl = 'http://127.0.0.1:8787/'

function Write-Step([string]$message) { Write-Host "[comfy-server] $message" }

# ---- 1) Windows / Node.js 检查（§3.1-1/2）----
if (($PSVersionTable.PSVersion.Major -lt 5) -or (-not $env:OS.StartsWith('Windows'))) {
  Write-Step '此脚本仅支持 Windows（需 Windows 10+ 与 PowerShell 5.1+）。'
  exit 1
}
$osVersion = [Environment]::OSVersion.Version
if ($osVersion.Major -lt 10) {
  Write-Step "检测到 Windows 版本 $osVersion：需要 Windows 10 或更高版本。"
  exit 1
}

function Get-NodeMajor {
  $nodeVersion = $null
  try { $nodeVersion = (& node -v 2>$null).Trim() } catch { $nodeVersion = $null }
  if (-not $nodeVersion -or -not $nodeVersion.StartsWith('v')) { return $null }
  $major = 0
  if ([int]::TryParse($nodeVersion.TrimStart('v').Split('.')[0], [ref]$major)) { return $major }
  return $null
}

if ($NoBrowser) { $env:COMFY_SERVER_NO_BROWSER = '1' }

$nodeMajor = Get-NodeMajor
if ($null -eq $nodeMajor -or $nodeMajor -lt 26) {
  Write-Step '未检测到 Node.js 26+（本服务需要 Node.js 26 或更高版本）。'
  Write-Step '正在打开 Node.js 官方下载页；安装完成后回到本窗口按回车继续检查。'
  try { Start-Process 'https://nodejs.org/zh-cn/download' } catch { Write-Step '请手动访问 https://nodejs.org 下载并安装 LTS 或当前版（26+）。' }
  Read-Host '安装完成后按回车继续'
  $nodeMajor = Get-NodeMajor
  if ($null -eq $nodeMajor -or $nodeMajor -lt 26) {
    Write-Step '仍未检测到 Node.js 26+。若刚完成安装，请关闭本窗口、重新打开终端（让 PATH 生效）后再次运行本脚本。'
    exit 1
  }
}
Write-Step "Node.js $(node -v) 检查通过。"

# ---- 2) 安装/更新依赖（§3.1-3）----
Push-Location $serverDirectory
try {
  Write-Step '安装/更新 server 依赖（npm install）……'
  & npm install
  if ($LASTEXITCODE -ne 0) {
    Write-Step '依赖安装失败，请检查网络或 Node.js/npm 是否可用后重试。'
    exit 1
  }
} finally { Pop-Location }

# ---- 3) 数据目录与迁移说明（SERVER §11）----
$dataDirectory = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'ComfyAppServer' } else { Join-Path $env:USERPROFILE '.comfy-app-server' }
Write-Step "数据目录：$dataDirectory（账号、档案、图库记录、AI 密钥均在此，脚本不会覆盖该目录或图库）。"
Write-Step '首次在已有 V1 数据的目录启动时，server 会自动执行 V1→V1.1 数据迁移：迁移前自动备份数据库到 backups\db-pre-migration-*.sqlite，迁移在事务中执行、失败回滚。'

# ---- 4) 就绪后动作（前台内联，输出可见）：打开控制台 + 首装导入示例工作流（§3.1-4/6）----
function Import-ExampleWorkflow {
  try {
    $login = Invoke-RestMethod -Uri 'http://127.0.0.1:8788/api/v1/auth/login' -Method Post -Body (@{ username = 'admin'; password = 'admin' } | ConvertTo-Json) -ContentType 'application/json' -TimeoutSec 5
    $headers = @{ Authorization = "Bearer $($login.data.accessToken)" }
    $profiles = Invoke-RestMethod -Uri 'http://127.0.0.1:8788/api/v1/workflows' -Headers $headers -TimeoutSec 5
    Write-Step "已扫描 server/data/workflow/upload 与 create，当前可用工作流档案 $($profiles.data.items.Count) 个。"
  } catch {
    Write-Step "工作流目录扫描未完成：$($_.Exception.Message)（可在 App/控制台重试）。"
  }
}

# ---- 5) 启动 server（同窗口流式输出，Ctrl+C 退出；§3.1-5 由 server 自行输出版本/LAN/控制台地址）----
Write-Step '启动 server（Ctrl+C 退出）。就绪后控制台地址：http://127.0.0.1:8787/ ，App 使用下方 LAN 地址。'
$serverProcess = Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory $serverDirectory -NoNewWindow -PassThru
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  if ($serverProcess.HasExited) { break }
  try {
    $health = Invoke-RestMethod -Uri $apiHealthUrl -Method Get -TimeoutSec 2
    if ($health.data.reachable) { $ready = $true; break }
  } catch { Start-Sleep -Seconds 1 }
}
if ($ready) {
  Write-Step "server 就绪（$(node -v) 依赖已就位）。控制台：$consoleUrl"
  if (-not $env:COMFY_SERVER_NO_BROWSER) {
    try { Start-Process $consoleUrl } catch { Write-Step "无法自动打开浏览器，请手动访问 $consoleUrl" }
  }
  Import-ExampleWorkflow
} else {
  Write-Step 'server 未就绪（端口被占用或启动失败，详见上方 server 输出）。'
}
try { Wait-Process -Id $serverProcess.Id -ErrorAction SilentlyContinue } catch { }
Write-Step 'server 已退出。'
