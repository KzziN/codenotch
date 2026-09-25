# Escritório

Um escritório em pixel art onde cada projeto tem a sua sala. Olhando de cima dá
para ver, sala por sala:

- **se o app está no ar**: o servidor (rack) no canto acende verde quando o app
  responde e vermelho quando está rodando com erro;
- **quantos CMDs estão abertos**: cada CMD, PowerShell ou terminal vira um
  quadrinho no telão da parede;
- **quais agentes estão trabalhando**: cada agente de IA (Claude Code, Claude
  Desktop, Codex…) é um robô sentado numa mesa, com o nome no crachá. O balão em
  cima da cabeça diz o que ele está fazendo: `…` trabalhando, `?` esperando
  você, `!` erro (ou limite de uso), `✓` terminou;
- **onde você está**: se o projeto está aberto no VS Code (ou Cursor, Android
  Studio…), você aparece na primeira mesa.

A luz da sala acende quando tem alguém lá dentro ou um CMD aberto. A lâmpada em
cima da porta pisca amarelo ou vermelho quando a sala precisa de você.

Clique numa sala para ver tudo com detalhe: endereço e portas do app, cada CMD
(com o que está rodando dentro), cada agente com o que você pediu e a última
resposta, e os processos.

## Ligar

Precisa do [Node.js](https://nodejs.org) (versão 18 ou mais nova). Não tem
`npm install`.

1. Copie esta pasta `escritorio` para o PC.
2. Dê dois cliques em `iniciar-escritorio.bat`.
3. O navegador abre em <http://localhost:7777>. Deixe a janela preta aberta:
   fechando ela, o Escritório para.

Para abrir junto com o Windows: aperte `Win + R`, digite `shell:startup`,
e crie ali um atalho para o `iniciar-escritorio.bat` (nas propriedades do
atalho, em **Executar**, escolha **Minimizada**).

## Os projetos

Não precisa cadastrar nada para começar. Toda pasta em que você já conversou com
o Claude Code ou com o Codex nos últimos 14 dias vira uma sala sozinha (aparece
com a marca **nova**). Pastas abertas no VS Code com a extensão do Claude Code
também.

O `projetos.json` já vem com os projetos das nossas conversas (Totem, NDD, KPAX,
Easy Inventory, Raspberry, Meet C2A, Lexmark, IA de Imagens, Cloudflare,
Codenotch, Corpo Humano 3D). Cada um é reconhecido pelas **palavras** no caminho
da pasta: uma pasta `C:\Projetos\totem-faculdade` cai na sala do Totem por causa
da palavra `totem`. Ajuste à vontade; o Escritório relê o arquivo sozinho,
sem precisar reiniciar.

| Campo | Para que serve |
|---|---|
| `nome` | O nome na placa da sala. |
| `descricao` | Uma linha sobre o projeto (aparece no detalhe). |
| `palavras` | Palavras que aparecem no caminho da pasta, na linha de comando ou no título da janela. |
| `pastas` | O caminho exato, se preferir: `["C:\\Projetos\\totem"]`. Pode usar `%USERPROFILE%` ou `~`. |
| `url` | Endereço que o Escritório testa a cada 10 s para saber se o app está no ar. Ex.: `"http://localhost:5173"`. |
| `porta` | Sem `url`, basta a porta: `3000` ou `[3000, 3001]`. |
| `processos` | Programas que, rodando, significam que o app está no ar. Ex.: `["cloudflared"]`. |
| `servicos` | Serviços do Windows do projeto. Ex.: `["MySQL80"]` (aceita `*`). |
| `icone` | `totem`, `impressora`, `notebook`, `raspberry`, `camera`, `imagem`, `nuvem`, `notch`, `corpo`, `pasta`, `codigo`. |
| `cor` | Cor da sala, como `"#4fb3ff"`. |
| `oculto` | `true` esconde a sala. |

Configurações gerais no topo do arquivo:

| Campo | Padrão | O que faz |
|---|---|---|
| `titulo` | `Escritório do KzziN` | O nome no alto da página. |
| `porta` | `7777` | Porta do próprio Escritório. |
| `descobrirProjetos` | `true` | Cria salas sozinho para as pastas dos agentes. |
| `minutosAgenteParado` | `45` | Por quanto tempo um agente que terminou continua sentado na mesa. |
| `diasDeHistorico` | `14` | Até quantos dias atrás olhar as conversas. |
| `lerPastaDosCmds` | `false` | Veja abaixo. |
| `acessoNaRede` | `false` | Veja abaixo. |

### De qual projeto é cada CMD?

O Windows não conta em que pasta cada CMD está. Sem ajuda, o Escritório liga o
CMD ao projeto pelo título da janela, pelo que está rodando dentro dele (por
exemplo `node C:\Projetos\totem\...`) ou pelo agente aberto nele. O que não
dá para descobrir fica na **Recepção**.

Com `"lerPastaDosCmds": true`, o coletor lê a pasta atual de cada CMD,
PowerShell, node e python, e acerta quase sempre. Fica desligado de fábrica
porque, para isso, ele lê um pedacinho da memória desses programas, e antivírus
de empresa às vezes desconfiam de script fazendo isso. Se o seu PC é gerenciado
pela TI, combine com eles antes de ligar.

### Ver do celular

Com `"acessoNaRede": true` (ou rodando `node servidor.js --rede`), o Escritório
também responde na rede local, e a janela mostra o endereço
(`http://192.168.x.x:7777`). Só ligue em rede confiável: a página mostra
nomes de pastas e linhas de comando (senhas e tokens nelas são escondidos com
`***`).

## O que ele lê (e o que não faz)

Só leitura, tudo local, nada sai do PC:

- a lista de processos, janelas abertas, portas em uso e serviços, pelo
  PowerShell (`coletor.ps1`, que você pode abrir e ler);
- as conversas do Claude Code (`%USERPROFILE%\.claude\projects`), do Claude
  Desktop e do Codex (`%USERPROFILE%\.codex\sessions`), só para saber o estado,
  o título e a sua última mensagem;
- os arquivos `%USERPROFILE%\.claude\ide\*.lock`, para saber que pastas o VS
  Code tem abertas. Eles também guardam um token, que o Escritório ignora.

Ele não abre, fecha nem altera nada nos seus projetos.

Os estados dos agentes são deduzidos das conversas: **esperando você** quer
dizer que o agente parou há mais de 20 s no meio de um comando, o que quase
sempre é um pedido de permissão (mas pode ser um comando demorado).

## Problemas

- **A página diz DEMONSTRAÇÃO**: ela foi aberta direto do arquivo ou sem o
  servidor. Abra pelo `iniciar-escritorio.bat` e use o endereço
  <http://localhost:7777>.
- **Aviso "estou usando o tasklist"**: a política do Windows não deixou o
  PowerShell rodar o `coletor.ps1`. Os CMDs e portas ainda aparecem, mas sem
  saber o projeto de cada um.
- **"A porta 7777 já está em uso"**: o Escritório já está aberto. Se não
  estiver, troque `"porta"` no `projetos.json`.
- **Uma sala não aparece**: confira as `palavras` ou coloque o caminho em
  `pastas`. Para testar sem abrir o navegador: `node servidor.js --json`.
