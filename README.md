# Chat Local

Chat pelo Wi-Fi entre todos os aparelhos da rede local, sem conta e sem internet. Um computador da rede roda o servidor e publica o chat em `http://chat.local`. Cada aparelho que abre o endereço no navegador entra no chat, identificado pelo MAC. Aparelhos que nunca abriram o chat também aparecem na lista e recebem as mensagens quando abrirem.

```
┌──────────────────────┐   página, mensagens e arquivos (HTTP)   ┌──────────────────────┐
│ computador           │ ◀─────────────────────────────────────▶ │ celular, tablet,     │
│ server.js            │                                         │ computador           │
│                      │ ──────────────────────────────────────▶ │ navegador            │
└──────────────────────┘     eventos em tempo real (SSE)         └──────────────────────┘
```

- Conversa em grupo com todos os aparelhos e conversa privada com cada um.
- Envio de arquivos de qualquer tamanho, por botão, colar ou arrastar. Imagem, vídeo, áudio e PDF abrem no navegador.
- Lista dos aparelhos da rede com nome anunciado por mDNS, fabricante pelo MAC e situação: chat aberto, chat fechado ou fora da rede.
- Nome próprio escolhido por cada aparelho.
- Sem dependências: só Node.js.

| Arquivo | Conteúdo |
| --- | --- |
| [`server.js`](server.js) | Servidor HTTP: página, eventos, mensagens, arquivos e nomes. |
| [`rede.js`](rede.js) | Descoberta dos aparelhos: tabela ARP, nome por mDNS e fabricante pelo MAC. |
| [`mdns.js`](mdns.js) | Responde por `chat.local` e consulta os nomes anunciados na rede. |
| [`publico/`](publico) | Página do chat: HTML, CSS e JavaScript sem build. |
| [`compose.yaml`](compose.yaml) | Contêiner Docker na porta 80 que reinicia junto com o Docker. |

## Requisitos

- Computador com Linux ligado à rede local. O servidor lê `/proc/net/arp`.
- Docker com Compose, ou Node.js 24. Testado no Ubuntu com Node.js 24.
- Para mostrar o fabricante dos aparelhos: pacote `ieee-data` (`sudo apt install ieee-data`).

## Instalação

Com Docker:

```sh
docker compose up -d
```

O chat fica publicado em `http://chat.local` e volta a rodar quando o computador liga. iPhone, Mac, Windows e Linux com Avahi encontram `chat.local` sozinhos. No Android que não resolve `.local`, use o IP do computador.

Registro do servidor:

```sh
docker compose logs -f
```

## Execução sem Docker

Em uma porta acima de 1024, sem root:

```sh
PORTA=8080 node server.js
```

Na porta 80, o processo abre a porta como root e depois passa a rodar como o usuário indicado:

```sh
sudo PORTA=80 UID_USUARIO=$(id -u) GID_USUARIO=$(id -g) node server.js
```

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `PORTA` | `80` | porta HTTP |
| `NOME_HOST` | `chat` | nome publicado por mDNS, em `<nome>.local` |
| `UID_USUARIO` | | usuário que o processo passa a usar depois de abrir a porta, quando inicia como root |
| `GID_USUARIO` | igual a `UID_USUARIO` | grupo que o processo passa a usar depois de abrir a porta |

## API

| Método e caminho | Corpo | Efeito |
| --- | --- | --- |
| `GET /eventos` | | abre o fluxo de eventos (SSE) do aparelho que fez a requisição |
| `POST /mensagens` | JSON `{ "para": id ou null, "texto": "..." }` | envia texto de até 10000 caracteres; `null` envia ao grupo |
| `POST /arquivos?para=<id>` | o arquivo; nome no cabeçalho `X-Nome`, codificado como URI | envia um arquivo; sem `para`, envia ao grupo |
| `POST /nome` | JSON `{ "nome": "..." }` | muda o nome do aparelho; nome vazio volta ao nome anunciado na rede |
| `GET /arquivos/<id>` | | entrega o arquivo; `?baixar` força o download; aceita `Range` |

Eventos enviados em `/eventos`:

| Evento | Dados |
| --- | --- |
| `inicio` | `eu` (id deste aparelho), `dispositivos` e as `mensagens` visíveis para ele |
| `mensagem` | uma mensagem nova |
| `dispositivos` | a lista de aparelhos atualizada |

## Funcionamento

1. Cada requisição é atribuída a um aparelho pelo MAC do IP de origem, lido da tabela ARP. Sem MAC, o id é `ip-<endereço>`.
2. A cada 60 s o servidor envia um pacote UDP vazio para cada endereço da rede, o que faz o sistema preencher a tabela ARP com todos os aparelhos ligados.
3. Para cada IP, consulta por mDNS o nome do serviço anunciado (AirPlay, Google Cast, impressoras e outros) e o nome de host. Android não responde mDNS; nesse caso o nome vem do modelo no navegador, do fabricante ou do tipo de aparelho.
4. As mensagens chegam aos navegadores por Server-Sent Events. Mensagem privada vai só para quem enviou e para quem recebe.
5. O servidor responde às consultas mDNS por `chat.local` com o IP da interface ligada à rede de quem perguntou.

## Dados

Tudo fica em `dados/`, fora do git:

| Arquivo | Conteúdo |
| --- | --- |
| `dados/mensagens.jsonl` | uma mensagem por linha |
| `dados/dispositivos.json` | aparelhos conhecidos: MAC, IP, nomes, fabricante e último acesso |
| `dados/arquivos/<id>` | arquivos enviados |

## Segurança

Não há senha nem criptografia. Qualquer aparelho da rede lê as mensagens do grupo e os arquivos enviados a ele. A identificação pelo MAC pode ser falsificada por quem altera o MAC do próprio aparelho. Use só em rede de confiança.

## Licença

[MIT](LICENSE)
