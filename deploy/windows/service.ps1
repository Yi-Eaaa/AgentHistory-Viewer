param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Install", "Uninstall", "Restart", "Status")]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,

  [Parameter(Mandatory = $true)]
  [string]$NodePath
)

$ErrorActionPreference = "Stop"
$ServiceName = "AgentHistory"
$ServiceDisplayName = "AgentHistory Viewer"
$WinSWVersion = "2.12.0"
$ServiceDirectory = Join-Path $ProjectRoot "state\windows-service"
$LogDirectory = Join-Path $ServiceDirectory "logs"
$WrapperPath = Join-Path $ServiceDirectory "AgentHistoryService.exe"
$ConfigPath = Join-Path $ServiceDirectory "AgentHistoryService.xml"

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Administrator {
  if (-not (Test-Administrator)) {
    throw "安装、重启或卸载 Windows 服务需要管理员 PowerShell。请以管理员身份打开终端后重试。"
  }
}

function Escape-Xml([string]$Value) {
  return [Security.SecurityElement]::Escape($Value)
}

function Invoke-Wrapper([string[]]$Arguments, [switch]$AllowFailure) {
  & $WrapperPath @Arguments
  if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
    throw "WinSW 执行失败，退出码 $LASTEXITCODE"
  }
}

if ($Action -eq "Status") {
  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($null -eq $service) {
    Write-Error "Windows 服务 $ServiceName 尚未安装。"
    exit 3
  }
  $service | Format-List Name, DisplayName, Status, StartType
  exit 0
}

Assert-Administrator

if ($Action -eq "Uninstall") {
  if (Test-Path $WrapperPath) {
    Invoke-Wrapper @("stop") -AllowFailure
    Invoke-Wrapper @("uninstall") -AllowFailure
  }
  elseif ($null -ne (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
    & sc.exe stop $ServiceName | Out-Null
    & sc.exe delete $ServiceName | Out-Null
  }
  Remove-Item $ConfigPath -Force -ErrorAction SilentlyContinue
  Remove-Item $WrapperPath -Force -ErrorAction SilentlyContinue
  Write-Host "已卸载 Windows 服务：$ServiceName"
  exit 0
}

if ($Action -eq "Restart") {
  Invoke-Wrapper @("restart")
  exit 0
}

if (-not (Test-Path $NodePath)) {
  throw "找不到 Node.js：$NodePath"
}
if (-not (Test-Path (Join-Path $ProjectRoot "dist\server\index.js"))) {
  throw "缺少生产构建，请先执行 npm run build。"
}

New-Item -ItemType Directory -Path $ServiceDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null

$architecture = if ($env:PROCESSOR_ARCHITECTURE -eq "x86" -and -not $env:PROCESSOR_ARCHITEW6432) { "x86" } else { "x64" }
$downloadUrl = "https://github.com/winsw/winsw/releases/download/v$WinSWVersion/WinSW-$architecture.exe"
if (-not (Test-Path $WrapperPath)) {
  Write-Host "正在下载 WinSW $WinSWVersion ($architecture)..."
  Invoke-WebRequest -Uri $downloadUrl -OutFile $WrapperPath -UseBasicParsing
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
  Invoke-Wrapper @("stop") -AllowFailure
  Invoke-Wrapper @("uninstall") -AllowFailure
}

$escapedNode = Escape-Xml $NodePath
$escapedArguments = Escape-Xml ('"' + (Join-Path $ProjectRoot "scripts\run.mjs") + '" start')
$escapedRoot = Escape-Xml $ProjectRoot
$escapedLogs = Escape-Xml $LogDirectory
$escapedProfile = Escape-Xml $env:USERPROFILE
$escapedHomeDrive = Escape-Xml $env:HOMEDRIVE
$escapedHomePath = Escape-Xml $env:HOMEPATH

$config = @"
<service>
  <id>$ServiceName</id>
  <name>$ServiceDisplayName</name>
  <description>AgentHistory Viewer for local Codex and Claude Code conversations.</description>
  <executable>$escapedNode</executable>
  <arguments>$escapedArguments</arguments>
  <workingdirectory>$escapedRoot</workingdirectory>
  <env name="NODE_ENV" value="production" />
  <env name="USERPROFILE" value="$escapedProfile" />
  <env name="HOME" value="$escapedProfile" />
  <env name="HOMEDRIVE" value="$escapedHomeDrive" />
  <env name="HOMEPATH" value="$escapedHomePath" />
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <stoptimeout>20sec</stoptimeout>
  <hidewindow>true</hidewindow>
  <onfailure action="restart" delay="5 sec" />
  <logpath>$escapedLogs</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>4</keepFiles>
  </log>
</service>
"@

Set-Content -Path $ConfigPath -Value $config -Encoding UTF8
Invoke-Wrapper @("install")
Invoke-Wrapper @("start")
Write-Host "已安装并启动 Windows 服务：$ServiceName"
