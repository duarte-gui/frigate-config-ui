# Frigate Config UI

Editor web leve para a configuração do [Frigate NVR](https://github.com/blakeblackshear/frigate), sem dependências (só stdlib do Python + um CDN para a lib [`yaml`](https://eemeli.org/yaml/)). Pensado para rodar ao lado do Frigate (ex.: LXC/Proxmox, Docker ou bare-metal) e editar a config por uma interface amigável em vez de YAML cru.

## Arquitetura

```
navegador ──HTTP──> server.py (:8000) ──proxy /api/*──> Frigate (:5000)
                         │
                         └── serve index.html + app.js (estáticos)
```

- **`server.py`** — servidor estático + proxy. Encaminha tudo sob `/api/*` para `http://127.0.0.1:5000` (a API do Frigate) e serve os arquivos estáticos. Stdlib apenas.
- **`index.html`** — UI (abas: MQTT, Detectores, Câmeras, Gravação, Snapshots, Objetos, go2rtc, YAML cru).
- **`app.js`** — lógica em JS puro. Carrega de `GET /api/config/raw`, salva em `POST /api/config/save`.

## Funcionalidades

- Edição visual de **câmeras** (inputs ffmpeg + roles, detect, record, snapshots, objetos, motion mask, zones em YAML)
- **Zonas obrigatórias de revisão** por câmera (`review.alerts.required_zones` e
  `review.detections.required_zones`) — o que decide quais zonas promovem um
  objeto a alerta ou detecção e, por tabela, o que acaba gravado
- **Reordenar câmeras por arrastar** (drag-and-drop pelo ícone ⠿) — a ordem no config é a ordem em que as câmeras aparecem nos clientes
- Abas para MQTT, detectores, gravação, snapshots, objetos e **streams go2rtc**
- Editor de **YAML cru** com substituição completa
- **Salvar** (sem reiniciar) e **Salvar & Reiniciar**

## Comentários e formatação sobrevivem ao salvar

O editor monta um objeto JS a partir do formulário, mas **não regrava o arquivo
a partir dele**. Ele lê a config como um `Document` da lib `yaml` — a árvore com
os comentários e a formatação originais — e no salvamento aplica sobre essa
árvore apenas os campos que realmente mudaram.

A diferença é grande na prática: um `load`/`dump` reescreve o arquivo inteiro e
descarta todo comentário, enquanto aqui alterar um campo produz um diff de uma
linha. Comentários que você escreveu no `config.yml` continuam lá, na mesma
posição, depois de salvar pela interface.

A aba **YAML cru** mostra o arquivo real, com os comentários. O que você editar
ali vira a nova base — inclusive comentários novos.

## go2rtc — atenção ao reiniciar

O `save_option=restart` da API do Frigate reinicia **apenas** o serviço `frigate` — **não** o `go2rtc`. O go2rtc só relê os streams (gerados de `frigate.yml` em `/dev/shm/go2rtc.yaml`) quando a **própria unidade dele reinicia**. Sem isso, mudanças em streams ficam salvas mas não entram no ar.

Por isso o **"Salvar & Reiniciar"** chama também `POST /restart-go2rtc`, que executa `systemctl restart go2rtc`. Ajuste esse comando em `server.py` (`_restart_go2rtc`) conforme o seu ambiente (ex.: `docker restart frigate`, ou o nome da sua unidade/serviço).

## Instalação

Rode **no mesmo host do Frigate** (o proxy fala com `http://127.0.0.1:5000`).

### Rápida (script)

```bash
curl -fsSL https://raw.githubusercontent.com/duarte-gui/frigate-config-ui/master/install.sh | sudo bash
```

Ou a partir de um clone:

```bash
git clone https://github.com/duarte-gui/frigate-config-ui
cd frigate-config-ui
sudo bash install.sh
```

O script copia os arquivos para `/opt/frigate-ui`, instala o serviço systemd, faz backup de uma instalação anterior e sobe o `frigate-ui`. Para remover: `sudo bash install.sh --uninstall`.

### Manual

```bash
sudo mkdir -p /opt/frigate-ui
sudo cp server.py index.html app.js /opt/frigate-ui/
sudo cp frigate-ui.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now frigate-ui
```

Acesse `http://IP_DO_HOST:8000`.

> O `server.py` roda como root (necessário para `systemctl restart go2rtc`) e assume o Frigate em `127.0.0.1:5000`. Ajuste `FRIGATE_URL`/`PORT` no topo do arquivo se preciso.

## Licença

MIT
