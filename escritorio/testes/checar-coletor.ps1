# Confere o coletor.ps1 sem precisar de um Windows de verdade:
#   1. procura erros de sintaxe;
#   2. compila os dois trechos em C# (as chamadas ao Windows não rodam, mas precisam compilar);
#   3. roda uma volta com os comandos do Windows trocados por versões falsas e mostra a saída.
# Uso: pwsh -NoProfile -File testes/checar-coletor.ps1   (também roda no PowerShell do Windows)

$coletor = Join-Path $PSScriptRoot '..' 'coletor.ps1'
$erros = $null; $tokens = $null
[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $coletor), [ref]$tokens, [ref]$erros)
"Erros de sintaxe: $($erros.Count)"
$erros | ForEach-Object { "  linha $($_.Extent.StartLineNumber): $($_.Message)" }

$texto = Get-Content $coletor -Raw
foreach ($b in [regex]::Matches($texto, "@'\r?\n(.*?)\r?\n'@", 'Singleline')) {
  $classe = ([regex]::Match($b.Groups[1].Value, 'class (\w+)')).Groups[1].Value
  try { Add-Type -TypeDefinition $b.Groups[1].Value -Language CSharp -ErrorAction Stop; "C# $classe`: compilou" }
  catch { "C# $classe`: FALHOU - $($_.Exception.Message)" }
}

function Get-CimInstance {
  $agora = Get-Date
  @(
    [pscustomobject]@{ ProcessId = 4120; ParentProcessId = 900; Name = 'cmd.exe'; CommandLine = 'C:\WINDOWS\system32\cmd.exe'; CreationDate = $agora.AddMinutes(-90) },
    [pscustomobject]@{ ProcessId = 4188; ParentProcessId = 4120; Name = 'node.exe'; CommandLine = 'node C:\Projetos\totem-faculdade\node_modules\vite\bin\vite.js --token=abc'; CreationDate = $agora.AddMinutes(-89) },
    [pscustomobject]@{ ProcessId = 900; ParentProcessId = 1; Name = 'WindowsTerminal.exe'; CommandLine = 'wt.exe'; CreationDate = $null },
    [pscustomobject]@{ ProcessId = 3020; ParentProcessId = 1; Name = 'cloudflared.exe'; CommandLine = 'cloudflared tunnel run totem'; CreationDate = $agora.AddHours(-26) }
  )
}
function Get-NetTCPConnection { @([pscustomobject]@{ LocalPort = 5173; OwningProcess = 4188; LocalAddress = '::1' }) }
function Get-Service { @([pscustomobject]@{ Name = 'MySQL80'; DisplayName = 'MySQL 8.0'; Status = 'Running' }) }

'Uma volta do coletor com dados falsos:'
# o coletor sai sozinho quando o processo "pai" fecha; aqui o pai é um processo que dura 2 s
$pai = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 2' -PassThru -NoNewWindow
& $coletor -Pai $pai.Id -Intervalo 1 -Servicos 'MySQL80' -Interessantes 'cmd.exe,node.exe'
