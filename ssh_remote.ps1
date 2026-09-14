param([string]$cmd)
$ErrorActionPreference = "Stop"

function Load-DotEnv($path) {
    $envHash = @{}
    if (Test-Path $path) {
        Get-Content $path | ForEach-Object {
            $line = $_.Trim()
            if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
                $idx = $line.IndexOf("=")
                $key = $line.Substring(0, $idx).Trim()
                $val = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
                $envHash[$key] = $val
            }
        }
    }
    return $envHash
}

$rootEnv = Load-DotEnv "d:\Obsidian\.env"
$HOST_IP = $rootEnv["DEPLOY_HOST"]
$USER = if ($rootEnv["DEPLOY_USER"]) { $rootEnv["DEPLOY_USER"] } else { "root" }
$PASSWORD = $rootEnv["DEPLOY_PASSWORD"]

$askpassPath = Join-Path $env:TEMP "ssh_ap.bat"
("@echo " + $PASSWORD) | Out-File -FilePath $askpassPath -Encoding ascii

$env:SSH_ASKPASS = $askpassPath
$env:SSH_ASKPASS_REQUIRE = "force"
$env:DISPLAY = "1"

try {
    ssh -o StrictHostKeyChecking=no "$USER@$HOST_IP" $cmd
} finally {
    if (Test-Path $askpassPath) {
        Remove-Item -Force $askpassPath
    }
}
