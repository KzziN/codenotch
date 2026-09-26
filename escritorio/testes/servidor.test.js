'use strict';
// Rode com: node --test   (dentro da pasta escritorio)
//
// amostra-coletor.json é a saída real do coletor.ps1 (rodado no PowerShell com
// os comandos do Windows trocados por versões falsas), mais duas janelas.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Uma pasta de usuário de mentira, antes de carregar o servidor
const CASA = fs.mkdtempSync(path.join(os.tmpdir(), 'escritorio-teste-'));
process.env.HOME = CASA;
process.env.USERPROFILE = CASA;
process.env.CLAUDE_CONFIG_DIR = path.join(CASA, '.claude');
process.env.CODEX_HOME = path.join(CASA, '.codex');

const s = require('../servidor.js');
test.after(() => fs.rmSync(CASA, { recursive: true, force: true }));

const iso = (msAtras) => new Date(Date.now() - msAtras).toISOString();
const agora = Date.now();

test('palavra-chave casa no começo de uma palavra do caminho', () => {
  assert.equal(s.casaPalavra('c:/projetos/totem-faculdade', 'totem'), true);
  assert.equal(s.casaPalavra('c:/projetos/totempagamento', 'totem'), true);
  assert.equal(s.casaPalavra('c:/projetos/autototem', 'totem'), false);
  assert.equal(s.casaPalavra('c:/c2a/kpax-audit', 'kpax'), true);
});

test('linha de comando esconde senhas e tokens', () => {
  const c = s.limparCmd('node app.js --token=abc123 --password hunter2 senha=segredo');
  assert.doesNotMatch(c, /abc123|hunter2|segredo/);
  assert.match(c, /--token=\*\*\*/);
  assert.doesNotMatch(s.limparCmd('powershell -EncodedCommand SQBFAFgA'), /SQBFAFgA/);
  assert.doesNotMatch(s.limparCmd('x ' + 'A'.repeat(60)), /A{40}/);
});

test('netstat em português: porta ouvindo é a que não tem endereço remoto', () => {
  const txt = [
    '  Proto  Endereço local         Endereço externo       Estado           PID',
    '  TCP    0.0.0.0:5173           0.0.0.0:0              ESCUTANDO        4188',
    '  TCP    [::]:8080              [::]:0                 ESCUTANDO        6044',
    '  TCP    192.168.0.5:52000      20.1.1.1:443           ESTABELECIDA     900',
  ].join('\r\n');
  assert.deepEqual(s.lerNetstat(txt), [{ porta: 5173, pid: 4188 }, { porta: 8080, pid: 6044 }]);
});

test('tempo do ps vira segundos', () => {
  assert.equal(s.segundosDeEtime('05:07'), 307);
  assert.equal(s.segundosDeEtime('02:00:01'), 7201);
  assert.equal(s.segundosDeEtime('1-00:00:00'), 86400);
});

test('estado do Claude pela última mensagem', () => {
  const e = (u, msAtras) => s.estadoClaude({ ...u, ts: agora - msAtras }, agora);
  assert.equal(e({ tipo: 'usuario' }, 5000), 'trabalhando');
  assert.equal(e({ tipo: 'usuario' }, 120000), 'parado');
  assert.equal(e({ tipo: 'usuario', interrompido: true }, 5000), 'parado');
  assert.equal(e({ tipo: 'ferramenta', ferramenta: 'Bash' }, 10000), 'trabalhando');
  assert.equal(e({ tipo: 'ferramenta', ferramenta: 'Bash' }, 60000), 'esperando');
  assert.equal(e({ tipo: 'ferramenta', ferramenta: 'Bash' }, 40 * 60000), 'parado');
  assert.equal(e({ tipo: 'ferramenta', ferramenta: 'AskUserQuestion' }, 5 * 60000), 'esperando');
  assert.equal(e({ tipo: 'texto', parada: 'end_turn' }, 3000), 'terminou');
  assert.equal(e({ tipo: 'texto', erro: true }, 60000), 'erro');
});

test('estado do Codex', () => {
  const e = (tipo, msAtras) => s.estadoCodex({ tipo, ts: agora - msAtras }, agora);
  assert.equal(e('pensando', 30000), 'trabalhando');
  assert.equal(e('ferramenta', 10 * 60000), 'esperando');
  assert.equal(e('mensagem', 10000), 'terminou');
  assert.equal(e('fim', 1000), 'terminou');
});

test('mensagem de limite do Claude conta como erro', () => {
  const u = s.ultimoClaude({ type: 'assistant', timestamp: iso(1000), isApiErrorMessage: true,
    message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit" }] } });
  assert.equal(u.erro, true);
});

test('o que o agente está fazendo, pela ferramenta', () => {
  assert.equal(s.atividadeDaFerramenta('Read'), 'lendo');
  assert.equal(s.atividadeDaFerramenta('Edit'), 'escrevendo');
  assert.equal(s.atividadeDaFerramenta('Bash'), 'comando');
  assert.equal(s.atividadeDaFerramenta('shell'), 'comando');
  assert.equal(s.atividadeDaFerramenta('WebSearch'), 'pesquisando');
  assert.equal(s.atividadeDaFerramenta('Task'), 'delegando');
  assert.equal(s.detalheDaFerramenta('Edit', { file_path: 'C:\\proj\\totem\\pagamento.js' }), 'pagamento.js');
  assert.equal(s.detalheDaFerramenta('Bash', { command: 'npm test --token=abc' }), 'npm test --token=***');
  assert.equal(s.detalheDaFerramenta('Bash', { command: 'x', description: 'Roda os testes' }), 'Roda os testes');
  assert.equal(s.detalheDaFerramenta('mcp__kpax__authenticate', {}), 'kpax: authenticate');
});

test('título da conversa: o nome que você deu vence o resumo', () => {
  const dir = path.join(CASA, 'titulos');
  fs.mkdirSync(dir, { recursive: true });
  const arq = path.join(dir, 's1.jsonl');
  fs.writeFileSync(arq, [
    { type: 'user', sessionId: 's1', cwd: 'C:\\p\\totem', timestamp: iso(5000), message: { role: 'user', content: 'arruma o pix' } },
    { type: 'summary', summary: 'Resumo automático' },
    { type: 'assistant', sessionId: 's1', cwd: 'C:\\p\\totem', gitBranch: 'main', timestamp: iso(1000), message: { model: 'claude-x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } },
    { type: 'custom-title', customTitle: 'Pix no totem', sessionId: 's1' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const info = s.lerClaude(arq, fs.statSync(arq), null, false);
  assert.equal(info.tituloProprio, 'Pix no totem');
  assert.equal(info.resumo, 'Resumo automático');
  assert.equal(info.primeiroPrompt, 'arruma o pix');
  assert.equal(info.pasta, 'C:\\p\\totem');
  assert.equal(info.modelo, 'claude-x');
  assert.equal(info.branch, 'main');
});

test('configuração: ids únicos, portas e endereços normalizados', () => {
  const c = s.normalizarConfig({
    projetos: [{ nome: 'Totem' }, { nome: 'Totem' }, { nome: 'Oculto', oculto: true }, { nome: 'NDD', porta: [8080, 'x', 99999] }],
    enderecosPermitidos: ['https://escritorio.c2a.com.br/'],
  });
  assert.deepEqual(c.projetos.map((p) => p.id), ['totem', 'totem-2', 'ndd']);
  assert.deepEqual(c.projetos[2].portas, [8080]);
  assert.deepEqual(c.enderecosPermitidos, ['escritorio.c2a.com.br']);
});

test('sala pela pasta: caminho exato vence palavra-chave, e o nome do usuário não conta', () => {
  const cfg = s.normalizarConfig({ projetos: [
    { nome: 'Totem', palavras: ['totem'] },
    { nome: 'Android', pastas: ['C:\\Projetos\\totem-faculdade\\android'] },
    { nome: 'Casa', palavras: [path.basename(CASA)] },
  ] });
  const salas = cfg.projetos.map((p) => s.criarSala(p, 'projeto'));
  assert.equal(s.salaPorPasta(salas, 'C:\\Projetos\\totem-faculdade').nome, 'Totem');
  assert.equal(s.salaPorPasta(salas, 'C:\\Projetos\\totem-faculdade\\android\\app').nome, 'Android');
  assert.equal(s.salaPorPasta(salas, path.join(CASA, 'outra-coisa')), null);
});

test('processos do Windows vão para a sala certa (amostra real do coletor)', () => {
  const amostra = JSON.parse(fs.readFileSync(path.join(__dirname, 'amostra-coletor.json'), 'utf8'));
  s.registrar(amostra.procs, amostra.janelas, amostra.portas, amostra.servicos, { modo: 'powershell' });
  const cfg = s.normalizarConfig({ projetos: [
    { nome: 'Totem', palavras: ['totem'] },
    { nome: 'Cloudflare', processos: ['cloudflared'] },
    { nome: 'Banco', servicos: ['MySQL*'] },
  ] });
  const salas = s.montarSalas(cfg);
  const sala = (nome) => salas.find((x) => x.nome === nome);

  const totem = sala('Totem');
  assert.equal(totem.app.estado, 'no-ar');
  assert.deepEqual(totem.app.portas.map((p) => p.porta), [5173]);
  assert.equal(totem.app.tela.url, 'http://localhost:5173');
  assert.equal(totem.processos[0].programa, 'node.exe');
  assert.doesNotMatch(totem.processos[0].cmd, /abc/, 'token escondido');
  assert.equal(totem.terminais.length, 1, 'o CMD do Windows Terminal que roda o vite');
  assert.equal(totem.terminais[0].titulo, 'npm run dev');
  assert.match(totem.terminais[0].programa, /CMD no Windows Terminal/);
  assert.deepEqual(totem.voce.map((v) => v.onde), ['VS Code']);

  assert.equal(sala('Cloudflare').app.estado, 'no-ar');
  assert.equal(sala('Banco').app.estado, 'no-ar');
  assert.match(sala('Banco').app.resumo, /MySQL 8\.0: Running/);
});

test('conversas dos agentes viram salas, e a pasta do usuário vai para a Recepção', () => {
  const proj = path.join(CASA, '.claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const repo = path.join(CASA, 'Projetos', 'meu-site');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const escrever = (id, cwd, linhas) => fs.writeFileSync(path.join(proj, id + '.jsonl'), linhas.map((l) => JSON.stringify({ sessionId: id, cwd, ...l })).join('\n') + '\n');
  escrever('a', path.join(repo, 'src'), [
    { type: 'user', timestamp: iso(20000), message: { role: 'user', content: 'cria a landing' } },
    { type: 'assistant', timestamp: iso(2000), message: { model: 'm', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x/index.html' } }] } },
  ]);
  escrever('b', CASA, [{ type: 'user', timestamp: iso(3000), message: { role: 'user', content: 'pergunta solta' } }]);
  s.registrar([], [], [], [], { modo: 'ps' });
  const salas = s.montarSalas(s.normalizarConfig({ projetos: [] }));
  const site = salas.find((x) => x.nome === 'meu-site');
  assert.ok(site, 'sala criada pela raiz do git, não pela subpasta src');
  assert.equal(site.tipo, 'auto');
  assert.equal(site.agentes[0].estado, 'trabalhando');
  assert.equal(site.agentes[0].atividade, 'lendo');
  assert.equal(site.agentes[0].alvo, 'index.html');
  assert.ok(site.agentes[0].persona);
  const recepcao = salas.find((x) => x.id === 'recepcao');
  assert.equal(recepcao.agentes[0].titulo, 'pergunta solta');
});

test('acesso: o próprio PC entra direto; túnel precisa de senha', () => {
  const req = (ip, host, extra = {}) => ({ socket: { remoteAddress: ip }, headers: { host, ...extra } });
  const semSenha = s.normalizarConfig({});
  const comSenha = s.normalizarConfig({ senha: 'x' });
  assert.equal(s.acesso(req('127.0.0.1', 'localhost:7777'), comSenha), 'livre');
  assert.equal(s.acesso(req('127.0.0.1', 'abc.trycloudflare.com', { 'cf-connecting-ip': '1.2.3.4' }), comSenha), 'senha');
  assert.equal(s.acesso(req('127.0.0.1', 'abc.trycloudflare.com', { 'cf-connecting-ip': '1.2.3.4' }), semSenha), 'recusar');
  assert.equal(s.acesso(req('192.168.0.9', '192.168.0.5:7777'), s.normalizarConfig({ acessoNaRede: true })), 'livre');
  const cookie = `outra=1; escritorio=${s.tokenDe('x')}`;
  assert.equal(s.acesso(req('127.0.0.1', 'abc.trycloudflare.com', { 'cf-ray': 'r', cookie }), comSenha), 'livre');
  assert.equal(s.lerCookie({ headers: { cookie } }, 'outra'), '1');
});

test('endereços liberados aceitam curinga', () => {
  const cfg = s.normalizarConfig({ enderecosPermitidos: ['*.trycloudflare.com', 'escritorio.c2a.com.br'] });
  const locais = new Set(['localhost:7777']);
  assert.equal(s.hostPermitido('abc.trycloudflare.com', 7777, locais, cfg), true);
  assert.equal(s.hostPermitido('escritorio.c2a.com.br', 7777, locais, cfg), true);
  assert.equal(s.hostPermitido('evil.com', 7777, locais, cfg), false);
  assert.equal(s.hostPermitido('trycloudflare.com.evil.com', 7777, locais, cfg), false);
});
