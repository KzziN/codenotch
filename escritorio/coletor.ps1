# coletor.ps1 - usado pelo servidor.js do Escritorio no Windows.
#
# So LE informacoes deste PC: processos, janelas abertas, portas em uso e
# (se voce configurar) servicos do Windows. Nao abre, fecha nem altera nada.
# Escreve uma linha JSON a cada $Intervalo segundos e sai sozinho quando o
# servidor.js que o abriu fecha.

param(
  [int]$Pai = 0,
  [int]$Intervalo = 4,
  [int]$LerPastas = 0,
  [string]$Servicos = '',
  [string]$Interessantes = ''
)

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

# Lista todas as janelas visiveis (titulo + processo dono). Get-Process so
# devolve uma janela por processo, e o VS Code costuma ter varias.
$janelasSrc = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class EscritorioJanelas {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string[] Listar() {
    var lista = new List<string>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      int n = GetWindowTextLength(h);
      if (n <= 0) return true;
      var sb = new StringBuilder(n + 1);
      GetWindowText(h, sb, sb.Capacity);
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      lista.Add(pid + "\t" + sb.ToString());
      return true;
    }, IntPtr.Zero);
    return lista.ToArray();
  }
}
'@

# Opcional (lerPastaDosCmds no projetos.json): le a pasta atual de cada CMD,
# PowerShell, node, python... para saber de qual projeto ele e. Fica desligado
# por padrao porque le a memoria desses processos, e antivirus de empresa as
# vezes estranham isso.
$pastasSrc = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class EscritorioPastas {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int acesso, bool herdar, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr endereco, byte[] buf, IntPtr tamanho, out IntPtr lidos);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int classe, IntPtr[] info, int tamanho, out int ret);
  static long LerPonteiro(IntPtr h, long endereco) {
    var b = new byte[8];
    IntPtr lidos;
    if (!ReadProcessMemory(h, new IntPtr(endereco), b, new IntPtr(8), out lidos)) return 0;
    return BitConverter.ToInt64(b, 0);
  }
  public static string Ler(int pid) {
    if (IntPtr.Size != 8) return null;
    IntPtr h = OpenProcess(0x0410, false, pid); // QUERY_INFORMATION | VM_READ
    if (h == IntPtr.Zero) return null;
    try {
      var pbi = new IntPtr[6];
      int ret;
      if (NtQueryInformationProcess(h, 0, pbi, 48, out ret) != 0) return null;
      long peb = pbi[1].ToInt64();
      if (peb == 0) return null;
      long parametros = LerPonteiro(h, peb + 0x20);
      if (parametros == 0) return null;
      var us = new byte[16];
      IntPtr lidos;
      if (!ReadProcessMemory(h, new IntPtr(parametros + 0x38), us, new IntPtr(16), out lidos)) return null;
      int tamanho = BitConverter.ToUInt16(us, 0);
      long texto = BitConverter.ToInt64(us, 8);
      if (tamanho <= 0 || tamanho > 4096 || texto == 0) return null;
      var s = new byte[tamanho];
      if (!ReadProcessMemory(h, new IntPtr(texto), s, new IntPtr(tamanho), out lidos)) return null;
      return Encoding.Unicode.GetString(s);
    } catch { return null; } finally { CloseHandle(h); }
  }
}
'@

$temJanelas = $false
try { Add-Type -TypeDefinition $janelasSrc -Language CSharp -ErrorAction Stop; $temJanelas = $true } catch {}

$temPastas = $false
if ($LerPastas -eq 1 -and [Environment]::Is64BitProcess) {
  try { Add-Type -TypeDefinition $pastasSrc -Language CSharp -ErrorAction Stop; $temPastas = $true } catch {}
}

$nomesServicos = @($Servicos -split ',' | Where-Object { $_ -ne '' })
$interessantes = @($Interessantes.ToLower() -split ',' | Where-Object { $_ -ne '' })

while ($true) {
  if ($Pai -gt 0 -and -not (Get-Process -Id $Pai -ErrorAction SilentlyContinue)) { exit }
  $t0 = [DateTime]::UtcNow

  $procs = New-Object System.Collections.ArrayList
  $lista = $null
  try { $lista = Get-CimInstance -ClassName Win32_Process -ErrorAction Stop } catch { $lista = Get-WmiObject -Class Win32_Process }
  foreach ($p in $lista) {
    $id = [int]$p.ProcessId
    $nome = [string]$p.Name
    $pasta = $null
    if ($temPastas -and ($interessantes -contains $nome.ToLower())) { $pasta = [EscritorioPastas]::Ler($id) }
    $desde = $null
    try {
      if ($p.CreationDate) {
        $d = $p.CreationDate
        if ($d -is [string]) { $d = [Management.ManagementDateTimeConverter]::ToDateTime($d) }
        $desde = $d.ToUniversalTime().ToString('o')
      }
    } catch {}
    [void]$procs.Add(@{ pid = $id; ppid = [int]$p.ParentProcessId; nome = $nome; cmd = [string]$p.CommandLine; pasta = $pasta; desde = $desde })
  }

  $janelas = New-Object System.Collections.ArrayList
  if ($temJanelas) {
    foreach ($linha in [EscritorioJanelas]::Listar()) {
      $i = $linha.IndexOf("`t")
      if ($i -gt 0) { [void]$janelas.Add(@{ pid = [int]$linha.Substring(0, $i); titulo = $linha.Substring($i + 1) }) }
    }
  } else {
    foreach ($gp in (Get-Process | Where-Object { $_.MainWindowTitle })) {
      [void]$janelas.Add(@{ pid = [int]$gp.Id; titulo = [string]$gp.MainWindowTitle })
    }
  }

  $portas = New-Object System.Collections.ArrayList
  $leuPortas = $false
  try {
    foreach ($c in (Get-NetTCPConnection -State Listen -ErrorAction Stop)) {
      [void]$portas.Add(@{ porta = [int]$c.LocalPort; pid = [int]$c.OwningProcess; ip = [string]$c.LocalAddress })
    }
    $leuPortas = $true
  } catch {}
  if (-not $leuPortas) {
    # netstat traduz o estado (LISTENING / ESCUTANDO...), entao a porta que
    # esta ouvindo e reconhecida pelo endereco remoto vazio (0.0.0.0:0 ou [::]:0).
    foreach ($l in (netstat -ano)) {
      $c = $l.Trim() -split '\s+'
      if ($c.Count -ge 5 -and $c[0] -eq 'TCP' -and ($c[2] -eq '0.0.0.0:0' -or $c[2] -eq '[::]:0')) {
        $k = $c[1].LastIndexOf(':')
        if ($k -gt 0) { [void]$portas.Add(@{ porta = [int]$c[1].Substring($k + 1); pid = [int]$c[$c.Count - 1]; ip = $c[1].Substring(0, $k) }) }
      }
    }
  }

  $svcs = New-Object System.Collections.ArrayList
  if ($nomesServicos.Count -gt 0) {
    foreach ($s in (Get-Service -Name $nomesServicos -ErrorAction SilentlyContinue)) {
      [void]$svcs.Add(@{ nome = [string]$s.Name; exibicao = [string]$s.DisplayName; estado = [string]$s.Status })
    }
  }

  $saida = @{
    procs = $procs
    janelas = $janelas
    portas = $portas
    servicos = $svcs
    temJanelas = $temJanelas
    temPastas = $temPastas
    ms = [int]([DateTime]::UtcNow - $t0).TotalMilliseconds
  }
  try {
    [Console]::Out.WriteLine(($saida | ConvertTo-Json -Depth 4 -Compress))
    [Console]::Out.Flush()
  } catch { exit }
  Start-Sleep -Seconds $Intervalo
}
