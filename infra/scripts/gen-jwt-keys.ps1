<#
.SYNOPSIS
    Generate an RSA 2048 keypair and emit env-ready single-line PEM strings
    (literal newlines escaped as \n) suitable for pasting into apps/backend/.env.

.EXAMPLE
    pwsh infra/scripts/gen-jwt-keys.ps1
    pwsh infra/scripts/gen-jwt-keys.ps1 > jwt.env
#>

$ErrorActionPreference = 'Stop'

if (-not (Get-Command openssl -ErrorAction SilentlyContinue)) {
    Write-Error 'openssl is required but was not found on PATH.'
    exit 1
}

$tmpDir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("spv-jwt-" + [guid]::NewGuid())) | Select-Object -ExpandProperty FullName
try {
    $priv = Join-Path $tmpDir 'jwt_private.pem'
    $pub  = Join-Path $tmpDir 'jwt_public.pem'

    & openssl genpkey -algorithm RSA -out $priv -pkeyopt rsa_keygen_bits:2048 2>$null | Out-Null
    & openssl rsa -in $priv -pubout -out $pub 2>$null | Out-Null

    function Escape-Pem([string]$path) {
        # Read raw, normalise line endings to LF, then encode newlines as the
        # literal two-character sequence \n so the value fits on a single env line.
        $raw = Get-Content -Raw -Path $path
        $normalised = $raw -replace "`r`n", "`n" -replace "`r", "`n"
        # Trim a single trailing newline to avoid producing a dangling \n.
        if ($normalised.EndsWith("`n")) { $normalised = $normalised.Substring(0, $normalised.Length - 1) }
        return ($normalised -replace "`n", '\n')
    }

    $privEscaped = Escape-Pem $priv
    $pubEscaped  = Escape-Pem $pub
    $kid         = "dev-key-" + (Get-Date -Format 'yyyy-MM')

    Write-Output '# --- Paste the lines below into apps/backend/.env ---'
    Write-Output ('JWT_PRIVATE_KEY="{0}"' -f $privEscaped)
    Write-Output ('JWT_PUBLIC_KEY="{0}"'  -f $pubEscaped)
    Write-Output ('JWT_KID={0}' -f $kid)
}
finally {
    Remove-Item -Recurse -Force -Path $tmpDir -ErrorAction SilentlyContinue
}
