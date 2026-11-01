// mDNS: responde por <nome>.local com o IP desta máquina e pergunta aos aparelhos da rede o nome que eles anunciam.
import dgram from 'node:dgram';
import os from 'node:os';

const GRUPO = '224.0.0.251';
const PORTA = 5353;
const TTL = 120;
const IGNORAR = /^(lo|docker|br-|veth|virbr|lxd|tun|tap|wg)/;

export function enderecosLocais() {
  return Object.entries(os.networkInterfaces())
    .filter(([nome]) => !IGNORAR.test(nome))
    .flatMap(([nome, lista]) => lista.map(e => ({ ...e, interface: nome })))
    .filter(e => e.family === 'IPv4' && !e.internal);
}

export const interfaceIgnorada = nome => IGNORAR.test(nome);
export const numero = ip => ip.split('.').reduce((total, parte) => ((total << 8) | Number(parte)) >>> 0, 0);
export const paraTexto = n => [24, 16, 8, 0].map(d => (n >>> d) & 255).join('.');
const mesmaRede = (a, b, mascara) => ((numero(a) & numero(mascara)) >>> 0) === ((numero(b) & numero(mascara)) >>> 0);

function enderecoPara(origem) {
  const lista = enderecosLocais();
  return (lista.find(e => mesmaRede(e.address, origem, e.netmask)) || lista[0])?.address;
}

function lerNome(pacote, pos) {
  const partes = [];
  let fim = null;
  for (let saltos = 0; saltos < 64; saltos++) {
    const tamanho = pacote[pos];
    if (tamanho === undefined) throw new Error('pacote curto');
    if (tamanho === 0) return [partes.join('.'), fim ?? pos + 1];
    if ((tamanho & 0xc0) === 0xc0) {
      fim ??= pos + 2;
      pos = ((tamanho & 0x3f) << 8) | pacote[pos + 1];
      continue;
    }
    partes.push(pacote.toString('utf8', pos + 1, pos + 1 + tamanho));
    pos += tamanho + 1;
  }
  throw new Error('nome inválido');
}

function lerTextos(pacote, inicio, tamanho) {
  const textos = [];
  for (let pos = inicio; pos < inicio + tamanho; pos += pacote[pos] + 1) {
    textos.push(pacote.toString('utf8', pos + 1, pos + 1 + pacote[pos]));
  }
  return textos;
}

// Lê respostas, autoridades e adicionais: A (1), PTR (12), TXT (16) e SRV (33).
function lerRegistros(pacote) {
  let pos = 12;
  for (let i = 0; i < pacote.readUInt16BE(4); i++) pos = lerNome(pacote, pos)[1] + 4;
  const total = pacote.readUInt16BE(6) + pacote.readUInt16BE(8) + pacote.readUInt16BE(10);
  const registros = [];
  for (let i = 0; i < total; i++) {
    const [nome, depois] = lerNome(pacote, pos);
    const tipo = pacote.readUInt16BE(depois);
    const tamanho = pacote.readUInt16BE(depois + 8);
    const dados = depois + 10;
    const registro = { nome: nome.toLowerCase(), tipo };
    if (tipo === 1 && tamanho === 4) registro.ip = [...pacote.subarray(dados, dados + 4)].join('.');
    if (tipo === 12) registro.alvo = lerNome(pacote, dados)[0];
    if (tipo === 16) registro.textos = lerTextos(pacote, dados, tamanho);
    if (tipo === 33) registro.alvo = lerNome(pacote, dados + 6)[0];
    registros.push(registro);
    pos = dados + tamanho;
  }
  return registros;
}

function codificarNome(nome) {
  return Buffer.concat([
    ...nome.split('.').map(parte => Buffer.concat([Buffer.from([Buffer.byteLength(parte)]), Buffer.from(parte)])),
    Buffer.from([0]),
  ]);
}

function montarConsulta(perguntas) {
  const cabecalho = Buffer.alloc(12);
  cabecalho.writeUInt16BE(perguntas.length, 4);
  return Buffer.concat([
    cabecalho,
    ...perguntas.flatMap(({ nome, tipo }) => [codificarNome(nome), Buffer.from([tipo >> 8, tipo & 255, 0, 1])]),
  ]);
}

function montarResposta({ id = 0, nome, ip, ttl, cacheFlush, comPergunta }) {
  const cabecalho = Buffer.alloc(12);
  cabecalho.writeUInt16BE(id, 0);
  cabecalho.writeUInt16BE(0x8400, 2);
  cabecalho.writeUInt16BE(comPergunta ? 1 : 0, 4);
  cabecalho.writeUInt16BE(1, 6);
  const nomeCodificado = codificarNome(nome);
  const pergunta = comPergunta ? Buffer.concat([nomeCodificado, Buffer.from([0, 1, 0, 1])]) : Buffer.alloc(0);
  const registro = Buffer.alloc(10);
  registro.writeUInt16BE(1, 0);
  registro.writeUInt16BE(cacheFlush ? 0x8001 : 0x0001, 2);
  registro.writeUInt32BE(ttl, 4);
  registro.writeUInt16BE(4, 8);
  return Buffer.concat([cabecalho, pergunta, nomeCodificado, registro, Buffer.from(ip.split('.').map(Number))]);
}

// Envia a consulta de uma porta própria; os aparelhos respondem direto para ela.
function perguntar(perguntas, espera) {
  return new Promise(resolve => {
    const socket = dgram.createSocket('udp4');
    const registros = [];
    const concluir = () => {
      try { socket.close(); } catch {}
      resolve(registros);
    };
    socket.on('error', () => {});
    socket.on('message', pacote => {
      try {
        if (pacote.readUInt16BE(2) & 0x8000) registros.push(...lerRegistros(pacote));
      } catch {}
    });
    socket.bind(0, () => {
      const local = enderecosLocais()[0]?.address;
      if (local) socket.setMulticastInterface(local);
      socket.send(montarConsulta(perguntas), PORTA, GRUPO);
      setTimeout(concluir, espera);
    });
  });
}

const reverso = ip => `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
const SERVICOS = [
  '_companion-link._tcp.local',
  '_airplay._tcp.local',
  '_googlecast._tcp.local',
  '_amzn-wplay._tcp.local',
  '_ipp._tcp.local',
  '_printer._tcp.local',
  '_spotify-connect._tcp.local',
];
// Nomes de serviço que não identificam o aparelho (códigos ou o nome do próprio serviço).
const NOME_GENERICO = /^([0-9a-f-]{12,}|spotify ?connect)$/i;
// Nome de host padrão de sistema (ex.: Echo e Fire TV se chamam "linux"); nesses casos vale o fabricante.
const HOST_GENERICO = /^(linux|localhost|android|debian|ubuntu|raspberrypi|openwrt)$/i;

// Devolve IP → nome anunciado. O nome do serviço (ex.: "iPhone de Ana", "[TV] Samsung") tem prioridade
// sobre o nome de host (ex.: "Anas-iPhone"). iPhone, Mac, TVs, impressoras e Linux com Avahi respondem; Android não.
export async function consultarNomes(ips, espera = 2000) {
  const registros = await perguntar(
    [...SERVICOS.map(nome => ({ nome, tipo: 12 })), ...ips.map(ip => ({ nome: reverso(ip), tipo: 12 }))],
    espera,
  );
  const ipPorHost = new Map(registros.filter(r => r.ip).map(r => [r.nome, r.ip]));
  const hostPorInstancia = new Map(registros.filter(r => r.tipo === 33).map(r => [r.nome, r.alvo.toLowerCase()]));
  const apelidoPorInstancia = new Map(
    registros.filter(r => r.textos).map(r => [r.nome, r.textos.find(t => t.startsWith('fn='))?.slice(3)]),
  );
  const nomes = new Map();

  for (const servico of SERVICOS) {
    for (const r of registros) {
      if (r.tipo !== 12 || r.nome !== servico) continue;
      const instancia = r.alvo.toLowerCase();
      const ip = ipPorHost.get(hostPorInstancia.get(instancia));
      const nome = apelidoPorInstancia.get(instancia) || r.alvo.slice(0, -(servico.length + 1));
      if (ip && !nomes.has(ip) && nome && !NOME_GENERICO.test(nome)) nomes.set(ip, nome);
    }
  }
  for (const ip of ips) {
    if (nomes.has(ip)) continue;
    const host = registros.find(r => r.tipo === 12 && r.nome === reverso(ip))?.alvo;
    const nome = host?.replace(/\.local\.?$/i, '').replace(/-/g, ' ');
    if (nome && !HOST_GENERICO.test(nome)) nomes.set(ip, nome);
  }
  return nomes;
}

export function iniciarMdns(nomeHost) {
  const alvo = `${nomeHost}.local`.toLowerCase();
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const gruposEntrados = new Set();

  function entrarNosGrupos() {
    for (const { address } of enderecosLocais()) {
      if (gruposEntrados.has(address)) continue;
      try {
        socket.addMembership(GRUPO, address);
        gruposEntrados.add(address);
      } catch {}
    }
  }

  function anunciar() {
    for (const { address } of enderecosLocais()) {
      socket.setMulticastInterface(address);
      socket.send(montarResposta({ nome: alvo, ip: address, ttl: TTL, cacheFlush: true }), PORTA, GRUPO);
    }
  }

  socket.on('message', (pacote, origem) => {
    try {
      if (pacote.length < 12 || pacote.readUInt16BE(2) & 0x8000) return;
      let pos = 12;
      for (let i = 0; i < pacote.readUInt16BE(4); i++) {
        const [nome, depois] = lerNome(pacote, pos);
        const tipo = pacote.readUInt16BE(depois);
        pos = depois + 4;
        if (nome.toLowerCase() !== alvo || (tipo !== 1 && tipo !== 255)) continue;
        const ip = enderecoPara(origem.address);
        if (!ip) return;
        if (origem.port !== PORTA) {
          // Consulta comum de DNS enviada à porta 5353 (ex.: dig): a resposta volta direto para quem perguntou.
          const resposta = montarResposta({ id: pacote.readUInt16BE(0), nome: alvo, ip, ttl: 10, cacheFlush: false, comPergunta: true });
          socket.send(resposta, origem.port, origem.address);
        } else {
          socket.setMulticastInterface(ip);
          socket.send(montarResposta({ nome: alvo, ip, ttl: TTL, cacheFlush: true }), PORTA, GRUPO);
        }
        return;
      }
    } catch {}
  });

  socket.on('error', erro => console.error('mDNS:', erro.message));
  socket.bind(PORTA, () => {
    socket.setMulticastTTL(255);
    entrarNosGrupos();
    anunciar();
    setTimeout(anunciar, 1000);
    // Se o Wi-Fi reconectar, a máquina precisa entrar de novo no grupo multicast.
    setInterval(entrarNosGrupos, 30000);
  });
}
