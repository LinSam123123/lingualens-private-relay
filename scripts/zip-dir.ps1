param(
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][string]$Dst
)
if (Test-Path $Dst) {
  Remove-Item $Dst -Force
}
$parent = Split-Path -Parent $Dst
if ($parent -and -not (Test-Path $parent)) {
  New-Item -ItemType Directory -Path $parent | Out-Null
}
Compress-Archive -Path (Join-Path $Src '*') -DestinationPath $Dst -Force
