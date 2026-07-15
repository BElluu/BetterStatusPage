[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')]
  [string]$Version,

  [Parameter(Mandatory = $false)]
  [Security.SecureString]$GitHubPat
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$image = 'ghcr.io/belluu/better-status-page'
$gitTag = "v$Version"
$utf8NoBom = [Text.UTF8Encoding]::new($false)
$loggedIn = $false
$plainPat = $null

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)] [string]$File,
    [Parameter(Mandatory = $true)] [string[]]$Arguments
  )

  Write-Host "`n> $File $($Arguments -join ' ')" -ForegroundColor DarkGray
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $File $($Arguments -join ' ')"
  }
}

function Invoke-ExternalOutput {
  param(
    [Parameter(Mandatory = $true)] [string]$File,
    [Parameter(Mandatory = $true)] [string[]]$Arguments
  )

  $output = & $File @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $File $($Arguments -join ' ')"
  }
  return ($output | Out-String).Trim()
}

function Write-Step {
  param([Parameter(Mandatory = $true)] [string]$Message)
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

try {
  Set-Location $repoRoot

  foreach ($command in @('git', 'npm.cmd', 'docker.exe')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
      throw "Required command is not available: $command"
    }
  }

  Write-Step 'Checking repository state'
  $branch = Invoke-ExternalOutput -File 'git' -Arguments @('branch', '--show-current')
  if ($branch -ne 'main') {
    throw "Release must be published from main. Current branch: $branch"
  }

  $status = Invoke-ExternalOutput -File 'git' -Arguments @('status', '--porcelain')
  if ($status) {
    throw "Working tree is not clean. Commit or remove local changes before publishing:`n$status"
  }

  Invoke-External -File 'git' -Arguments @('pull', '--ff-only', 'origin', 'main')

  if (Invoke-ExternalOutput -File 'git' -Arguments @('tag', '--list', $gitTag)) {
    throw "Local Git tag already exists: $gitTag"
  }

  $remoteTag = & git ls-remote --exit-code --tags origin "refs/tags/$gitTag"
  $remoteTagExitCode = $LASTEXITCODE
  if ($remoteTagExitCode -eq 0 -and $remoteTag) {
    throw "Remote Git tag already exists: $gitTag"
  }
  if ($remoteTagExitCode -ne 0 -and $remoteTagExitCode -ne 2) {
    throw "Could not check remote Git tag $gitTag (exit code $remoteTagExitCode)"
  }

  Write-Step "Synchronizing project version to $Version"
  $rootPackage = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
  $currentVersion = [version]$rootPackage.version
  $requestedVersion = [version]$Version
  if ($requestedVersion -lt $currentVersion) {
    throw "Version downgrade is not allowed: $currentVersion -> $requestedVersion"
  }
  if ($requestedVersion -gt $currentVersion) {
    Invoke-External -File 'npm.cmd' -Arguments @(
      'version', $Version,
      '--workspaces',
      '--include-workspace-root',
      '--no-git-tag-version'
    )
  } else {
    Write-Host "Project packages already use version $Version; skipping npm version."
  }

  Write-Step 'Updating GHCR image versions in documentation'
  $documentationFiles = @(
    Get-Item -LiteralPath 'README.md'
    Get-ChildItem -LiteralPath 'docs' -Filter '*.md' -File -Recurse
  )
  $imagePattern = 'ghcr\.io/belluu/better-status-page:(?:v)?\d+\.\d+\.\d+'
  $imageReplacement = "${image}:$Version"
  foreach ($file in $documentationFiles) {
    $content = [IO.File]::ReadAllText($file.FullName, $utf8NoBom)
    $updated = [Text.RegularExpressions.Regex]::Replace($content, $imagePattern, $imageReplacement)
    if ($updated -ne $content) {
      [IO.File]::WriteAllText($file.FullName, $updated, $utf8NoBom)
      Write-Host "Updated $($file.FullName.Substring($repoRoot.Length + 1))"
    }
  }

  Write-Step 'Running release verification'
  Invoke-External -File 'npm.cmd' -Arguments @('run', 'version:check')
  Invoke-External -File 'npm.cmd' -Arguments @('audit', '--omit=dev', '--audit-level=high')
  Invoke-External -File 'npm.cmd' -Arguments @('run', 'lint')
  Invoke-External -File 'npm.cmd' -Arguments @('test')
  Invoke-External -File 'npm.cmd' -Arguments @('run', 'build')
  Invoke-External -File 'git' -Arguments @('diff', '--check')

  Write-Step 'Creating the release commit when version files changed'
  Invoke-External -File 'git' -Arguments @(
    'add', '--',
    'package.json',
    'package-lock.json',
    'apps/admin/package.json',
    'apps/api/package.json',
    'apps/status/package.json',
    'packages/shared/package.json',
    'README.md',
    'docs'
  )

  & git diff --cached --quiet
  $stagedDiffExitCode = $LASTEXITCODE
  if ($stagedDiffExitCode -eq 1) {
    Invoke-External -File 'git' -Arguments @('commit', '-m', "chore: release $Version")
  } elseif ($stagedDiffExitCode -ne 0) {
    throw "Could not inspect staged release changes (exit code $stagedDiffExitCode)"
  } else {
    Write-Host 'No release metadata changes required; using the current commit.'
  }

  $revision = Invoke-ExternalOutput -File 'git' -Arguments @('rev-parse', 'HEAD')
  $versionImage = "${image}:$Version"
  $latestImage = "${image}:latest"

  Write-Step "Building $versionImage and $latestImage"
  Invoke-External -File 'docker.exe' -Arguments @(
    'build',
    '--pull',
    '--platform', 'linux/amd64',
    '--build-arg', "IMAGE_VERSION=$Version",
    '--build-arg', "IMAGE_REVISION=$revision",
    '--tag', $versionImage,
    '--tag', $latestImage,
    '.'
  )

  $versionImageId = Invoke-ExternalOutput -File 'docker.exe' -Arguments @(
    'image', 'inspect', $versionImage, '--format', '{{.Id}}'
  )
  $latestImageId = Invoke-ExternalOutput -File 'docker.exe' -Arguments @(
    'image', 'inspect', $latestImage, '--format', '{{.Id}}'
  )
  if ($versionImageId -ne $latestImageId) {
    throw "Local image tags do not reference the same image: $versionImageId != $latestImageId"
  }

  Write-Step 'Logging in to GitHub Container Registry'
  if (-not $GitHubPat) {
    $GitHubPat = Read-Host 'GitHub PAT classic with write:packages' -AsSecureString
  }
  $patPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($GitHubPat)
  try {
    $plainPat = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($patPointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($patPointer)
  }

  $plainPat | & docker.exe login ghcr.io --username BElluu --password-stdin
  if ($LASTEXITCODE -ne 0) {
    throw 'Docker login to ghcr.io failed'
  }
  $loggedIn = $true

  Write-Step "Publishing immutable image tag $Version"
  Invoke-External -File 'docker.exe' -Arguments @('push', $versionImage)

  Write-Step 'Publishing latest only after the versioned image succeeded'
  Invoke-External -File 'docker.exe' -Arguments @('push', $latestImage)

  Write-Step 'Publishing the release commit and Git tag'
  Invoke-External -File 'git' -Arguments @('tag', '-a', $gitTag, '-m', "BetterStatusPage $Version")
  Invoke-External -File 'git' -Arguments @('push', 'origin', 'main')
  Invoke-External -File 'git' -Arguments @('push', 'origin', $gitTag)

  Write-Step 'Inspecting published GHCR manifests'
  Invoke-External -File 'docker.exe' -Arguments @('buildx', 'imagetools', 'inspect', $versionImage)
  Invoke-External -File 'docker.exe' -Arguments @('buildx', 'imagetools', 'inspect', $latestImage)

  Write-Host "`nRelease $Version published successfully:" -ForegroundColor Green
  Write-Host "  $versionImage"
  Write-Host "  $latestImage"
  Write-Host "  Git tag: $gitTag"
} catch {
  [Console]::Error.WriteLine("Release failed: $($_.Exception.Message)")
  exit 1
} finally {
  $plainPat = $null
  if ($loggedIn) {
    & docker.exe logout ghcr.io | Out-Host
  }
  Set-Location $repoRoot
}
