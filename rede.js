// Descobre os aparelhos ligados à rede local: tabela ARP, nome anunciado por mDNS e fabricante pelo MAC.
import dgram from 'node:dgram';
import fs from 'node:fs';
import { enderecosLocais, interfaceIgnorada, numero, paraTexto, consultarNomes } from './mdns.js';

const ARQ_OUI = '/usr/share/ieee-data/oui.txt';
const SUFIXO_EMPRESA = /[ ,]+(Electronics|Technologies|Technology|Broadband|Corporation|Corp|Co|Inc|Ltd|LLC|SAS|GmbH|S\.?A|Limited|Communications)\b.*$/i;
let fabricantes = null;

export function fabricanteDe(mac) {
  if (!mac) return null;
  if (!fabricantes) {
    fabricantes = new Map();
    try {
      for (const linha of fs.readFileSync(ARQ_OUI, 'utf8').split('\n')) {
        const m = /^([0-9A-F]{2})-([0-9A-F]{2})-([0-9A-F]{2})\s+\(hex\)\s+(.+)$/.exec(linha.trim());
        if (m) fabricantes.set(m[1] + m[2] + m[3], m[4].trim());
      }
    } catch {}
  }
  const nome = fabricantes.get(mac.replace(/:/g, '').slice(0, 6).toUpperCase());
  return nome?.replace(SUFIXO_EMPRESA, '').trim() || null;
}

// IP → MAC dos vizinhos com endereço resolvido, mais as interfaces desta máquina.
export function tabelaArp() {
  const tabela = new Map();
  try {
    for (const linha of fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1)) {
      const [ip, , flags, mac, , nomeInterface] = linha.trim().split(/\s+/);
      if (!ip || !(parseInt(flags, 16) & 2) || mac === '00:00:00:00:00:00' || interfaceIgnorada(nomeInterface)) continue;
      tabela.set(ip, mac.toLowerCase());
    }
  } catch {}
  for (const { address, mac } of enderecosLocais()) tabela.set(address, mac.toLowerCase());
  return tabela;
}

// Um pacote UDP vazio para cada endereço da rede faz o sistema perguntar o MAC de todos (ARP).
async function provocarArp() {
  const socket = dgram.createSocket('udp4');
  socket.on('error', () => {});
  await new Promise(resolve => socket.bind(0, resolve));
  const vazio = Buffer.alloc(0);
  for (const { address, netmask } of enderecosLocais()) {
    const rede = numero(address) & numero(netmask);
    const total = ~numero(netmask) >>> 0;
    if (total > 1024) continue;
    for (let i = 1; i < total; i++) {
      const ip = paraTexto((rede + i) >>> 0);
      if (ip !== address) socket.send(vazio, 9, ip, () => {});
    }
  }
  await new Promise(resolve => setTimeout(resolve, 3000));
  socket.close();
}

export async function descobrirDispositivos() {
  await provocarArp();
  const arp = tabelaArp();
  const nomes = await consultarNomes([...arp.keys()]);
  return [...arp].map(([ip, mac]) => ({ ip, mac, nomeRede: nomes.get(ip) || null, fabricante: fabricanteDe(mac) }));
}
