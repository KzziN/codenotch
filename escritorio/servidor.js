#!/usr/bin/env node
'use strict';
/*
 * Escritório — servidor local.
 *
 * Olha o que está rodando neste PC (apps, CMDs, portas, agentes de IA) e
 * entrega para a página index.html em /api/status. Só lê: nunca abre, fecha
 * ou muda nada nos seus projetos. Não precisa de `npm install`.
 *
 *   node servidor.js            abre em http://localhost:7777
 *   node servidor.js --abrir    e já abre o navegador
 *   node servidor.js --json     imprime um retrato e sai (para testar)
 */

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const DIR = __dirname;
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const HOME = os.homedir();
const ARGS = new Set(process.argv.slice(2));
const CONFIG_PATH = process.env.ESCRITORIO_CONFIG || path.join(DIR, 'projetos.json');

// ───────────────────────────── utilidades ─────────────────────────────

const agora = () => Date.now();
const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const base = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || '';
const semExe = (s) => String(s || '').toLowerCase().replace(/\.exe$/, '');
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest().readUInt32BE(0);
const log = (...a) => console.log(new Date().toLocaleTimeString('pt-BR'), ...a);

function curto(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function json(line) {
  if (!line || line.charCodeAt(0) !== 123 /* { */) return null;
  try { return JSON.parse(line); } catch { return null; }
}

function lerTrecho(arquivo, inicio, tamanho) {
  const fd = fs.openSync(arquivo, 'r');
  try {
    const b = Buffer.alloc(tamanho);
    const n = fs.readSync(fd, b, 0, tamanho, inicio);
    return b.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function expandir(p) {
  let s = String(p || '').trim();
  if (!s) return '';
  s = s.replace(/^~(?=$|[\\/])/, HOME);
  s = s.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? process.env[v.toUpperCase()] ?? m);
  return s;
}

// Linhas de comando podem carregar senhas e tokens: esconde antes de mostrar.
function limparCmd(cmd) {
  let s = String(cmd || '');
  s = s.replace(/(-(?:e|enc|encodedcommand)\s+)\S+/gi, '$1…');
  s = s.replace(/((?:token|senha|password|passwd|pass|pwd|secret|segredo|apikey|api[-_]key|key|auth|bearer|authorization)["']?\s*[=:\s]\s*["']?)[^\s"'&]+/gi, '$1***');
  s = s.replace(/\b[A-Za-z0-9_\-]{40,}\b/g, '…');
  return curto(s, 400);
}

// Palavra-chave casa quando uma palavra do texto começa com ela:
// "totem" casa com "C:\proj\totem-faculdade" e "TotemPagamento".
function casaPalavra(texto, palavra) {
  let i = texto.indexOf(palavra);
  while (i >= 0) {
    const antes = i === 0 ? '' : texto[i - 1];
    if (!antes || !/[a-z0-9]/.test(antes)) return true;
    i = texto.indexOf(palavra, i + 1);
  }
  return false;
}

// ───────────────────────────── configuração ─────────────────────────────

const PADRAO = {
  titulo: 'Escritório',
  porta: 7777,
  acessoNaRede: false,
  senha: '',
  linkRemoto: false,
  enderecosPermitidos: [],
  descobrirProjetos: true,
  lerPastaDosCmds: false,
  minutosAgenteParado: 45,
  diasDeHistorico: 14,
  projetos: [],
};

const cfgCache = { mtime: -1, valor: null, erro: null };

function slug(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sala';
}

function lista(v) {
  if (v == null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => x != null && x !== '');
}

function normalizarConfig(c) {
  const cfg = { ...PADRAO, ...c };
  cfg.senha = String(cfg.senha || '');
  cfg.enderecosPermitidos = lista(c.enderecosPermitidos).map((h) => String(h).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  const vistos = new Set();
  cfg.projetos = lista(c.projetos).filter((p) => p && p.nome && !p.oculto).map((p) => {
    let id = slug(p.id || p.nome);
    while (vistos.has(id)) id += '-2';
    vistos.add(id);
    return {
      id,
      nome: String(p.nome),
      descricao: String(p.descricao || ''),
      icone: String(p.icone || 'pasta'),
      cor: String(p.cor || ''),
      pastas: lista(p.pastas).map(expandir).filter(Boolean),
      palavras: lista(p.palavras).map((w) => norm(w)).filter((w) => w.length >= 2),
      url: String(p.url || ''),
      portas: lista(p.porta ?? p.portas).map(Number).filter((n) => n > 0 && n < 65536),
      processos: lista(p.processos).map(semExe),
      servicos: lista(p.servicos).map(String),
    };
  });
  return cfg;
}

function config() {
  let st;
  try { st = fs.statSync(CONFIG_PATH); } catch {
    if (!cfgCache.valor) cfgCache.valor = normalizarConfig({});
    cfgCache.erro = 'Não achei o projetos.json. Mostrando só os projetos descobertos sozinho.';
    return cfgCache.valor;
  }
  if (st.mtimeMs === cfgCache.mtime && cfgCache.valor) return cfgCache.valor;
  cfgCache.mtime = st.mtimeMs;
  try {
    const bruto = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
    cfgCache.valor = normalizarConfig(JSON.parse(bruto));
    cfgCache.erro = null;
  } catch (e) {
    cfgCache.erro = `O projetos.json tem um erro e foi ignorado até ser corrigido: ${e.message}`;
    if (!cfgCache.valor) cfgCache.valor = normalizarConfig({});
  }
  return cfgCache.valor;
}

// ───────────────────────────── tipos de processo ─────────────────────────────

const SHELLS = new Set(['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'fish', 'dash', 'nu', 'wsl', 'wslhost', 'git-bash', 'elvish', 'xonsh']);

// Quem costuma ser "pai" de um terminal que você abriu (e não de um que um programa abriu por baixo).
const HOSPEDEIROS = new Set([
  'windowsterminal', 'openconsole', 'explorer', 'code', 'code - insiders', 'cursor', 'windsurf', 'kiro',
  'antigravity', 'trae', 'mintty', 'alacritty', 'wezterm-gui', 'wezterm', 'tabby', 'hyper', 'conemu64',
  'conemu', 'conemuc64', 'conemuc', 'cmder', 'fluentterminal', 'idea64', 'pycharm64', 'webstorm64',
  'studio64', 'rider64', 'devenv', 'totalcmd64', 'totalcmd', 'far', 'userinit', 'gnome-terminal-server',
  'konsole', 'xterm', 'kitty', 'iterm2', 'terminal', 'tmux: server', 'tmux', 'screen', 'sshd', 'login',
  'xfce4-terminal', 'tilix', 'terminator', 'ghostty', 'warp',
]);

const EDITORES = {
  code: 'VS Code', 'code - insiders': 'VS Code Insiders', cursor: 'Cursor', windsurf: 'Windsurf', kiro: 'Kiro',
  antigravity: 'Antigravity', trae: 'Trae', devenv: 'Visual Studio', idea64: 'IntelliJ', pycharm64: 'PyCharm',
  webstorm64: 'WebStorm', rider64: 'Rider', studio64: 'Android Studio', 'notepad++': 'Notepad++',
  sublime_text: 'Sublime Text', zed: 'Zed',
};

const APPS_DEV = new Set([
  'node', 'python', 'python3', 'pythonw', 'py', 'java', 'javaw', 'dotnet', 'php', 'php-cgi', 'ruby', 'go',
  'deno', 'bun', 'cloudflared', 'ngrok', 'adb', 'docker', 'com.docker.backend', 'uvicorn', 'gunicorn',
  'flask', 'nginx', 'httpd', 'caddy', 'mysqld', 'mariadbd', 'postgres', 'mongod', 'redis-server',
  'electron', 'esbuild', 'iisexpress', 'w3wp', 'tomcat', 'tomcat9', 'ollama', 'lms', 'rails', 'puma',
  'emulator', 'qemu-system-x86_64', 'scrcpy', 'codenotch', 'jupyter', 'streamlit', 'gradle', 'mvn',
]);

// Nomes cuja pasta atual vale a pena ler (quando lerPastaDosCmds está ligado).
const INTERESSANTES = [...SHELLS, ...APPS_DEV, 'claude', 'codex'].map((n) => n + '.exe');

function tipoAgente(p) {
  const c = norm(p.cmd);
  if (p.base === 'claude' || /claude-code|@anthropic-ai\/claude/.test(c)) return 'Claude Code';
  if (p.base === 'codex' || /@openai\/codex/.test(c)) return 'Codex';
  if (p.base === 'gemini' || /@google\/gemini-cli/.test(c)) return 'Gemini';
  if (p.base === 'cursor-agent') return 'Cursor Agent';
  if (p.base === 'aider' || /\baider\b/.test(c) && /python/.test(p.base)) return 'Aider';
  if (p.base === 'opencode') return 'OpenCode';
  return null;
}

// ───────────────────────────── coleta de processos ─────────────────────────────

const sis = {
  modo: 'iniciando',
  procs: new Map(),
  janelas: [],
  portas: [],
  servicos: [],
  temJanelas: false,
  temPastas: false,
  ms: 0,
  em: 0,
  erro: null,
};

const dadosDoWindows = () => sis.modo === 'powershell' || sis.modo === 'tasklist';

function registrar(procs, janelas, portas, servicos, extra) {
  const mapa = new Map();
  for (const p of procs) {
    if (!p || !p.pid) continue;
    const nome = String(p.nome || '');
    mapa.set(p.pid, {
      pid: p.pid,
      ppid: p.ppid || 0,
      nome,
      base: semExe(nome),
      cmd: String(p.cmd || ''),
      pasta: p.pasta ? String(p.pasta).replace(/[\\/]+$/, '') : '',
      desde: p.desde ? (typeof p.desde === 'number' ? p.desde : Date.parse(p.desde) || 0) : 0,
      tty: p.tty || '',
      janelas: [],
      portas: [],
    });
  }
  for (const j of janelas || []) {
    let pr = mapa.get(j.pid);
    // Janela de console às vezes vem no nome do conhost: é do CMD pai dele.
    if (pr && pr.base === 'conhost' && mapa.get(pr.ppid)) pr = mapa.get(pr.ppid);
    if (pr && j.titulo) pr.janelas.push(String(j.titulo));
  }
  const vistas = new Set();
  for (const po of portas || []) {
    const k = po.pid + ':' + po.porta;
    if (vistas.has(k)) continue;
    vistas.add(k);
    const pr = mapa.get(po.pid);
    if (pr) pr.portas.push(po.porta);
  }
  for (const pr of mapa.values()) pr.portas.sort((a, b) => a - b);
  sis.procs = mapa;
  sis.janelas = janelas || [];
  sis.portas = [...vistas].map((k) => { const [pid, porta] = k.split(':').map(Number); return { pid, porta }; });
  sis.servicos = servicos || [];
  sis.em = agora();
  Object.assign(sis, extra || {});
}

// Windows: um PowerShell fica aberto (escondido) rodando coletor.ps1 em loop.
let ps = null;
let psChave = '';
let psFalhas = [];

function servicosDe(cfg) {
  return [...new Set(cfg.projetos.flatMap((p) => p.servicos))];
}

function iniciarColetorWindows(cfg) {
  const chave = JSON.stringify([cfg.lerPastaDosCmds, servicosDe(cfg)]);
  if (sis.modo === 'tasklist') return;
  if (ps && psChave === chave) return;
  if (ps) { const velho = ps; ps = null; velho.kill(); }
  psChave = chave;
  const script = path.join(DIR, 'coletor.ps1');
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Pai', String(process.pid), '-Intervalo', '4',
    '-LerPastas', cfg.lerPastaDosCmds ? '1' : '0',
    '-Servicos', servicosDe(cfg).join(',') || ',',
    '-Interessantes', INTERESSANTES.join(','),
  ];
  const filho = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  ps = filho;
  let buf = '';
  let recebeu = false;
  filho.stdout.setEncoding('utf8');
  filho.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const linha = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const v = json(linha);
      if (!v) continue;
      recebeu = true;
      registrar(v.procs || [], v.janelas || [], v.portas || [], v.servicos || [], {
        modo: 'powershell', temJanelas: !!v.temJanelas, temPastas: !!v.temPastas, ms: v.ms || 0, erro: null,
      });
    }
  });
  filho.stderr.setEncoding('utf8');
  filho.stderr.on('data', (d) => { if (!recebeu) sis.erro = curto(d, 300); });
  filho.on('error', (e) => { sis.erro = 'Não consegui abrir o PowerShell: ' + e.message; });
  filho.on('exit', () => {
    if (ps !== filho) return;
    ps = null;
    psFalhas = psFalhas.filter((t) => agora() - t < 60000).concat(agora());
    if (!recebeu && psFalhas.length >= 2) {
      log('O PowerShell não conseguiu rodar o coletor (política de execução?). Usando tasklist/netstat.');
      sis.modo = 'tasklist';
      coletarTasklist();
      return;
    }
    setTimeout(() => iniciarColetorWindows(config()), 3000);
  });
}

function rodar(cmd, args, timeout = 15000) {
  return new Promise((ok) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (erro, stdout) => ok(erro && !stdout ? '' : stdout || ''));
  });
}

// Plano B no Windows, sem PowerShell: tasklist traz os títulos das janelas, netstat as portas.
async function coletarTasklist() {
  const [tl, ns] = await Promise.all([
    rodar('cmd.exe', ['/d', '/c', 'chcp 65001 >nul & tasklist /v /fo csv /nh']),
    rodar('netstat', ['-ano']),
  ]);
  const procs = [];
  const janelas = [];
  for (const linha of tl.split(/\r?\n/)) {
    const c = [...linha.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]);
    if (c.length < 9) continue;
    const pid = Number(c[1]);
    procs.push({ pid, ppid: 0, nome: c[0], cmd: '' });
    const t = c[8];
    if (t && !/^(n\/a|n\/d|não disponível|nao disponivel)$/i.test(t)) janelas.push({ pid, titulo: t });
  }
  registrar(procs, janelas, lerNetstat(ns), [], { modo: 'tasklist', temJanelas: true, temPastas: false, erro: null });
  setTimeout(coletarTasklist, 8000);
}

function lerNetstat(txt) {
  const out = [];
  for (const linha of txt.split(/\r?\n/)) {
    const c = linha.trim().split(/\s+/);
    if (c.length >= 5 && c[0] === 'TCP' && (c[2] === '0.0.0.0:0' || c[2] === '[::]:0')) {
      const k = c[1].lastIndexOf(':');
      out.push({ porta: Number(c[1].slice(k + 1)), pid: Number(c[c.length - 1]) });
    }
  }
  return out;
}

// Linux e macOS (para testar fora do Windows).
function segundosDeEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim());
  if (!m) return 0;
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + (+m[4]);
}

async function coletarUnix() {
  const t0 = agora();
  const saida = await rodar('ps', ['-axo', 'pid=,ppid=,etime=,tty=,ucomm=,args=']);
  const procs = [];
  for (const linha of saida.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(linha);
    if (!m) continue;
    const pid = Number(m[1]);
    const p = { pid, ppid: Number(m[2]), nome: m[5], cmd: m[6], tty: m[4] === '?' || m[4] === '??' ? '' : m[4],
      desde: t0 - segundosDeEtime(m[3]) * 1000 };
    if (!IS_MAC) { try { p.pasta = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {} }
    procs.push(p);
  }
  let portas = [];
  const ss = await rodar('ss', ['-ltnpH']);
  if (ss) {
    for (const linha of ss.split('\n')) {
      const c = linha.trim().split(/\s+/);
      if (c.length < 4) continue;
      const porta = Number(c[3].slice(c[3].lastIndexOf(':') + 1));
      for (const m of linha.matchAll(/pid=(\d+)/g)) portas.push({ porta, pid: Number(m[1]) });
    }
  } else {
    const ls = await rodar('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
    let pid = 0;
    for (const linha of ls.split('\n')) {
      if (linha[0] === 'p') pid = Number(linha.slice(1));
      else if (linha[0] === 'n') portas.push({ porta: Number(linha.slice(linha.lastIndexOf(':') + 1)), pid });
    }
  }
  registrar(procs, [], portas, [], { modo: 'ps', temJanelas: false, temPastas: !IS_MAC, ms: agora() - t0, erro: null });
}

function iniciarColeta() {
  if (IS_WIN) {
    iniciarColetorWindows(config());
    setInterval(() => { if (sis.modo !== 'tasklist') iniciarColetorWindows(config()); }, 5000);
  } else {
    const volta = async () => { try { await coletarUnix(); } catch (e) { sis.erro = e.message; } setTimeout(volta, 4000); };
    volta();
  }
}

// ───────────────────────────── agentes (transcrições) ─────────────────────────────

const CAUDA = 256 * 1024;
const CABECA = 64 * 1024;
const cacheArquivos = new Map();

function raizesClaude() {
  const r = [];
  const cfgDir = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
  r.push({ dir: path.join(cfgDir, 'projects'), desktop: false });
  if (IS_WIN) {
    if (process.env.APPDATA) r.push({ dir: path.join(process.env.APPDATA, 'Claude', 'local-agent-mode-sessions'), desktop: true });
    const local = process.env.LOCALAPPDATA;
    if (local) {
      try {
        for (const e of fs.readdirSync(path.join(local, 'Packages'))) {
          const n = e.toLowerCase();
          if (n.includes('claude') || n.includes('anthropic')) {
            r.push({ dir: path.join(local, 'Packages', e, 'LocalCache', 'Roaming', 'Claude', 'local-agent-mode-sessions'), desktop: true });
          }
        }
      } catch {}
    }
  } else if (IS_MAC) {
    r.push({ dir: path.join(HOME, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'), desktop: true });
  }
  return r;
}

function andar(dir, prof, limite, out, desde) {
  // nas pastas do Claude Desktop só contam as transcrições que ficam dentro de um .claude
  if (prof > 8) return;
  let itens;
  try { itens = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of itens) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'subagents' || e.name === 'tool-results' || e.name === 'node_modules' || e.name === '.git') continue;
      andar(p, prof + 1, limite, out, desde);
    } else if (e.name.endsWith('.jsonl') && e.name !== 'audit.jsonl' &&
      (!limite.desktop || p.split(path.sep).includes('.claude'))) {
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs >= desde) out.push({ arquivo: p, st, ...limite });
    }
  }
}

function textoDoUsuario(v) {
  const c = v.message && v.message.content;
  let t = '';
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === 'tool_result')) return '';
    t = c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ');
  }
  t = t.trim();
  if (!t || t.startsWith('<') || t.startsWith('[Request interrupted') || t.startsWith('Caveat:')) return '';
  return curto(t, 160);
}

function pegarTitulo(info, v) {
  const t = String(v.type || '');
  if (t === 'custom-title') info.tituloProprio = v.customTitle || v.title || info.tituloProprio;
  else if (t === 'summary' && v.summary) info.resumo = v.summary;
  else if (t.includes('title')) {
    for (const [k, val] of Object.entries(v)) {
      if (k !== 'type' && /title/i.test(k) && typeof val === 'string' && val.trim()) { info.tituloIA = val; break; }
    }
  }
  if (typeof v.slug === 'string' && v.slug) info.slug = v.slug;
}

// O que o agente está fazendo, pelo nome da ferramenta que ele chamou por último.
function atividadeDaFerramenta(nome) {
  const n = String(nome || '');
  if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(n)) return 'lendo';
  if (/^(Edit|Write|MultiEdit|NotebookEdit|apply_patch)$/.test(n)) return 'escrevendo';
  if (/^(Bash|BashOutput|KillBash|KillShell|PowerShell|Monitor|shell|exec_command|local_shell|write_stdin)$/.test(n)) return 'comando';
  if (/^(WebFetch|WebSearch|web_search|web_search_call)$/.test(n) || /search|fetch|browse/i.test(n)) return 'pesquisando';
  if (/^(Task|Agent|spawn_agent)$/.test(n)) return 'delegando';
  if (/^(TodoWrite|update_plan)$/.test(n)) return 'planejando';
  return n ? 'ferramenta' : 'pensando';
}

// Uma frase curta sobre o alvo da ferramenta: o arquivo, o comando, a busca.
function detalheDaFerramenta(nome, input) {
  const i = input && typeof input === 'object' ? input : {};
  const arquivo = i.file_path || i.notebook_path || i.path;
  switch (atividadeDaFerramenta(nome)) {
    case 'lendo': return arquivo ? base(arquivo) : i.pattern ? `"${curto(i.pattern, 40)}"` : '';
    case 'escrevendo': return arquivo ? base(arquivo) : '';
    case 'comando': return curto(i.description || limparCmd(Array.isArray(i.command) ? i.command.slice(-1)[0] : i.command || i.cmd || ''), 70);
    case 'pesquisando': return curto(i.query || (i.url ? String(i.url).replace(/^https?:\/\//, '').split('/')[0] : ''), 60);
    case 'delegando': return curto(i.description || '', 60);
    default: {
      const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(String(nome || ''));
      return m ? `${m[1]}: ${m[2]}` : curto(String(nome || ''), 40);
    }
  }
}

function ultimoClaude(v) {
  const ts = Date.parse(v.timestamp) || 0;
  if (v.type === 'user') {
    const s = JSON.stringify(v.message || '').toLowerCase();
    return { tipo: 'usuario', ts, interrompido: s.includes('[request interrupted') };
  }
  const c = v.message && v.message.content;
  const blocos = Array.isArray(c) ? c : [];
  const ferramenta = blocos.find((b) => b && b.type === 'tool_use');
  const texto = typeof c === 'string' ? c : blocos.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ');
  const erro = v.isApiErrorMessage === true || (v.message && v.message.model === '<synthetic>' &&
    /api error|limit|limite|overloaded/i.test(texto));
  return {
    tipo: ferramenta ? 'ferramenta' : 'texto',
    ts,
    ferramenta: ferramenta ? String(ferramenta.name || '') : '',
    alvo: ferramenta ? detalheDaFerramenta(ferramenta.name, ferramenta.input) : '',
    parada: (v.message && v.message.stop_reason) || '',
    erro,
    texto: curto(texto, 180),
  };
}

function lerClaude(arquivo, st, antes, desktop) {
  const info = antes ? { ...antes } : { id: path.basename(arquivo, '.jsonl'), ferramenta: 'Claude Code', desktop };
  if (!antes) {
    const cabeca = lerTrecho(arquivo, 0, Math.min(st.size, CABECA));
    for (const linha of cabeca.split('\n')) {
      const v = json(linha);
      if (!v) continue;
      if (!info.pasta && typeof v.cwd === 'string') info.pasta = v.cwd;
      if (!info.inicio && v.timestamp) info.inicio = Date.parse(v.timestamp) || 0;
      if (!info.primeiroPrompt && v.type === 'user' && !v.isSidechain) info.primeiroPrompt = textoDoUsuario(v);
      if (v.sessionId) info.id = v.sessionId;
      pegarTitulo(info, v);
    }
    if (!info.pasta) {
      const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(cabeca);
      if (m) { try { info.pasta = JSON.parse('"' + m[1] + '"'); } catch {} }
    }
  }
  const inicio = Math.max(0, st.size - CAUDA);
  const linhas = lerTrecho(arquivo, inicio, st.size - inicio).split('\n');
  if (inicio > 0) linhas.shift();
  let principal = null;
  let modelo = '';
  let prompt = '';
  const titulos = {};
  for (let i = linhas.length - 1; i >= 0; i--) {
    const v = json(linhas[i]);
    if (!v) continue;
    if (!titulos.visto) pegarTitulo(titulos, v);
    if (v.type === 'last-prompt' && !info.ultimoPromptRegistrado && typeof v.lastPrompt === 'string') {
      info.ultimoPromptRegistrado = curto(v.lastPrompt, 160);
    }
    if ((v.type !== 'user' && v.type !== 'assistant') || v.isSidechain) continue;
    if (!principal) principal = v;
    if (!modelo && v.type === 'assistant' && v.message && v.message.model && v.message.model !== '<synthetic>') modelo = v.message.model;
    if (!prompt && v.type === 'user') prompt = textoDoUsuario(v);
    if (v.cwd && !info.pastaRecente) info.pastaRecente = v.cwd;
    if (v.gitBranch && !info.branch) info.branch = v.gitBranch;
  }
  if (titulos.tituloProprio) info.tituloProprio = titulos.tituloProprio;
  if (titulos.tituloIA) info.tituloIA = titulos.tituloIA;
  if (titulos.resumo) info.resumo = titulos.resumo;
  if (titulos.slug) info.slug = titulos.slug;
  if (modelo) info.modelo = modelo;
  if (prompt) info.ultimoPrompt = prompt;
  if (principal) {
    info.ultimo = ultimoClaude(principal);
    if (principal.gitBranch) info.branch = principal.gitBranch;
    if (principal.cwd) info.pastaRecente = principal.cwd;
  }
  info.pasta = info.pastaRecente || info.pasta || '';
  return info;
}

function estadoClaude(u, t) {
  if (!u || !u.ts) return 'parado';
  const q = t - u.ts;
  if (u.tipo === 'usuario') return (u.interrompido ? q < 3000 : q < 90000) ? 'trabalhando' : 'parado';
  if (u.erro) return q < 6 * 3600e3 ? 'erro' : 'parado';
  if (u.tipo === 'ferramenta') {
    if (u.ferramenta === 'AskUserQuestion' || u.ferramenta === 'ExitPlanMode') return q < 12 * 3600e3 ? 'esperando' : 'parado';
    return q < 20000 ? 'trabalhando' : q < 30 * 60e3 ? 'esperando' : 'parado';
  }
  if (u.parada === 'end_turn' || u.parada === 'stop_sequence') return q < 1500 ? 'trabalhando' : 'terminou';
  return q < 10000 ? 'trabalhando' : 'terminou';
}

function raizCodex() {
  return path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'sessions');
}

function arquivosCodex(desde) {
  const out = [];
  const raiz = raizCodex();
  const limite = new Date(desde);
  const chave = (a, m, d) => a * 10000 + m * 100 + d;
  const min = chave(limite.getFullYear(), limite.getMonth() + 1, limite.getDate()) - 1;
  const ler = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  for (const a of ler(raiz)) {
    for (const m of ler(path.join(raiz, a))) {
      for (const d of ler(path.join(raiz, a, m))) {
        if (chave(+a, +m, +d) < min) continue;
        const dir = path.join(raiz, a, m, d);
        for (const f of ler(dir)) {
          if (!f.endsWith('.jsonl')) continue;
          const p = path.join(dir, f);
          let st;
          try { st = fs.statSync(p); } catch { continue; }
          if (st.mtimeMs >= desde) out.push({ arquivo: p, st, codex: true });
        }
      }
    }
  }
  return out;
}

function passoCodex(v) {
  const p = v.payload || {};
  const t = p.type || '';
  switch (v.type) {
    case 'turn_context': return 'pensando';
    case 'response_item':
      if (['function_call', 'local_shell_call', 'custom_tool_call', 'web_search_call'].includes(t)) return 'ferramenta';
      if (['function_call_output', 'custom_tool_call_output', 'reasoning'].includes(t)) return 'pensando';
      if (t === 'message') return p.role === 'assistant' ? 'mensagem' : p.role === 'user' ? 'pensando' : null;
      return null;
    case 'event_msg':
      if (t === 'turn_aborted' || t === 'task_complete') return 'fim';
      if (['task_started', 'item_started', 'exec_command_begin', 'user_message', 'agent_reasoning', 'agent_reasoning_raw_content'].includes(t)) return 'pensando';
      if (t === 'agent_message') return 'mensagem';
      return null;
    default: return null;
  }
}

function lerCodex(arquivo, st, antes) {
  const info = antes ? { ...antes } : { id: path.basename(arquivo, '.jsonl'), ferramenta: 'Codex' };
  if (!antes) {
    const cabeca = lerTrecho(arquivo, 0, Math.min(st.size, CABECA));
    for (const linha of cabeca.split('\n')) {
      const v = json(linha);
      if (!v) continue;
      const p = v.payload || {};
      if (v.type === 'session_meta') { if (p.id) info.id = p.id; if (p.cwd) info.pasta = p.cwd; if (p.timestamp) info.inicio = Date.parse(p.timestamp) || 0; }
      if (!info.primeiroPrompt && v.type === 'event_msg' && p.type === 'user_message' && p.message) info.primeiroPrompt = curto(p.message, 160);
    }
    if (!info.pasta) {
      const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(cabeca);
      if (m) { try { info.pasta = JSON.parse('"' + m[1] + '"'); } catch {} }
    }
  }
  const inicio = Math.max(0, st.size - CAUDA);
  const linhas = lerTrecho(arquivo, inicio, st.size - inicio).split('\n');
  if (inicio > 0) linhas.shift();
  info.ultimo = null;
  for (let i = linhas.length - 1; i >= 0; i--) {
    const v = json(linhas[i]);
    if (!v) continue;
    const p = v.payload || {};
    if (!info.modelo && v.type === 'turn_context' && p.model) info.modelo = p.model;
    if (v.type === 'event_msg' && p.type === 'user_message' && p.message && !info.ultimoPromptLido) {
      info.ultimoPrompt = curto(p.message, 160);
      info.ultimoPromptLido = true;
    }
    if (!info.ultimo) {
      const passo = passoCodex(v);
      if (passo) {
        info.ultimo = { tipo: passo, ts: Date.parse(v.timestamp) || st.mtimeMs };
        if (passo === 'ferramenta') {
          const nome = p.name || (p.type === 'local_shell_call' ? 'local_shell' : p.type) || '';
          let args = p.arguments || p.input || (p.action ? { command: p.action.command } : {});
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { command: args }; } }
          if (nome === 'apply_patch') {
            const m = /\*\*\* (?:Update|Add) File: (.+)/.exec(typeof p.input === 'string' ? p.input : JSON.stringify(args));
            args = m ? { file_path: m[1].trim() } : {};
          }
          info.ultimo.ferramenta = nome;
          info.ultimo.alvo = detalheDaFerramenta(nome, args);
        }
      }
    }
    if (info.ultimo && info.modelo && info.ultimoPromptLido) break;
  }
  delete info.ultimoPromptLido;
  return info;
}

function estadoCodex(u, t) {
  if (!u) return 'parado';
  const q = t - u.ts;
  switch (u.tipo) {
    case 'ferramenta': return q < 3 * 60e3 ? 'trabalhando' : q < 30 * 60e3 ? 'esperando' : 'parado';
    case 'pensando': return q < 120e3 ? 'trabalhando' : 'parado';
    case 'mensagem': return q < 4000 ? 'trabalhando' : 'terminou';
    default: return 'terminou';
  }
}

const PERSONAS = ['Ana', 'Bia', 'Caio', 'Duda', 'Enzo', 'Fê', 'Gabi', 'Hugo', 'Iara', 'João', 'Lia', 'Malu',
  'Nina', 'Otto', 'Pedro', 'Rafa', 'Sofia', 'Téo', 'Vini', 'Zeca', 'Lara', 'Beto', 'Cadu', 'Mel'];

function lerAgentes(cfg) {
  const t = agora();
  const desde = t - Math.max(1, cfg.diasDeHistorico) * 86400e3;
  const achados = [];
  for (const r of raizesClaude()) andar(r.dir, 0, { desktop: r.desktop }, achados, desde);
  for (const a of arquivosCodex(desde)) achados.push(a);
  const vivos = new Set();
  const agentes = [];
  for (const a of achados) {
    vivos.add(a.arquivo);
    const c = cacheArquivos.get(a.arquivo);
    let info = c && c.info;
    if (!c || c.mtime !== a.st.mtimeMs || c.tam !== a.st.size) {
      try {
        info = a.codex ? lerCodex(a.arquivo, a.st, c && c.info) : lerClaude(a.arquivo, a.st, c && c.info, a.desktop);
        cacheArquivos.set(a.arquivo, { mtime: a.st.mtimeMs, tam: a.st.size, info });
      } catch { continue; }
    }
    if (!info || (!info.ultimo && !info.primeiroPrompt)) continue;
    const estado = info.ferramenta === 'Codex' ? estadoCodex(info.ultimo, t) : estadoClaude(info.ultimo, t);
    const titulo = info.tituloProprio || info.tituloIA || info.resumo || info.primeiroPrompt || info.slug || 'Sessão sem título';
    const ultimaAtividade = (info.ultimo && info.ultimo.ts) || a.st.mtimeMs;
    agentes.push({
      id: info.id,
      ferramenta: info.desktop ? 'Claude Desktop' : info.ferramenta,
      titulo: curto(titulo, 90),
      estado,
      ultimaAtividade,
      inicio: info.inicio || 0,
      ultimaMsg: info.ultimoPromptRegistrado || info.ultimoPrompt || '',
      resposta: info.ultimo && info.ultimo.texto ? info.ultimo.texto : '',
      ferramentaEmUso: info.ultimo && info.ultimo.ferramenta ? info.ultimo.ferramenta : '',
      atividade: estado !== 'trabalhando' ? '' : !info.ultimo ? 'pensando'
        : info.ultimo.tipo === 'ferramenta' ? atividadeDaFerramenta(info.ultimo.ferramenta)
          : info.ultimo.tipo === 'texto' || info.ultimo.tipo === 'mensagem' ? 'respondendo' : 'pensando',
      alvo: info.ultimo && info.ultimo.alvo ? info.ultimo.alvo : '',
      modelo: info.modelo || '',
      branch: info.branch || '',
      pasta: info.desktop ? '' : info.pasta || '',
      desktop: !!info.desktop,
      visivel: ['trabalhando', 'esperando', 'erro'].includes(estado) || t - ultimaAtividade < cfg.minutosAgenteParado * 60e3,
    });
  }
  for (const k of cacheArquivos.keys()) if (!vivos.has(k)) cacheArquivos.delete(k);
  return agentes;
}

// Pastas que o VS Code (com a extensão do Claude Code) tem abertas agora.
function lerIDEs() {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'ide');
  const out = [];
  let itens = [];
  try { itens = fs.readdirSync(dir); } catch { return out; }
  for (const f of itens) {
    if (!f.endsWith('.lock')) continue;
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      // Só pid, nome e pastas. O arquivo também tem um token, que nunca sai daqui.
      out.push({ pid: Number(v.pid) || 0, ide: String(v.ideName || 'Editor'), pastas: lista(v.workspaceFolders).map(String) });
    } catch {}
  }
  return out;
}

// ───────────────────────────── salas ─────────────────────────────

const PASTAS_GERAIS = () => new Set([
  norm(HOME), norm(path.join(HOME, 'Desktop')), norm(path.join(HOME, 'Área de Trabalho')), norm(path.join(HOME, 'Documents')),
  norm(path.join(HOME, 'Documentos')), norm(path.join(HOME, 'Downloads')), norm(path.join(HOME, 'OneDrive')),
  'c:', 'd:', '/', 'c:/windows/system32', 'c:/windows', norm(os.tmpdir()),
]);

const NOMES_GENERICOS = new Set(['src', 'app', 'apps', 'web', 'api', 'server', 'client', 'frontend', 'backend', 'site', 'code', 'projeto', 'project', 'main']);

const raizGitCache = new Map();
function raizDoProjeto(pasta) {
  const n = norm(pasta);
  if (raizGitCache.has(n)) return raizGitCache.get(n);
  let atual = String(pasta).replace(/[\\/]+$/, '');
  let achou = '';
  for (let i = 0; i < 6 && atual; i++) {
    try { if (fs.existsSync(path.join(atual, '.git'))) { achou = atual; break; } } catch {}
    const pai = path.dirname(atual);
    if (!pai || pai === atual) break;
    if (PASTAS_GERAIS().has(norm(pai))) break;
    atual = pai;
  }
  const r = achou || String(pasta).replace(/[\\/]+$/, '');
  raizGitCache.set(n, r);
  return r;
}

function nomeBonito(pasta) {
  const partes = String(pasta).replace(/\\/g, '/').split('/').filter(Boolean);
  let nome = partes.pop() || pasta;
  if (NOMES_GENERICOS.has(nome.toLowerCase()) && partes.length) nome = partes.pop() + '/' + nome;
  return nome;
}

function criarSala(p, tipo) {
  return {
    ...p,
    tipo,
    pastasN: p.pastas.map(norm),
    // "processos" do projetos.json são nomes de programa; "processos" da sala são os que estão rodando
    nomesProcessos: p.processos || [],
    app: null,
    terminais: [],
    processos: [],
    janelas: [],
    voce: [],
    agentes: [],
  };
}

function salaPorPasta(salas, pasta) {
  if (!pasta) return null;
  const n = norm(pasta);
  let melhor = null;
  let tam = -1;
  for (const s of salas) {
    for (const p of s.pastasN) {
      if ((n === p || n.startsWith(p + '/')) && p.length > tam) { melhor = s; tam = p.length; }
    }
  }
  if (melhor) return melhor;
  const rel = semCasa(n);
  for (const s of salas) if (s.tipo === 'projeto' && s.palavras.some((w) => casaPalavra(rel, w))) return s;
  return null;
}

// Tira a pasta do usuário do começo do caminho, para o nome de usuário não casar com palavra-chave.
function semCasa(n) {
  const h = norm(HOME);
  return n === h ? '' : n.startsWith(h + '/') ? n.slice(h.length) : n;
}

function salaPorTexto(salas, texto) {
  if (!texto) return null;
  const n = norm(texto);
  let melhor = null;
  let tam = -1;
  for (const s of salas) {
    for (const p of s.pastasN) if (p.length > 3 && n.includes(p) && p.length > tam) { melhor = s; tam = p.length; }
  }
  if (melhor) return melhor;
  const semHome = n.split(norm(HOME)).join('');
  for (const s of salas) if (s.palavras.some((w) => casaPalavra(semHome, w))) return s;
  return null;
}

function montarSalas(cfg) {
  const t = agora();
  const salas = cfg.projetos.map((p) => criarSala(p, 'projeto'));
  const recepcao = criarSala({
    id: 'recepcao', nome: 'Recepção', descricao: 'Conversas soltas, sessões do Claude Desktop e CMDs que não são de nenhum projeto.',
    icone: 'recepcao', cor: '#c9a86a', pastas: [], palavras: [], url: '', portas: [], processos: [], servicos: [],
  }, 'recepcao');
  const gerais = PASTAS_GERAIS();

  // 1. agentes → sala (criando salas novas para pastas desconhecidas)
  const agentes = lerAgentes(cfg);
  const ides = lerIDEs().filter((i) => !i.pid || sis.procs.size === 0 || sis.procs.has(i.pid));
  const auto = new Map();
  const salaDoAgente = new Map();
  const salaAuto = (pasta, origem) => {
    const raiz = raizDoProjeto(pasta);
    const k = norm(raiz);
    if (!auto.has(k)) {
      const nome = nomeBonito(raiz);
      const s = criarSala({
        id: 'auto-' + slug(nome) + '-' + (hash(k) % 1000), nome, descricao: `Descoberta sozinha ${origem}.`, icone: 'pasta', cor: '',
        pastas: [raiz], palavras: nome.length >= 4 && !NOMES_GENERICOS.has(nome.toLowerCase()) ? [norm(base(raiz))] : [],
        url: '', portas: [], processos: [], servicos: [],
      }, 'auto');
      auto.set(k, s);
    }
    return auto.get(k);
  };
  for (const a of agentes) {
    let sala = !a.pasta || a.desktop || gerais.has(norm(a.pasta)) ? recepcao : salaPorPasta(salas, a.pasta);
    if (!sala) sala = cfg.descobrirProjetos ? salaAuto(a.pasta, 'pelas conversas com os agentes') : recepcao;
    sala.agentes.push(a);
    salaDoAgente.set(a.id, sala);
  }
  for (const ide of ides) {
    for (const pasta of ide.pastas) {
      let sala = salaPorPasta(salas, pasta) || salaPorPasta([...auto.values()], pasta);
      if (!sala && cfg.descobrirProjetos && !gerais.has(norm(pasta))) sala = salaAuto(pasta, 'no editor aberto');
      if (sala && !sala.voce.some((v) => v.onde === ide.ide)) sala.voce.push({ onde: ide.ide, detalhe: pasta });
    }
  }
  const todas = [...salas, ...[...auto.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))];

  // 2. processos → sala
  const meus = new Set([process.pid]);
  if (ps && ps.pid) meus.add(ps.pid);
  for (const p of sis.procs.values()) if (meus.has(p.ppid)) meus.add(p.pid);
  // o CMD que abriu este servidor também é do escritório, não de um projeto
  let acima = sis.procs.get(process.pid);
  while (acima && sis.procs.get(acima.ppid) && SHELLS.has(sis.procs.get(acima.ppid).base)) {
    acima = sis.procs.get(acima.ppid);
    meus.add(acima.pid);
  }
  const portaParaSala = new Map();
  for (const s of todas) for (const po of s.portas) portaParaSala.set(po, s);
  const processosCfg = new Map();
  for (const s of todas) for (const n of s.nomesProcessos) processosCfg.set(n, s);

  const direto = new Map();
  for (const p of sis.procs.values()) {
    if (meus.has(p.pid)) continue;
    const ehShell = SHELLS.has(p.base);
    const agente = tipoAgente(p);
    const ehDev = APPS_DEV.has(p.base) || processosCfg.has(p.base) || agente;
    let s = null;
    for (const po of p.portas) if (portaParaSala.has(po)) { s = portaParaSala.get(po); break; }
    if (!s && processosCfg.has(p.base)) s = processosCfg.get(p.base);
    if (!s && (ehShell || ehDev) && p.pasta && !gerais.has(norm(p.pasta))) s = salaPorPasta(todas, p.pasta);
    if (!s && (ehShell || ehDev)) s = salaPorTexto(todas, p.cmd);
    if (!s && (ehShell || ehDev || EDITORES[p.base])) for (const j of p.janelas) { s = salaPorTexto(todas, j); if (s) break; }
    if (s) direto.set(p.pid, s);
  }
  // Sem a pasta do processo, o Claude/Codex aberto num CMD é ligado à conversa
  // que começou logo depois dele abrir.
  const usados = new Set();
  const porInicio = agentes.filter((a) => a.inicio && !a.desktop).sort((a, b) => a.inicio - b.inicio);
  const procsAgente = [...sis.procs.values()].filter((p) => !meus.has(p.pid) && p.desde && tipoAgente(p)).sort((a, b) => a.desde - b.desde);
  for (const p of procsAgente) {
    const tipo = tipoAgente(p);
    const pai = sis.procs.get(p.ppid);
    if (pai && tipoAgente(pai)) continue; // processo filho do próprio agente
    const naSala = direto.get(p.pid);
    const cand = porInicio.find((a) => !usados.has(a.id) && a.ferramenta === tipo && a.inicio >= p.desde - 5000 &&
      a.inicio - p.desde < 12 * 3600e3 && (!naSala || salaDoAgente.get(a.id) === naSala));
    if (!cand) continue;
    usados.add(cand.id);
    cand.vivo = true;
    cand.visivel = true;
    if (!naSala) direto.set(p.pid, salaDoAgente.get(cand.id));
  }

  // herança: o terminal fica com a sala do que roda dentro dele, e vice-versa
  const filhos = new Map();
  for (const p of sis.procs.values()) {
    if (!filhos.has(p.ppid)) filhos.set(p.ppid, []);
    filhos.get(p.ppid).push(p);
  }
  const salaDe = (p) => {
    if (direto.has(p.pid)) return direto.get(p.pid);
    const fila = [...(filhos.get(p.pid) || [])];
    for (let i = 0; i < fila.length && i < 200; i++) {
      if (direto.has(fila[i].pid)) return direto.get(fila[i].pid);
      fila.push(...(filhos.get(fila[i].pid) || []));
    }
    let pai = sis.procs.get(p.ppid);
    for (let i = 0; pai && i < 12; i++) {
      if ((SHELLS.has(pai.base) || tipoAgente(pai)) && direto.has(pai.pid)) return direto.get(pai.pid);
      pai = sis.procs.get(pai.ppid);
    }
    return null;
  };

  for (const p of sis.procs.values()) {
    if (meus.has(p.pid)) continue;
    const pai = sis.procs.get(p.ppid);
    const paiBase = pai ? pai.base : '';
    const agente = tipoAgente(p);
    if (SHELLS.has(p.base)) {
      if (pai && SHELLS.has(paiBase)) continue; // terminal dentro de terminal conta uma vez só
      // a regra depende de onde vieram os dados (Windows ou ps), não de onde o servidor roda
      const interativo = dadosDoWindows()
        ? p.janelas.length > 0 || HOSPEDEIROS.has(paiBase) || (!pai && !/\s\/c\s|-command|-encodedcommand|-file\s/i.test(p.cmd))
        : !!p.tty && (!pai || !SHELLS.has(paiBase));
      if (!interativo) continue;
      const s = salaDe(p) || recepcao;
      const temAgente = (() => {
        const fila = [...(filhos.get(p.pid) || [])];
        for (let i = 0; i < fila.length && i < 200; i++) { if (tipoAgente(fila[i])) return tipoAgente(fila[i]); fila.push(...(filhos.get(fila[i].pid) || [])); }
        return '';
      })();
      const rodando = (filhos.get(p.pid) || []).filter((f) => f.base !== 'conhost' && !SHELLS.has(f.base)).map((f) => f.nome);
      s.terminais.push({
        pid: p.pid, programa: nomeTerminal(p, paiBase), titulo: p.janelas[0] || '', pasta: p.pasta || '',
        desde: p.desde, agente: temAgente, rodando: [...new Set(rodando)].slice(0, 4),
      });
      continue;
    }
    if (EDITORES[p.base]) {
      for (const j of p.janelas) {
        const s = salaPorTexto(todas, j);
        if (s && !s.voce.some((v) => v.onde === EDITORES[p.base])) s.voce.push({ onde: EDITORES[p.base], detalhe: curto(j, 120) });
      }
      continue;
    }
    if (agente) continue; // agentes aparecem pelas conversas, não como processo
    // servidores MCP e ajudantes que o agente abre não são o app do projeto (a não ser que ouçam numa porta)
    if (pai && tipoAgente(pai) && !p.portas.length) continue;
    const s = direto.get(p.pid) || (APPS_DEV.has(p.base) || processosCfg.has(p.base) ? salaDe(p) : null);
    if (s) {
      s.processos.push({ pid: p.pid, programa: p.nome, cmd: limparCmd(p.cmd), pasta: p.pasta || '', desde: p.desde, portas: p.portas });
    } else if (p.janelas.length) {
      for (const j of p.janelas) { const sj = salaPorTexto(todas, j); if (sj) sj.janelas.push({ programa: p.nome, titulo: curto(j, 120) }); }
    }
  }

  // 3. estado do app de cada sala
  for (const s of [...todas, recepcao]) {
    s.app = estadoApp(s);
    const pers = new Set();
    for (const a of [...s.agentes].sort((x, y) => (x.inicio - y.inicio) || String(x.id).localeCompare(String(y.id)))) {
      let i = hash(a.id) % PERSONAS.length;
      for (let k = 0; k < PERSONAS.length && pers.has(PERSONAS[i]); k++) i = (i + 1) % PERSONAS.length;
      pers.add(PERSONAS[i]);
      a.persona = PERSONAS[i];
    }
    s.agentes.sort((a, b) => ordemEstado(a.estado) - ordemEstado(b.estado) || b.ultimaAtividade - a.ultimaAtividade);
    s.agentes = s.agentes.slice(0, 30);
    s.ultimaAtividade = Math.max(0, ...s.agentes.map((a) => a.ultimaAtividade), ...s.terminais.map((x) => x.desde || 0));
  }
  return [...todas, recepcao].map(({ pastasN, nomesProcessos, ...s }) => s);
}

function nomeTerminal(p, paiBase) {
  const nomes = { cmd: 'CMD', powershell: 'PowerShell', pwsh: 'PowerShell 7', bash: 'Bash', zsh: 'Zsh', fish: 'Fish', wsl: 'WSL', sh: 'sh', nu: 'Nushell' };
  const onde = { windowsterminal: 'no Windows Terminal', code: 'no VS Code', cursor: 'no Cursor', windsurf: 'no Windsurf', mintty: 'no Git Bash', studio64: 'no Android Studio' };
  return (nomes[p.base] || p.nome) + (onde[paiBase] ? ' ' + onde[paiBase] : '');
}

function ordemEstado(e) {
  return { esperando: 0, erro: 1, trabalhando: 2, terminou: 3, parado: 4 }[e] ?? 5;
}

// ───────────────────────────── saúde dos apps ─────────────────────────────

const saude = new Map();

function testarUrl(url) {
  return new Promise((ok) => {
    const t0 = agora();
    let u;
    try { u = new URL(url); } catch { ok({ ok: false, erro: 'endereço inválido' }); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', timeout: 4000, rejectUnauthorized: false, headers: { 'User-Agent': 'Escritorio/1' } }, (res) => {
      res.resume();
      const codigo = res.statusCode || 0;
      // o telão da sala mostra o app num iframe; alguns apps proíbem isso
      const xfo = String(res.headers['x-frame-options'] || '').toLowerCase();
      const csp = String(res.headers['content-security-policy'] || '').toLowerCase();
      const fa = /frame-ancestors([^;]*)/.exec(csp);
      const embutivel = !xfo && !(fa && !/\*|localhost|127\.0\.0\.1/.test(fa[1]));
      ok({ ok: codigo > 0 && codigo < 500, codigo, ms: agora() - t0, embutivel });
    });
    req.on('timeout', () => { req.destroy(); ok({ ok: false, erro: 'não respondeu em 4 s', ms: agora() - t0 }); });
    req.on('error', (e) => ok({ ok: false, erro: e.code === 'ECONNREFUSED' ? 'conexão recusada' : e.code === 'ENOTFOUND' ? 'endereço não encontrado' : e.message, ms: agora() - t0 }));
    req.end();
  });
}

function testarPorta(porta) {
  return new Promise((ok) => {
    const t0 = agora();
    const s = net.connect({ host: '127.0.0.1', port: porta });
    const fim = (r) => { s.destroy(); ok({ ...r, ms: agora() - t0 }); };
    s.setTimeout(1500, () => fim({ ok: false, erro: 'não respondeu' }));
    s.on('connect', () => fim({ ok: true }));
    s.on('error', () => fim({ ok: false, erro: 'porta fechada' }));
  });
}

async function checarSaude() {
  const cfg = config();
  await Promise.all(cfg.projetos.map(async (p) => {
    let r = null;
    if (p.url) r = await testarUrl(p.url);
    else if (p.portas.length) {
      const rs = await Promise.all(p.portas.map(testarPorta));
      r = { ok: rs.some((x) => x.ok), erro: rs.every((x) => !x.ok) ? rs[0].erro : '', ms: Math.min(...rs.map((x) => x.ms)) };
    }
    if (r) saude.set(p.id, { ...r, em: agora() });
    else saude.delete(p.id);
  }));
}

function estadoApp(s) {
  const h = saude.get(s.id);
  const portas = s.processos.flatMap((p) => p.portas.map((porta) => ({ porta, pid: p.pid, programa: p.programa })));
  const servicos = s.servicos && s.servicos.length
    ? sis.servicos.filter((x) => s.servicos.some((n) => new RegExp('^' + n.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(x.nome)))
    : [];
  const temServico = servicos.length > 0;
  const servicoOk = servicos.some((x) => /running/i.test(x.estado));
  const primeiraPorta = portas.find((x) => x.porta !== 48666);
  const tela = s.url ? { url: s.url, embutivel: h ? h.embutivel !== false : true }
    : primeiraPorta ? { url: `http://localhost:${primeiraPorta.porta}`, embutivel: true } : null;
  const base = { url: s.url || '', portas, servicos, verificadoEm: h ? h.em : 0, tela };
  if (h) {
    if (h.ok) return { ...base, estado: 'no-ar', codigo: h.codigo || 0, ms: h.ms, resumo: h.codigo ? `respondeu ${h.codigo} em ${h.ms} ms` : `porta aberta (${h.ms} ms)` };
    if (s.processos.length || servicoOk) return { ...base, estado: 'erro', codigo: h.codigo || 0, resumo: `rodando, mas ${h.codigo ? 'respondeu ' + h.codigo : h.erro}` };
    return { ...base, estado: 'desligado', resumo: h.codigo ? `respondeu ${h.codigo}` : h.erro || 'não respondeu' };
  }
  if (temServico) return { ...base, estado: servicoOk ? 'no-ar' : 'desligado', resumo: servicos.map((x) => `${x.exibicao || x.nome}: ${x.estado}`).join(', ') };
  if (portas.length) return { ...base, estado: 'no-ar', resumo: 'ouvindo na porta ' + [...new Set(portas.map((x) => x.porta))].join(', ') };
  if (s.processos.length) return { ...base, estado: 'no-ar', resumo: s.processos.length === 1 ? `${s.processos[0].programa} rodando` : `${s.processos.length} processos rodando` };
  return { ...base, estado: s.url || s.portas.length ? 'desligado' : 'sem-app', resumo: s.url || s.portas.length ? 'aguardando o primeiro teste' : 'nada rodando' };
}

// ───────────────────────────── retrato ─────────────────────────────

let ultimoRetrato = null;
let ultimoEm = 0;

function retrato() {
  if (ultimoRetrato && agora() - ultimoEm < 1500) return ultimoRetrato;
  const cfg = config();
  const avisos = [];
  if (cfgCache.erro) avisos.push(cfgCache.erro);
  if (sis.erro) avisos.push('Coleta de processos: ' + sis.erro);
  if (remoto.erro) avisos.push(remoto.erro);
  if (sis.modo === 'tasklist') avisos.push('O PowerShell não pôde rodar o coletor.ps1, então estou usando o tasklist: dá para ver os CMDs e as portas, mas não de qual projeto cada um é.');
  let salas = [];
  try { salas = montarSalas(cfg); } catch (e) { avisos.push('Erro ao montar as salas: ' + e.message); }
  ultimoRetrato = {
    versao: 1,
    agora: agora(),
    titulo: cfg.titulo,
    maquina: os.hostname(),
    usuario: (() => { try { return os.userInfo().username; } catch { return ''; } })(),
    plataforma: process.platform,
    linkRemoto: remoto.url || '',
    coleta: { modo: sis.modo, temJanelas: sis.temJanelas, temPastas: sis.temPastas, lerPastaDosCmds: !!cfg.lerPastaDosCmds, ms: sis.ms, em: sis.em },
    avisos,
    salas,
  };
  ultimoEm = agora();
  return ultimoRetrato;
}

// ───────────────────────────── servidor HTTP ─────────────────────────────

function hostsPermitidos(porta) {
  const h = new Set(['localhost', '127.0.0.1', '[::1]', os.hostname().toLowerCase()]);
  for (const lista of Object.values(os.networkInterfaces())) for (const i of lista || []) h.add(i.family === 'IPv6' || i.family === 6 ? `[${i.address}]` : i.address);
  return new Set([...h].flatMap((x) => [x, `${x}:${porta}`]));
}

// ───────────────────────────── acesso de fora (senha e link) ─────────────────────────────

const remoto = { url: '', host: '', erro: '' };

// Endereço que pode chamar o Escritório: esta máquina, a rede local e os endereços do projetos.json.
function hostPermitido(h, porta, permitidos, cfg) {
  if (permitidos.has(h) || h.endsWith('.local') || h.endsWith(`.local:${porta}`)) return true;
  const semPorta = h.replace(/:\d+$/, '');
  if (remoto.host && semPorta === remoto.host) return true;
  return cfg.enderecosPermitidos.some((p) => (p.startsWith('*.') ? semPorta.endsWith(p.slice(1)) : semPorta === p));
}

// Veio deste mesmo PC (e não por um túnel, que também chega pelo 127.0.0.1)?
function ehLocal(req) {
  const ip = String(req.socket.remoteAddress || '');
  const loop = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const viaTunel = req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for'];
  const h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return loop && !viaTunel && (h === 'localhost' || h === '127.0.0.1' || h === '[::1]');
}

// Pela rede local (acessoNaRede), sem túnel no meio?
function ehRedeLocal(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for']) return false;
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fe80:|fc|fd)/i.test(ip);
}

let sal = '';
function salDaSessao() {
  if (sal) return sal;
  const f = path.join(DIR, '.sessao');
  try { sal = fs.readFileSync(f, 'utf8').trim(); } catch {}
  if (!sal || sal.length < 32) {
    sal = crypto.randomBytes(24).toString('hex');
    try { fs.writeFileSync(f, sal); } catch {}
  }
  return sal;
}
const tokenDe = (senha) => crypto.createHmac('sha256', salDaSessao()).update('escritorio:' + senha).digest('base64url');
function igual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function lerCookie(req, nome) {
  for (const parte of String(req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nome) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return '';
}
const tentativas = new Map();
function ipDe(req) { return String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?'); }
function bloqueado(req) {
  const t = tentativas.get(ipDe(req));
  return t && t.n >= 8 && agora() - t.desde < 15 * 60e3;
}
function errou(req) {
  const ip = ipDe(req);
  const t = tentativas.get(ip);
  if (!t || agora() - t.desde > 15 * 60e3) tentativas.set(ip, { n: 1, desde: agora() });
  else t.n++;
}

// 'livre' | 'senha' (precisa entrar) | 'recusar' (de fora sem senha configurada)
function acesso(req, cfg) {
  if (ehLocal(req)) return 'livre';
  if (cfg.senha) return igual(lerCookie(req, 'escritorio'), tokenDe(cfg.senha)) ? 'livre' : 'senha';
  return (cfg.acessoNaRede || ARGS.has('--rede')) && ehRedeLocal(req) ? 'livre' : 'recusar';
}

function paginaEntrar(msg) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Entrar · Escritório</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@600&family=Nunito:wght@600;800&display=swap">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
    font-family: Nunito, system-ui, sans-serif; color: #f1f3fb;
    background: radial-gradient(900px 500px at 20% -10%, #24305a, transparent 60%), #121626; }
  form { width: min(360px, 100%); background: #1e2440; border: 1px solid #333c66; border-radius: 22px; padding: 26px 22px; display: grid; gap: 14px; }
  h1 { margin: 0; font-family: Fredoka, Nunito, sans-serif; font-weight: 600; font-size: 24px; }
  p { margin: 0; color: #a9b1d3; }
  label { font-weight: 800; font-size: 14px; }
  input { font: inherit; padding: 12px 14px; border-radius: 12px; border: 1px solid #333c66; background: #0f1322; color: #f1f3fb; }
  input:focus { outline: 3px solid #ffc86b; outline-offset: 1px; }
  button { font: inherit; font-weight: 800; padding: 12px; border: 0; border-radius: 999px; background: #ffc86b; color: #1d1405; cursor: pointer; }
  .erro { color: #ff8d9c; }
</style></head><body>
<form method="post" action="entrar">
  <h1>Escritório</h1>
  <p>Digite a senha que está no <b>projetos.json</b> do seu PC.</p>
  ${msg ? `<p class="erro" role="alert">${msg}</p>` : ''}
  <label for="senha">Senha</label>
  <input id="senha" name="senha" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">Entrar</button>
</form></body></html>`;
}

function abrirLinkRemoto(porta) {
  const filho = spawn(IS_WIN ? 'cloudflared.exe' : 'cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${porta}`],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const ler = (d) => {
    const m = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(String(d));
    if (!m || remoto.url) return;
    remoto.url = m[0];
    remoto.host = new URL(m[0]).host;
    remoto.erro = '';
    log(`Link para abrir de qualquer lugar (com a senha): ${m[0]}`);
    try { fs.writeFileSync(path.join(DIR, 'link-remoto.txt'), m[0] + '\n'); } catch {}
  };
  filho.stdout.on('data', ler);
  filho.stderr.on('data', ler);
  filho.on('error', () => { remoto.erro = 'O "linkRemoto" está ligado, mas não achei o cloudflared neste PC. Instale o cloudflared ou desligue a opção.'; });
  filho.on('exit', () => { if (remoto.url) { remoto.url = ''; remoto.host = ''; remoto.erro = 'O túnel do Cloudflare caiu. Reabra o Escritório para ganhar um link novo.'; } });
  const parar = () => { try { filho.kill(); } catch {} };
  process.on('exit', parar);
  process.on('SIGINT', () => { parar(); process.exit(0); });
}

const CABECALHOS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };

function servir(cfg) {
  const porta = Number(process.env.PORT) || cfg.porta || 7777;
  const host = ARGS.has('--rede') || cfg.acessoNaRede ? '0.0.0.0' : '127.0.0.1';
  const permitidos = hostsPermitidos(porta);
  const srv = http.createServer((req, res) => {
    const cfgAgora = config();
    // Só responde a quem chama pelo nome desta máquina ou por um endereço liberado (bloqueia "DNS rebinding").
    const h = String(req.headers.host || '').toLowerCase();
    if (!hostPermitido(h, porta, permitidos, cfgAgora)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...CABECALHOS });
      res.end('Acesso negado. Se este endereço é seu, coloque ele em "enderecosPermitidos" no projetos.json.');
      return;
    }
    const url = new URL(req.url, 'http://x');
    const seguro = req.headers['x-forwarded-proto'] === 'https' || !!req.headers['cf-visitor'];
    if (url.pathname === '/entrar') {
      if (req.method === 'POST') {
        if (bloqueado(req)) { res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8', ...CABECALHOS }); res.end(paginaEntrar('Muitas tentativas. Espere 15 minutos.')); return; }
        let corpo = '';
        req.on('data', (d) => { corpo += d; if (corpo.length > 4096) req.destroy(); });
        req.on('end', () => {
          const senha = new URLSearchParams(corpo).get('senha') || '';
          if (cfgAgora.senha && igual(senha, cfgAgora.senha)) {
            tentativas.delete(ipDe(req));
            res.writeHead(303, {
              Location: './', ...CABECALHOS,
              'Set-Cookie': `escritorio=${tokenDe(cfgAgora.senha)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${seguro ? '; Secure' : ''}`,
            });
            res.end();
          } else {
            errou(req);
            res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', ...CABECALHOS });
            res.end(paginaEntrar(cfgAgora.senha ? 'Senha errada.' : 'Nenhuma senha foi configurada no projetos.json.'));
          }
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...CABECALHOS });
      res.end(paginaEntrar(''));
      return;
    }
    if (url.pathname === '/sair') {
      res.writeHead(303, { Location: 'entrar', 'Set-Cookie': 'escritorio=; Path=/; Max-Age=0', ...CABECALHOS });
      res.end();
      return;
    }
    const pode = acesso(req, cfgAgora);
    if (pode === 'recusar') {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...CABECALHOS });
      res.end('Para abrir o Escritório de fora deste PC, coloque uma "senha" no projetos.json.');
      return;
    }
    if (pode === 'senha') {
      if (url.pathname === '/api/status') { res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', ...CABECALHOS }); res.end('{"entrar":true}'); }
      else { res.writeHead(303, { Location: 'entrar', ...CABECALHOS }); res.end(); }
      return;
    }
    if (url.pathname === '/api/status') {
      const corpo = JSON.stringify(retrato());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(corpo);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      fs.readFile(path.join(DIR, 'index.html'), 'utf8', (erro, html) => {
        if (erro) { res.writeHead(500); res.end('index.html não encontrado'); return; }
        if (!/^\s*<!doctype/i.test(html)) {
          // o index.html é escrito sem <head>/<body>; o navegador põe <title> e <style> no head sozinho
          html = '<!doctype html>\n<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' + html + '\n</html>';
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...CABECALHOS });
        res.end(html);
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Não encontrado');
  });
  srv.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`A porta ${porta} já está em uso — provavelmente o Escritório já está aberto em http://localhost:${porta}`);
      if (ARGS.has('--abrir')) abrirNavegador(`http://localhost:${porta}`);
      setTimeout(() => process.exit(0), 1500);
    } else {
      log('Erro no servidor:', e.message);
      process.exit(1);
    }
  });
  srv.listen(porta, host, () => {
    const url = `http://localhost:${porta}`;
    log(`Escritório aberto em ${url}`);
    if (host === '0.0.0.0') {
      for (const lista of Object.values(os.networkInterfaces())) {
        for (const i of lista || []) if ((i.family === 'IPv4' || i.family === 4) && !i.internal) log(`  na rede: http://${i.address}:${porta}`);
      }
    }
    log('Deixe esta janela aberta. Para fechar o Escritório, feche a janela ou aperte Ctrl+C.');
    if (cfg.linkRemoto) {
      if (cfg.senha) abrirLinkRemoto(porta);
      else { remoto.erro = 'O "linkRemoto" está ligado, mas falta uma "senha" no projetos.json. Sem senha, o link não é aberto.'; log(remoto.erro); }
    }
    if (ARGS.has('--abrir')) abrirNavegador(url);
  });
}

function abrirNavegador(url) {
  try {
    if (IS_WIN) spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else spawn(IS_MAC ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

// ───────────────────────────── início ─────────────────────────────

function iniciar() {
  iniciarColeta();
  checarSaude();
  setInterval(checarSaude, 10000);
  if (ARGS.has('--json')) {
    setTimeout(async () => {
      await checarSaude();
      ultimoRetrato = null;
      process.stdout.write(JSON.stringify(retrato(), null, 2) + '\n');
      process.exit(0);
    }, IS_WIN ? 9000 : 2500);
  } else {
    servir(config());
  }
}

if (require.main === module) iniciar();

// para os testes (node --test)
module.exports = {
  casaPalavra, limparCmd, lerNetstat, segundosDeEtime, normalizarConfig, estadoClaude, estadoCodex, ultimoClaude,
  lerClaude, atividadeDaFerramenta, detalheDaFerramenta, salaPorPasta, criarSala, registrar, montarSalas, sis,
  hostPermitido, ehLocal, ehRedeLocal, acesso, tokenDe, igual, lerCookie, remoto, iniciar,
};
