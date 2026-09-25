param([string]$Root = (Join-Path $env:APPDATA 'OPL DSH Suite'),[string]$Payload = $PSScriptRoot,[string]$Launcher = '',[switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$app = Join-Path $Root 'runtime\0.1.7-rc.2\DeepSeek Harness'
$exe = Join-Path $app 'DeepSeek Harness.exe'
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'cache') | Out-Null
if (-not (Test-Path -LiteralPath $exe)) {
  $archive = Join-Path $Root 'cache\deepseek-harness-0.1.7-rc.2-win-x64.exe'
  $expected = '018edfe397583bb045adf81a2e6cd73563f4a5abe5c6449bb1e84fa3f585e8f5dc15d0caddf175a0750fb3fe1fd9bcd13a042f9bac1281ac19fe0ed4cdb3d19b'
  if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.1.7-rc.2-win-x64.exe' -OutFile ($archive + '.part')
    Move-Item -LiteralPath ($archive + '.part') -Destination $archive
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA512).Hash.ToLowerInvariant() -ne $expected) { throw '官方安装文件校验失败。' }
  if ((Get-AuthenticodeSignature -LiteralPath $archive).Status -ne 'Valid') { throw '官方安装文件签名无效。' }
  $process = Start-Process -FilePath $archive -ArgumentList @('/S', "/D=$app") -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw '官方运行环境安装失败。' }
}
if ((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -ne '0.1.7-rc.2') { throw '运行环境版本与本次 OPL DSH 不匹配。' }
if ((Get-AuthenticodeSignature -LiteralPath $exe).Status -ne 'Valid') { throw '运行环境签名无效。' }
$env:ELECTRON_RUN_AS_NODE = '1'
$env:NODE_USE_SYSTEM_CA = '1'
if ($Launcher) { $env:OPL_DESKTOP_LAUNCHER = $Launcher } else { Remove-Item Env:OPL_DESKTOP_LAUNCHER -ErrorAction SilentlyContinue }
$installArgs = @((Join-Path $Payload 'install.mjs'), $app, $Root, $Payload, '--no-launch') | ForEach-Object { '"' + $_ + '"' }
$installed = Start-Process -FilePath $exe -ArgumentList $installArgs -Wait -PassThru
if ($installed.ExitCode -ne 0) { throw 'OPL 增强安装失败。' }
if (-not $NoLaunch) { Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + (Join-Path $Root 'launch.vbs') + '"') }
