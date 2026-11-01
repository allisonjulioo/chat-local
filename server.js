// Servidor do chat da rede local: página, eventos (SSE), mensagens e arquivos.
// Cada participante é um aparelho da rede, identificado pelo MAC; quem não abriu o chat recebe ao abrir.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { iniciarMdns, enderecosLocais } from './mdns.js';
import { descobrirDispositivos, tabelaArp, fabricanteDe } from './rede.js';

const PORTA = Number(process.env.PORTA || 80);
const NOME_HOST = process.env.NOME_HOST || 'chat';
const RAIZ = path.dirname(new URL(import.meta.url).pathname);
const PUBLICO = path.join(RAIZ, 'publico');
const DADOS = path.join(RAIZ, 'dados');
const ARQUIVOS = path.join(DADOS, 'arquivos');
const ARQ_MENSAGENS = path.join(DADOS, 'mensagens.jsonl');
const ARQ_DISPOSITIVOS = path.join(DADOS, 'dispositivos.json');
const NA_REDE_POR = 5 * 60 * 1000;

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};
// Tipos que o navegador pode abrir direto; o resto é sempre baixado.
const ABRE_NO_NAVEGADOR = /^(image\/(png|jpeg|gif|webp|heic|heif|avif)|video\/|audio\/|application\/pdf$|text\/plain$)/;

let dispositivos = new Map();
let mensagens = [];
let arquivosPorId = new Map();
const conexoes = new Map();

function carregarDados() {
  fs.mkdirSync(ARQUIVOS, { recursive: true });
  try {
    dispositivos = new Map(JSON.parse(fs.readFileSync(ARQ_DISPOSITIVOS, 'utf8')).map(d => [d.id, d]));
  } catch {}
  if (fs.existsSync(ARQ_MENSAGENS)) {
    for (const linha of fs.readFileSync(ARQ_MENSAGENS, 'utf8').split('\n')) {
      if (!linha) continue;
      try { mensagens.push(JSON.parse(linha)); } catch {}
    }
  }
  arquivosPorId = new Map(mensagens.filter(m => m.arquivo).map(m => [m.arquivo.id, m.arquivo]));
}

function salvarDispositivos() {
  fs.writeFileSync(ARQ_DISPOSITIVOS, JSON.stringify([...dispositivos.values()], null, 1));
}

const novoId = () => crypto.randomBytes(16).toString('hex');
const ipDe = req => (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const limparNome = nome => String(nome || '').trim().replace(/\s+/g, ' ').slice(0, 40);
const visivel = (m, id) => m.para === null || m.de === id || m.para === id;

function tipoDe(ua = '') {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android' : 'Tablet Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux/.test(ua)) return 'Linux';
  return null;
}

// Modelo só aparece no navegador de alguns Android; o Chrome atual envia "K" no lugar.
function modeloDe(ua = '') {
  const modelo = /Android [\d.]+; ([^;)]+)/.exec(ua)?.[1]?.trim();
  return modelo && !/^(K|Mobile|wv)$/.test(modelo) ? limparNome(modelo) : null;
}

const nomeDe = d => d.nomeProprio || d.nomeRede || d.modelo || d.fabricante || d.tipo || 'Dispositivo sem nome';

function listaDispositivos() {
  return [...dispositivos.values()].map(d => ({
    id: d.id,
    nome: nomeDe(d),
    tipo: d.tipo || null,
    ip: d.ip,
    chatAberto: conexoes.has(d.id),
    naRede: conexoes.has(d.id) || Date.now() - (d.vistoEm || 0) < NA_REDE_POR,
  }));
}

// Identifica o aparelho pelo MAC do IP que fez a requisição.
function dispositivoDe(req) {
  let ip = ipDe(req);
  if (ip === '127.0.0.1' || ip === '::1') ip = enderecosLocais()[0]?.address || ip;
  const mac = tabelaArp().get(ip);
  const id = mac || `ip-${ip}`;
  let d = dispositivos.get(id);
  if (!d) {
    d = { id, fabricante: fabricanteDe(mac) };
    dispositivos.set(id, d);
    descobrir();
  }
  Object.assign(d, { ip, vistoEm: Date.now() });
  return d;
}

let descobrindo = null;
function descobrir() {
  descobrindo ??= descobrirDispositivos()
    .then(encontrados => {
      for (const { ip, mac, nomeRede, fabricante } of encontrados) {
        const d = dispositivos.get(mac) || { id: mac };
        Object.assign(d, { ip, fabricante, vistoEm: Date.now() });
        // Celular com a tela apagada às vezes não responde; mantém o último nome conhecido.
        if (nomeRede) d.nomeRede = nomeRede;
        dispositivos.set(mac, d);
      }
      salvarDispositivos();
      avisarTodos('dispositivos', listaDispositivos());
    })
    .catch(erro => console.error('Descoberta da rede falhou:', erro.message))
    .finally(() => { descobrindo = null; });
}

function enviarEvento(res, evento, dados) {
  res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
}

function avisarTodos(evento, dados) {
  for (const lista of conexoes.values()) for (const res of lista) enviarEvento(res, evento, dados);
}

function publicar(m) {
  mensagens.push(m);
  if (m.arquivo) arquivosPorId.set(m.arquivo.id, m.arquivo);
  fs.appendFileSync(ARQ_MENSAGENS, JSON.stringify(m) + '\n');
  const destinos = m.para === null ? [...conexoes.keys()] : [...new Set([m.de, m.para])];
  for (const id of destinos) for (const res of conexoes.get(id) || []) enviarEvento(res, 'mensagem', m);
}

function responder(res, status, corpo) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(corpo));
}

async function lerJsonCorpo(req, limite) {
  let tamanho = 0;
  const partes = [];
  for await (const parte of req) {
    tamanho += parte.length;
    if (tamanho > limite) throw new Error('corpo grande demais');
    partes.push(parte);
  }
  return JSON.parse(Buffer.concat(partes).toString('utf8'));
}

function abrirEventos(req, res) {
  const d = dispositivoDe(req);
  const ua = req.headers['user-agent'];
  d.tipo = tipoDe(ua) || d.tipo;
  d.modelo = modeloDe(ua) || d.modelo;
  salvarDispositivos();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  if (!conexoes.has(d.id)) conexoes.set(d.id, new Set());
  conexoes.get(d.id).add(res);

  enviarEvento(res, 'inicio', { eu: d.id, dispositivos: listaDispositivos(), mensagens: mensagens.filter(m => visivel(m, d.id)) });
  avisarTodos('dispositivos', listaDispositivos());

  req.on('close', () => {
    const lista = conexoes.get(d.id);
    lista.delete(res);
    if (lista.size) return;
    conexoes.delete(d.id);
    d.vistoEm = Date.now();
    salvarDispositivos();
    avisarTodos('dispositivos', listaDispositivos());
  });
}

async function receberMensagem(req, res) {
  let corpo;
  try { corpo = await lerJsonCorpo(req, 64 * 1024); } catch { return responder(res, 400, { erro: 'corpo inválido' }); }
  const { para = null, texto } = corpo;
  if (para !== null && !dispositivos.has(para)) return responder(res, 400, { erro: 'destinatário inválido' });
  if (typeof texto !== 'string' || !texto.trim() || texto.length > 10000) return responder(res, 400, { erro: 'texto inválido' });
  publicar({ id: novoId(), de: dispositivoDe(req).id, para, tipo: 'texto', texto: texto.trim(), em: Date.now() });
  responder(res, 201, { ok: true });
}

async function receberArquivo(req, res, url) {
  const para = url.searchParams.get('para') || null;
  if (para !== null && !dispositivos.has(para)) return responder(res, 400, { erro: 'destinatário inválido' });
  const de = dispositivoDe(req).id;

  let nome = '';
  try { nome = decodeURIComponent(req.headers['x-nome'] || ''); } catch {}
  nome = path.basename(nome).slice(0, 200) || 'arquivo';
  const tipo = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().slice(0, 100);
  const id = novoId();
  const destino = path.join(ARQUIVOS, id);

  try {
    await pipeline(req, fs.createWriteStream(destino));
  } catch {
    fs.rmSync(destino, { force: true });
    return;
  }
  const { size: tamanho } = fs.statSync(destino);
  publicar({ id: novoId(), de, para, tipo: 'arquivo', arquivo: { id, nome, tamanho, tipo }, em: Date.now() });
  responder(res, 201, { ok: true });
}

async function alterarNome(req, res) {
  let corpo;
  try { corpo = await lerJsonCorpo(req, 4096); } catch { return responder(res, 400, { erro: 'corpo inválido' }); }
  const d = dispositivoDe(req);
  // Nome vazio volta para o nome que o aparelho anuncia na rede.
  const nome = limparNome(corpo.nome);
  if (nome) d.nomeProprio = nome;
  else delete d.nomeProprio;
  salvarDispositivos();
  avisarTodos('dispositivos', listaDispositivos());
  responder(res, 200, { ok: true });
}

function servirArquivo(req, res, id, url) {
  const arquivo = arquivosPorId.get(id);
  if (!arquivo) return responder(res, 404, { erro: 'arquivo não encontrado' });
  const caminho = path.join(ARQUIVOS, id);
  const { tamanho } = arquivo;
  const abrir = !url.searchParams.has('baixar') && ABRE_NO_NAVEGADOR.test(arquivo.tipo);
  const cabecalhos = {
    'Content-Type': arquivo.tipo,
    'Content-Disposition': `${abrir ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(arquivo.nome)}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  };

  // Safari só reproduz vídeo quando o servidor aceita pedidos por intervalo de bytes.
  const intervalo = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (intervalo && (intervalo[1] || intervalo[2])) {
    const inicio = intervalo[1] ? Number(intervalo[1]) : Math.max(0, tamanho - Number(intervalo[2]));
    const fim = intervalo[1] && intervalo[2] ? Math.min(Number(intervalo[2]), tamanho - 1) : tamanho - 1;
    if (inicio > fim || inicio >= tamanho) {
      res.writeHead(416, { 'Content-Range': `bytes */${tamanho}` });
      return res.end();
    }
    res.writeHead(206, { ...cabecalhos, 'Content-Range': `bytes ${inicio}-${fim}/${tamanho}`, 'Content-Length': fim - inicio + 1 });
    return fs.createReadStream(caminho, { start: inicio, end: fim }).pipe(res);
  }
  res.writeHead(200, { ...cabecalhos, 'Content-Length': tamanho });
  fs.createReadStream(caminho).pipe(res);
}

function servirPublico(res, caminhoUrl) {
  const nome = caminhoUrl === '/' ? 'index.html' : caminhoUrl.slice(1);
  if (!/^[\w.-]+$/.test(nome)) return responder(res, 404, { erro: 'não encontrado' });
  const caminho = path.join(PUBLICO, nome);
  if (!fs.existsSync(caminho)) return responder(res, 404, { erro: 'não encontrado' });
  res.writeHead(200, {
    'Content-Type': TIPOS[path.extname(nome)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(caminho).pipe(res);
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    if (req.method === 'GET' && url.pathname === '/eventos') return abrirEventos(req, res);
    if (req.method === 'POST' && url.pathname === '/mensagens') return await receberMensagem(req, res);
    if (req.method === 'POST' && url.pathname === '/arquivos') return await receberArquivo(req, res, url);
    if (req.method === 'POST' && url.pathname === '/nome') return await alterarNome(req, res);
    const arquivo = /^\/arquivos\/([a-f0-9]{32})$/.exec(url.pathname);
    if (req.method === 'GET' && arquivo) return servirArquivo(req, res, arquivo[1], url);
    if (req.method === 'GET') return servirPublico(res, url.pathname);
    responder(res, 404, { erro: 'não encontrado' });
  } catch (erro) {
    console.error(erro);
    if (!res.headersSent) responder(res, 500, { erro: 'falha interna' });
  }
});
// Envio de arquivo grande pelo Wi-Fi pode passar do limite padrão de 5 minutos.
servidor.requestTimeout = 0;

// Mantém as conexões de eventos abertas em roteadores e celulares que fecham conexão parada.
setInterval(() => {
  for (const lista of conexoes.values()) for (const res of lista) res.write(': ping\n\n');
}, 20000);

servidor.listen(PORTA, () => {
  // A porta 80 exige root; depois de abrir a porta o processo passa a rodar como o usuário dono dos arquivos.
  const uid = Number(process.env.UID_USUARIO);
  if (process.getuid?.() === 0 && uid) {
    process.setgid(Number(process.env.GID_USUARIO || uid));
    process.setuid(uid);
  }
  carregarDados();
  iniciarMdns(NOME_HOST);
  descobrir();
  setInterval(descobrir, 60 * 1000);
  console.log(`Chat publicado em http://${NOME_HOST}.local${PORTA === 80 ? '' : `:${PORTA}`}`);
});
