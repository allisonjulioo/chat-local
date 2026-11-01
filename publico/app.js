const $ = seletor => document.querySelector(seletor);
const GRUPO = 'grupo';
const TELA_LARGA = matchMedia('(min-width: 760px)');
const TOQUE = matchMedia('(pointer: coarse)');

// O servidor identifica este aparelho pelo MAC; "eu" chega no evento de início.
const estado = {
  eu: null,
  lidoEm: lerLocal('lidoEm') || {},
  dispositivos: new Map(),
  mensagens: [],
  atual: GRUPO,
  fonte: null,
  noFim: true,
};

function lerLocal(chave) {
  try { return JSON.parse(localStorage.getItem(chave)); } catch { return null; }
}
function gravarLocal(chave, valor) {
  try { localStorage.setItem(chave, JSON.stringify(valor)); } catch {}
}

function criar(tag, classe, texto) {
  const el = document.createElement(tag);
  if (classe) el.className = classe;
  if (texto !== undefined) el.textContent = texto;
  return el;
}

let temporizadorAviso;
function avisar(texto, segundos) {
  clearTimeout(temporizadorAviso);
  $('#aviso').textContent = texto;
  $('#aviso').hidden = !texto;
  if (texto && segundos) temporizadorAviso = setTimeout(() => avisar(''), segundos * 1000);
}

const chaveDe = m => (m.para === null ? GRUPO : m.de === estado.eu ? m.para : m.de);
const nomeDe = id => estado.dispositivos.get(id)?.nome || 'Desconhecido';
const conversaVisivel = () => document.visibilityState === 'visible' && (TELA_LARGA.matches || document.body.classList.contains('na-conversa'));
const chatsAbertos = () => [...estado.dispositivos.values()].filter(d => d.chatAberto).length;
const situacao = d => (d.chatAberto ? 'chat aberto' : d.naRede ? 'chat fechado' : 'fora da rede');
const detalhe = (d, ...extra) => [d.tipo !== d.nome && d.tipo, d.ip, ...extra].filter(Boolean).join(' · ');

function hora(em) {
  const data = new Date(em);
  const texto = data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (data.toDateString() === new Date().toDateString()) return texto;
  return `${data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${texto}`;
}

function tamanho(bytes) {
  const unidades = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < unidades.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toLocaleString('pt-BR', { maximumFractionDigits: i ? 1 : 0 })} ${unidades[i]}`;
}

// Conexão

function conectar() {
  estado.fonte?.close();
  const fonte = new EventSource('/eventos');
  estado.fonte = fonte;

  fonte.addEventListener('open', () => avisar(''));
  fonte.addEventListener('error', () => {
    avisar('Sem conexão com o servidor. Tentando reconectar.');
    if (fonte.readyState === EventSource.CLOSED) setTimeout(() => estado.fonte === fonte && conectar(), 3000);
  });
  fonte.addEventListener('inicio', evento => {
    const dados = JSON.parse(evento.data);
    estado.eu = dados.eu;
    estado.dispositivos = new Map(dados.dispositivos.map(d => [d.id, d]));
    estado.mensagens = dados.mensagens;
    if (estado.atual !== GRUPO && !estado.dispositivos.has(estado.atual)) estado.atual = GRUPO;
    desenharConversa();
    desenharLista();
  });
  fonte.addEventListener('dispositivos', evento => {
    estado.dispositivos = new Map(JSON.parse(evento.data).map(d => [d.id, d]));
    desenharLista();
    desenharTopo();
  });
  fonte.addEventListener('mensagem', evento => {
    const m = JSON.parse(evento.data);
    estado.mensagens.push(m);
    if (chaveDe(m) === estado.atual) adicionarMensagem(m);
    marcarLida();
    desenharLista();
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !estado.eu) return;
  if (estado.fonte?.readyState === EventSource.CLOSED) conectar();
  marcarLida();
  desenharLista();
});

// Lista de conversas

function contarNaoLidas() {
  const contagem = new Map();
  for (const m of estado.mensagens) {
    if (m.de === estado.eu) continue;
    const chave = chaveDe(m);
    if (m.em > (estado.lidoEm[chave] || 0)) contagem.set(chave, (contagem.get(chave) || 0) + 1);
  }
  return contagem;
}

function marcarLida() {
  if (!conversaVisivel()) return;
  // filter().pop() em vez de findLast: o Chrome de celulares Android antigos não tem findLast.
  const ultima = estado.mensagens.filter(m => chaveDe(m) === estado.atual).pop();
  if (!ultima || ultima.em <= (estado.lidoEm[estado.atual] || 0)) return;
  estado.lidoEm[estado.atual] = ultima.em;
  gravarLocal('lidoEm', estado.lidoEm);
}

function desenharLista() {
  const contagem = contarNaoLidas();
  const outros = [...estado.dispositivos.values()]
    .filter(d => d.id !== estado.eu)
    .sort((a, b) => b.chatAberto - a.chatAberto || b.naRede - a.naRede || a.nome.localeCompare(b.nome, 'pt-BR'));

  const itens = [
    { chave: GRUPO, nome: 'Grupo', detalhe: `${chatsAbertos()} com o chat aberto` },
    ...outros.map(d => ({
      chave: d.id,
      nome: d.nome,
      detalhe: detalhe(d),
      classe: d.chatAberto ? 'aberto' : d.naRede ? '' : 'fora',
    })),
  ];

  $('#conversas').replaceChildren(...itens.map(item => {
    const botao = criar('button', 'item');
    botao.classList.toggle('ativo', item.chave === estado.atual);
    if (item.classe) botao.classList.add(item.classe);
    const textos = criar('span', 'textos');
    textos.append(criar('span', 'nome', item.nome), criar('span', 'detalhe', item.detalhe));
    botao.append(criar('span', 'ponto'), textos);
    const naoLidas = contagem.get(item.chave);
    if (naoLidas) botao.append(criar('span', 'contador', naoLidas));
    botao.addEventListener('click', () => abrir(item.chave));
    return botao;
  }));

  $('#alterar-nome').textContent = `${nomeDe(estado.eu)} · alterar nome`;
  const total = [...contagem.values()].reduce((a, b) => a + b, 0);
  document.title = total ? `(${total}) Chat` : 'Chat';
}

function abrir(chave) {
  estado.atual = chave;
  document.body.classList.add('na-conversa');
  desenharConversa();
  desenharLista();
  if (!TOQUE.matches) campoTexto.focus();
}

$('#voltar').addEventListener('click', () => {
  document.body.classList.remove('na-conversa');
  desenharLista();
});

// Nome deste aparelho: vazio volta para o nome automático.

function fecharNome() {
  $('#form-nome').hidden = true;
  $('#alterar-nome').hidden = false;
}

$('#alterar-nome').addEventListener('click', () => {
  $('#alterar-nome').hidden = true;
  $('#form-nome').hidden = false;
  $('#campo-nome').value = nomeDe(estado.eu);
  $('#campo-nome').select();
});
$('#campo-nome').addEventListener('keydown', evento => evento.key === 'Escape' && fecharNome());
$('#campo-nome').addEventListener('blur', fecharNome);
$('#form-nome').addEventListener('submit', async evento => {
  evento.preventDefault();
  const nome = $('#campo-nome').value.trim();
  fecharNome();
  if (nome === nomeDe(estado.eu)) return;
  try {
    const resposta = await fetch('/nome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome }),
    });
    if (!resposta.ok) throw new Error(resposta.status);
  } catch {
    avisar('Falha ao alterar o nome.', 6);
  }
});

// Conversa

function desenharTopo() {
  if (estado.atual === GRUPO) {
    $('#titulo').textContent = 'Grupo';
    $('#subtitulo').textContent = `${chatsAbertos()} com o chat aberto`;
    return;
  }
  const d = estado.dispositivos.get(estado.atual);
  $('#titulo').textContent = d?.nome || '';
  $('#subtitulo').textContent = d ? detalhe(d, situacao(d)) : '';
}

function desenharConversa() {
  desenharTopo();
  const lista = estado.mensagens.filter(m => chaveDe(m) === estado.atual);
  $('#mensagens').replaceChildren(...lista.map((m, i) => elementoMensagem(m, lista[i - 1])));
  irParaFim();
  marcarLida();
}

function adicionarMensagem(m) {
  const caixa = $('#mensagens');
  const anterior = caixa.lastElementChild;
  caixa.append(elementoMensagem(m, anterior && { de: anterior.dataset.de }));
  if (estado.noFim || m.de === estado.eu) irParaFim();
}

function irParaFim() {
  const caixa = $('#mensagens');
  caixa.scrollTop = caixa.scrollHeight;
  estado.noFim = true;
}

$('#mensagens').addEventListener('scroll', () => {
  const caixa = $('#mensagens');
  estado.noFim = caixa.scrollHeight - caixa.scrollTop - caixa.clientHeight < 80;
});

function textoComLinks(texto) {
  return texto.split(/(https?:\/\/\S+)/g).map((parte, i) => {
    if (i % 2 === 0) return document.createTextNode(parte);
    const link = criar('a', '', parte);
    link.href = parte;
    link.target = '_blank';
    link.rel = 'noopener';
    return link;
  });
}

function elementoArquivo(arquivo) {
  const endereco = `/arquivos/${arquivo.id}`;
  const caixa = criar('div', 'arquivo');
  const manterNoFim = () => estado.noFim && irParaFim();

  if (arquivo.tipo.startsWith('image/')) {
    const link = criar('a');
    link.href = endereco;
    link.target = '_blank';
    const imagem = criar('img');
    imagem.src = endereco;
    imagem.alt = arquivo.nome;
    imagem.addEventListener('load', manterNoFim);
    imagem.addEventListener('error', () => link.remove());
    link.append(imagem);
    caixa.append(link);
  } else if (arquivo.tipo.startsWith('video/')) {
    const video = criar('video');
    video.src = endereco;
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.addEventListener('loadedmetadata', manterNoFim);
    caixa.append(video);
  } else if (arquivo.tipo.startsWith('audio/')) {
    const audio = criar('audio');
    audio.src = endereco;
    audio.controls = true;
    audio.preload = 'metadata';
    caixa.append(audio);
  }

  const linha = criar('div', 'arquivo-linha');
  const baixar = criar('a', 'baixar', 'Baixar');
  baixar.href = `${endereco}?baixar=1`;
  baixar.download = arquivo.nome;
  linha.append(criar('span', 'arquivo-nome', arquivo.nome), criar('span', 'arquivo-tamanho', tamanho(arquivo.tamanho)), baixar);
  caixa.append(linha);
  return caixa;
}

function elementoMensagem(m, anterior) {
  const minha = m.de === estado.eu;
  const el = criar('div', minha ? 'mensagem minha' : 'mensagem');
  el.dataset.de = m.de;
  if (!minha && m.para === null && anterior?.de !== m.de) el.append(criar('div', 'autor', nomeDe(m.de)));

  const bolha = criar('div', 'bolha');
  if (m.tipo === 'arquivo') {
    bolha.classList.add('com-arquivo');
    bolha.append(elementoArquivo(m.arquivo));
  } else {
    bolha.append(...textoComLinks(m.texto));
  }
  bolha.append(criar('time', 'hora', hora(m.em)));
  el.append(bolha);
  return el;
}

// Envio de texto

const campoTexto = $('#campo-texto');

function ajustarAltura() {
  campoTexto.style.height = 'auto';
  campoTexto.style.height = `${Math.min(campoTexto.scrollHeight, 160)}px`;
  campoTexto.style.overflowY = campoTexto.scrollHeight > 160 ? 'auto' : 'hidden';
}
campoTexto.addEventListener('input', ajustarAltura);

campoTexto.addEventListener('keydown', evento => {
  if (evento.key === 'Enter' && !evento.shiftKey && !evento.isComposing && !TOQUE.matches) {
    evento.preventDefault();
    $('#form-mensagem').requestSubmit();
  }
});

$('#form-mensagem').addEventListener('submit', async evento => {
  evento.preventDefault();
  const texto = campoTexto.value.trim();
  if (!texto) return;
  campoTexto.value = '';
  ajustarAltura();
  try {
    const resposta = await fetch('/mensagens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ para: estado.atual === GRUPO ? null : estado.atual, texto }),
    });
    if (!resposta.ok) throw new Error(resposta.status);
  } catch {
    if (!campoTexto.value) campoTexto.value = texto;
    ajustarAltura();
    avisar('Falha ao enviar a mensagem. Verifique a conexão com a rede.', 6);
  }
});

// Envio de arquivos

function enviarArquivo(arquivo) {
  const para = estado.atual === GRUPO ? '' : encodeURIComponent(estado.atual);
  const item = criar('div', 'envio');
  const barra = criar('progress');
  barra.max = 1;
  barra.value = 0;
  const porcentagem = criar('span', 'envio-pct', '0%');
  item.append(criar('span', 'envio-nome', arquivo.name), barra, porcentagem);
  $('#envios').append(item);

  const pedido = new XMLHttpRequest();
  pedido.open('POST', `/arquivos?para=${para}`);
  pedido.setRequestHeader('X-Nome', encodeURIComponent(arquivo.name));
  pedido.setRequestHeader('Content-Type', arquivo.type || 'application/octet-stream');
  pedido.upload.addEventListener('progress', evento => {
    if (!evento.lengthComputable) return;
    barra.value = evento.loaded / evento.total;
    porcentagem.textContent = `${Math.floor((100 * evento.loaded) / evento.total)}%`;
  });
  pedido.addEventListener('load', () => {
    item.remove();
    if (pedido.status >= 300) avisar(`Falha ao enviar ${arquivo.name}.`, 6);
  });
  pedido.addEventListener('error', () => {
    item.remove();
    avisar(`Falha ao enviar ${arquivo.name}. Verifique a conexão com a rede.`, 6);
  });
  pedido.send(arquivo);
}

const enviarArquivos = arquivos => [...arquivos].forEach(enviarArquivo);

$('#campo-arquivo').addEventListener('change', evento => {
  enviarArquivos(evento.target.files);
  evento.target.value = '';
});

campoTexto.addEventListener('paste', evento => {
  if (!evento.clipboardData?.files.length) return;
  evento.preventDefault();
  enviarArquivos(evento.clipboardData.files);
});

const conversa = $('#conversa');
conversa.addEventListener('dragover', evento => {
  if (!evento.dataTransfer.types.includes('Files')) return;
  evento.preventDefault();
  conversa.classList.add('soltando');
});
conversa.addEventListener('dragleave', evento => {
  if (!conversa.contains(evento.relatedTarget)) conversa.classList.remove('soltando');
});
conversa.addEventListener('drop', evento => {
  evento.preventDefault();
  conversa.classList.remove('soltando');
  enviarArquivos(evento.dataTransfer.files);
});

conectar();
