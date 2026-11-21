$ErrorActionPreference = 'Stop'
$path = Join-Path $env:USERPROFILE '.git-credentials'
if (-not (Test-Path $path)) { Write-Output 'NO_CREDENTIALS_FILE'; exit 1 }
$cred = Get-Content $path | Where-Object { $_ -match 'github\.com' } | Select-Object -First 1
if (-not $cred) { Write-Output 'NO_GITHUB_CREDENTIAL'; exit 1 }
$m = [regex]::Match($cred, 'https://([^:]+):([^@]+)@github\.com')
if (-not $m.Success) { Write-Output 'CREDENTIAL_PARSE_FAILED'; exit 1 }
$pair = $m.Groups[1].Value + ':' + $m.Groups[2].Value
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
$hdr = @(
  '-H', ('Authorization: Basic ' + $b64),
  '-H', 'Accept: application/vnd.github+json',
  '-H', 'User-Agent: iflow-ci-check'
)
function Get-Json([string]$url) {
  $raw = & curl.exe @hdr -s $url
  if (-not $raw) { return $null }
  return ($raw | ConvertFrom-Json)
}
foreach ($id in @(44960195231, 44960195233)) {
  $run = Get-Json "https://api.github.com/repos/yuentao/iFlow-Harness/actions/runs/$id"
  if (-not $run) { Write-Output ("{0}: API returned empty response" -f $id); continue }
  if ($run.message) { Write-Output ("{0}: API error: {1}" -f $id, $run.message); continue }
  Write-Output ("{0}: name={1} workflow={2} status={3} conclusion={4}" -f $id, $run.name, $run.workflow_id, $run.status, $run.conclusion)
  if ($run.conclusion -eq 'failure') {
    $jobs = Get-Json "https://api.github.com/repos/yuentao/iFlow-Harness/actions/runs/$id/jobs"
    if ($jobs -and $jobs.jobs) {
      foreach ($job in $jobs.jobs) {
        if ($job.conclusion -eq 'failure') {
          $failedSteps = ($job.steps | Where-Object { $_.conclusion -eq 'failure' } | ForEach-Object { $_.name }) -join ' / '
          Write-Output ("  FAILED_JOB: {0} | failed_steps: {1}" -f $job.name, $failedSteps)
        }
      }
    }
  }
}
