# kimberly

## Sumário

- [O que cada executável faz (resumo rápido)](#o-que-cada-executável-faz-resumo-rápido)
- [Prioridade de qualidade (sorting)](#prioridade-de-qualidade-sorting)
- [Pré-requisitos](#pré-requisitos)
  - [Se você vai usar Docker (recomendado)](#se-você-vai-usar-docker-recomendado)
  - [Se você NÃO vai usar Docker (instalação manual)](#se-você-não-vai-usar-docker-instalação-manual)
- [Docker (stack Prowlarr/Radarr/Bazarr + URL bonitinha na LAN)](#docker-stack-prowlarr-radarr-bazarr--url-bonitinha-na-lan)
  - [Subir o stack](#subir-o-stack)
  - [Acessar as GUIs](#acessar-as-guis)
- [Configurações de dependências (Prowlarr/Bazarr)](#configurações-de-dependências-prowlarrbazarr)
- [Configuração](#configuração)
- [Uso](#uso)
  - [(Opcional) Execução agendada](#opcional-execução-agendada-cron-no-linux--task-scheduler-no-windows)
  - [Prowlarr CLI (builder do cache)](#prowlarr-cli-builder-do-cache)
  - [Debrid CLI](#debrid-cli)
  - [Debrid monitor](#debrid-monitor)
  - [Import manual para o Radarr](#import-manual-para-o-radarr-pasta-existente)
- [Variáveis de ambiente úteis](#variáveis-de-ambiente-úteis)
- [Formato do cache (flags de Debrid)](#formato-do-cache-flags-de-debrid)
- [Auto download hook](#auto-download-hook)

Um projeto de automação em Node.js que:

1. Lê uma lista do Letterboxd
2. Extrai **título** e **ano**
3. Busca releases no **Prowlarr**
4. Filtra / deduplica / prioriza releases
5. Persiste o resultado em um cache JSON (`cache.json`)
6. (Opcional) executa um pipeline com Debrid (Real-Debrid) + download automático + refresh do Plex + import no Radarr

### O que cada executável faz (resumo rápido)

- **`src/cli.js`**: lê a lista do Letterboxd, busca releases no Prowlarr, filtra/deduplica/prioriza e salva/atualiza o `cache.json`.
- **`src/debrid-cli.js`**: pega os filmes pendentes (da lista ou via pipe), envia torrents/magnets pro Real-Debrid, seleciona arquivos e (se habilitado) dispara o auto-download + ações (Plex/Radarr).
- **`src/debrid-monitor.js`**: monitora torrents já enviados ao Real-Debrid (queued/downloading) e finaliza quando ficarem prontos, baixando/extraindo/movendo arquivos conforme o pipeline.
- **`src/manual-import.js`**: utilitário para corrigir/ajudar importação no Radarr de um download já existente (e opcionalmente refresh do Plex após adicionar/importar).

### Prioridade de qualidade (sorting)

Releases são priorizados nesta ordem:

1) 2160p (4K), qualquer codec
2) 1080p + H265/X265
3) 1080p + H264/X264
4) 1080p (qualquer codec)
5) 720p (qualquer codec)
6) sem resolução detectada

Dentro da mesma prioridade:

- menor tamanho primeiro
- depois mais seeders

## Pré-requisitos

### Se você vai usar Docker (recomendado)

- **Docker + Docker Compose**
- **Uma lista no Letterboxd** (URL tipo `https://boxd.it/xxxx`)
- **Conta no Real-Debrid** (se você vai usar `EXECUTE_DEBRID`/auto-download)

> Com Docker, você não precisa instalar Prowlarr/Radarr/Bazarr/Node manualmente — o `docker compose up -d` sobe tudo.

### Se você NÃO vai usar Docker (instalação manual)

- **Node.js 18+**
- **Prowlarr** instalado e rodando (default: `http://localhost:9696`)
  - site: https://prowlarr.com
  - você precisa da **API key do Prowlarr** (`PROWLARR_API_KEY`)
- **Radarr** (opcional, mas recomendado se você usa Bazarr)
  - site: https://radarr.video
- **Bazarr** (opcional)
  - site: https://www.bazarr.media
- **Uma lista no Letterboxd** (URL tipo `https://boxd.it/xxxx`)
  - você pode passar por argumento ou setar `LETTERBOXD_LIST_URL` no `.env`
- **Conta no Real-Debrid** (para `debrid-cli`/`monitor` e auto-download)
  - você precisa do token em `REALDEBRID_API_KEY` e da base `REALDEBRID_URL`

### Opcionais (nos dois casos)

- **Plex** (para refresh automático após baixar/importar)
  - requer `PLEX_TOKEN` e `PLEX_SECTION_ID_FILMES`
- **7-Zip (`7z`)** instalado no sistema
  - só é necessário se você usa `AUTO_DOWNLOAD` e o Real-Debrid devolver arquivos `.rar` (extração via `7z x`)

<details>
<summary><strong>Instalação (passo a passo) — MODO MANUAL (sem Docker)</strong></summary>

> Se você vai usar **Docker**, pule esta seção e vá direto para o dropdown: **Docker (stack Prowlarr/Radarr/Bazarr + URL bonitinha na LAN)**.

1) Clone o repositório

```bash
git clone <repo-url>
cd kimberly
```

2) Instale as dependências

```bash
npm i
```

3) Configure o `.env`

Opção A (wizard interativo):

- Sem Docker (Node instalado no host):

```bash
npm run setup
```

- Com Docker (sem Node no host):

```bash
docker compose run --rm crawler-setup
```

Opção B (manual):

```bash
cp .env.example .env
```

4) (Se escolheu manual) edite o `.env` e configure o mínimo

Obrigatório:
- `PROWLARR_URL` (se não for o default)
- `PROWLARR_API_KEY`
- `LETTERBOXD_LIST_URL` (se quiser rodar o `cli.js` sem passar URL por argumento)

Se você vai usar debrid:
- `REALDEBRID_URL`
- `REALDEBRID_API_KEY`

5) (Opcional) Instalar os comandos CLI globalmente

```bash
npm link
```

Isso cria comandos como `kimberly` / `kimberly-debrid` no seu PATH.

</details>

<details>
<summary><strong>Docker (stack Prowlarr/Radarr/Bazarr + URL bonitinha na LAN)</strong></summary>

<details>
<summary><strong>(Opcional) Como instalar Docker no Windows</strong></summary>

- Docker Desktop (oficial): https://docs.docker.com/desktop/setup/install/windows-install/

Dicas:
- No Windows, o Docker normalmente usa **WSL 2** (é o caminho recomendado).
- Depois de instalar, verifique no terminal:

```powershell
docker --version
docker compose version
```

</details>

<details>
<summary><strong>(Opcional) Como instalar Docker no Ubuntu (Linux)</strong></summary>

- Guia oficial (Ubuntu): https://docs.docker.com/engine/install/ubuntu/

Depois de instalar, verifique:

```bash
docker --version
docker compose version
```

</details>


Se você quer facilitar a vida do usuário (sem precisar instalar Prowlarr/Radarr/Bazarr manualmente), este repositório inclui um `docker-compose.yml` que sobe tudo.

Pré-requisito: Docker + Docker Compose.

### Subir o stack

1) Configure o `.env`

Opção recomendada (wizard interativo):

- Se você tem Node instalado no host:

```bash
npm run setup
```

- Se você está no modo Docker-only (sem Node no host):

```bash
docker compose run --rm crawler-setup
```

> Recomendado: o wizard valida campos obrigatórios e te guia no fluxo. Configurar o `.env` manualmente é indicado apenas para usuários avançados.

No mínimo, você precisa ter: `AUTO_DOWNLOAD_DEST_DIR`, `LETTERBOXD_LIST_URL` e `PROWLARR_API_KEY`.

2) Suba os serviços (GUIs + proxy):

```bash
docker compose up -d
```

3) Rodar o crawler (sem instalar Node no host):

```bash
# roda cli.js (e se EXECUTE_DEBRID=true, ele chama debrid-cli dentro do próprio container)
docker compose run --rm crawler-cli

# roda o monitor
docker compose run --rm crawler-monitor
```

### Acessar as GUIs

- URL “bonitinha” via reverse proxy (Caddy):
  - http://localhost/prowlarr
  - http://localhost/radarr
  - http://localhost/bazarr

- Ou, direto nas portas (também funciona):
  - http://localhost:9696 (Prowlarr)
  - http://localhost:7878 (Radarr)
  - http://localhost:6767 (Bazarr)

### Importante (paths com reverse proxy)

Alguns apps precisam que você configure o **URL Base** na GUI para funcionar 100% atrás de `/radarr`, `/prowlarr`, `/bazarr`.
Se algo ficar estranho (assets quebrados/redirect errado), use a porta direta ou configure o URL Base no app.

</details>

---

## Configurações de dependências (Prowlarr/Bazarr)

Essas configurações valem tanto para instalação **manual** quanto via **Docker**.

<details>
<summary><strong>(Obrigatório) Como configurar o Prowlarr para encontrar torrents</strong></summary>

O **Prowlarr** é **obrigatório**: é ele que agrega os indexers e permite que o projeto encontre torrents.

Passo a passo:

1) Abra a GUI do Prowlarr:
   - http://localhost/prowlarr (ou http://localhost:9696)

2) No menu, vá em **Indexers**

3) Clique em **Add Indexers**
   - Selecione de onde você quer que o Prowlarr busque torrents (ex.: RARBG, YTS, etc.)
   - Quanto mais indexers você adicionar, melhor tende a ser a cobertura de resultados

4) Clique em **Test All Indexers** para validar se todos estão funcionando
   - Remova os que não estiverem funcionando (se houver)

5) Clique em **Save** (importante)

Pronto: Prowlarr configurado.

Se ficar com dúvida, confira o guia oficial do Prowlarr:
- https://wiki.servarr.com/prowlarr/quick-start-guide

</details>

<details>
<summary><strong>(Opcional) Como configurar o Bazarr para baixar legendas automaticamente</strong></summary>

O **Bazarr** serve para **baixar legendas automaticamente** para seus filmes/séries, integrando com Radarr/Sonarr (aqui a gente foca em Radarr).

Passo a passo:

1) Abra a GUI do Bazarr:
   - http://localhost/bazarr (ou http://localhost:6767)

2) Vá em **Settings → Radarr**
   - Marque **Enabled**
   - Cole a **API Key do Radarr**
     - (a API key fica disponível na GUI do Radarr: http://localhost/radarr ou http://localhost:7878 → **Settings → General**)
   - Desmarque **Download only monitored**
   - Clique em **Save** (importante)

3) Vá em **Settings → Languages**
   - Em **Language filters**, escolha a(s) linguagem(ns) desejada(s)
     - Se você escolher mais de uma, ele baixa legendas das duas
     - Recomendação comum: **pt-BR** e **en-US**
   - Clique em **Add New Profile**
   - Selecione as linguagens que você escolheu no *language filters*
   - Clique em **Save**

4) Vá em **Settings → Providers**
   - Adicione os sites de onde as legendas serão baixadas.
   - Recomendações:
     - **Gestdown** (gratuito e sem login)
     - **Legendas.net** (gratuito, mas precisa de login)
     - **OpenSubtitles.com** (gratuito, mas precisa de login)
     - **Supersubtitles** (gratuito sem login)
     - **Wizdom** (gratuito sem login)
     - **YIFY Subtitles** (gratuito sem login)
     - **Subdl** (gratuito, mas precisa de API Key)
     - **sub2fm.com** (gratuito, mas precisa de login)
   - Clique em **Save**

5) Vá em **Settings → Subtitles**
   - Em **Subtitle folder**, selecione: **Alongside media folder**
   - Marque:
     - **Encode subtitles to UTF-8**
     - **Treat embedded subtitles as downloaded**
     - **Show only desired languages**
     - **Adaptive searching**
     - **Search enabled providers simultaneously**
     - **Golden-section search**
     - **Automatic subtitles audio synchronization**
   - Clique em **Save**

6) (Opcional) **Settings → Plex** (apenas se quiser integração com Plex)
   - Marque **Enabled**
   - Clique em **Plex OAuth** e faça login na sua conta do Plex
   - Marque **Refresh movie metadata after downloading subtitles**
   - Clique em **Save**

Se ficar com dúvida, confira a documentação oficial do Bazarr:
- https://wiki.bazarr.media/Getting-Started/Setup-Guide/

</details>

---

<details>
<summary><strong>Setup no Windows (apenas 7-Zip para extração de .rar)</strong></summary>

Se você usa `AUTO_DOWNLOAD=true` e o Real-Debrid devolver arquivos `.rar`, você vai precisar do **7-Zip**.

- Instale o **7-Zip**
- Adicione `7z.exe` no **PATH**, ou configure `SEVEN_ZIP_PATH` no `.env`, por exemplo:
  - `SEVEN_ZIP_PATH=C:\\Program Files\\7-Zip\\7z.exe`

Notas:
- Extração de `.zip` **não** precisa de 7-Zip (é feita pelo Node).

</details>

## Configuração

Seu `.env` foi criado nos passos de instalação acima.

No mínimo, garanta que você setou:
- `PROWLARR_API_KEY`
- `LETTERBOXD_LIST_URL` (obrigatório para o modo padrão sem argumentos)

## Uso

## (Opcional) Execução agendada (cron no Linux / Task Scheduler no Windows)

Você pode criar o agendamento de duas formas:

1) **Automaticamente no final do wizard** (recomendado)
   - No `setup`, você pode optar por criar o cron/tasks automaticamente no final.

2) **Rodando os scripts de criação** (se você não criou no wizard)

- Sem Docker (Node no host):

```bash
npm run cron:linux
# ou
npm run cron:windows
```

- Com Docker (sem Node no host):

```bash
docker compose run --rm crawler-cli npm run cron:linux
# ou
docker compose run --rm crawler-cli npm run cron:windows
```

Isso usa as variáveis do `.env`:
- `CRON_USE_DOCKER` (default false): se true, o agendamento chama `docker compose run --rm ...`
- `CRON_CLI_EVERY_MIN` (default 20)
- `CRON_MONITOR_AFTER_CLI_MIN` (default 10)

> Dica: agende apenas o que você precisa. `cli.js` + `debrid-cli.js` podem encher o Debrid com torrents; `debrid-monitor.js` costuma ser o mais seguro para rodar periodicamente.

### (Opcional) Criação de CRON manualmente

Só faça isso se você **optou por não usar o script** (ou se quer personalizar além do que o script oferece).

<details>
<summary><strong>Linux (cron)</strong></summary>

1) Abra seu crontab:

```bash
crontab -e
```

2) Adicione entradas (exemplo: a cada 30 minutos):

```cron
*/30 * * * * cd <project-root> && /usr/bin/env node src/cli.js >> logs/cli.log 2>&1
*/30 * * * * cd <project-root> && /usr/bin/env node src/debrid-monitor.js >> logs/monitor.log 2>&1
```

Notas:
- Use um path absoluto para `<project-root>`.
- Garanta que o `.env` está configurado (os scripts carregam automaticamente).
- Crie a pasta de logs uma vez:

```bash
mkdir -p <project-root>/logs
```

Para outro intervalo, troque `*/30` por `*/5` (a cada 5 min), `*/10`, etc.

</details>

<details>
<summary><strong>Windows (Task Scheduler)</strong></summary>

1) Abra **Task Scheduler** → **Create Task…**
2) Aba **Triggers** → **New…** → “Daily” e “Repeat task every: X minutes”
3) Aba **Actions** → **New…**
   - **Program/script:** `node` (ou o caminho completo do `node.exe`)
   - **Add arguments:** `src\cli.js`
   - **Start in:** `<project-root>`
4) Repita para o monitor:
   - **Add arguments:** `src\debrid-monitor.js`

Notas:
- Garanta que seu `.env` existe em `<project-root>`.
- Se o Windows não achar `node`, use o path completo (ex.: `C:\\Program Files\\nodejs\\node.exe`).

</details>

### Prowlarr CLI (builder do cache)

Esta seção mostra o **uso manual** (para rodar agora, sem esperar o CRON).

**Sem Docker (Node no host)**

**Modo A: URL da lista do Letterboxd**

```bash
node src/cli.js "https://boxd.it/xxxx"
```

**Com Docker (sem Node no host)**

```bash
docker compose run --rm crawler-cli node src/cli.js "https://boxd.it/xxxx"
```

**Modo A (fallback): usar `LETTERBOXD_LIST_URL` do `.env`**

```bash
# .env
LETTERBOXD_LIST_URL=https://boxd.it/xxxx

# rodar sem args
node src/cli.js

# (Docker)
docker compose run --rm crawler-cli node src/cli.js
```

**Modo B: array explícito de filmes** (JSON; cada item no formato `"nome - ano"`)

```bash
node src/cli.js --movies "[\"Don't Play Us Cheap - 1973\", \"The French Connection - 1971\"]"

# (Docker)
docker compose run --rm crawler-cli node src/cli.js --movies "[\"Don't Play Us Cheap - 1973\", \"The French Connection - 1971\"]"
```

Saída: um array JSON com títulos do cache onde `process_executed !== true`.

### Debrid CLI

Esta seção mostra o **uso manual** (para rodar agora, sem esperar o CRON).

- Se você **não informar uma lista como parâmetro**, o script usa a `LETTERBOXD_LIST_URL` do `.env`.

**Sem Docker (Node no host)**

Rodar usando a URL da lista do Letterboxd:

```bash
node src/debrid-cli.js "https://boxd.it/xxxx"
```

Rodar sem parâmetros (usa `LETTERBOXD_LIST_URL` do `.env`):

```bash
node src/debrid-cli.js
```

Ou pipeando o array de pendentes do `cli.js`:

```bash
node src/cli.js "https://boxd.it/xxxx" | node src/debrid-cli.js
```

**Com Docker (sem Node no host)**

```bash
# com URL
docker compose run --rm crawler-cli node src/debrid-cli.js "https://boxd.it/xxxx"

# sem args (usa LETTERBOXD_LIST_URL do .env)
docker compose run --rm crawler-cli node src/debrid-cli.js

# pipe (gera pendentes no container e envia para o debrid-cli no mesmo container)
docker compose run --rm crawler-cli sh -lc 'node src/cli.js "https://boxd.it/xxxx" | node src/debrid-cli.js'
```

### Debrid monitor

Esta seção mostra o **uso manual** (para rodar agora, sem esperar o CRON).

**Sem Docker (Node no host)**

```bash
node src/debrid-monitor.js
```

**Com Docker (sem Node no host)**

```bash
docker compose run --rm crawler-monitor
# (equivalente a: docker compose run --rm crawler-monitor node src/debrid-monitor.js)
```

### Import manual para o Radarr (pasta existente)

Se você baixou um filme manualmente e criou uma pasta dentro da sua biblioteca (ex.: `/path/to/Movies/<Movie Folder>` ou `C:\\Videos\\Movies\\<Movie Folder>`), você pode pedir para este script encontrar a pasta e adicionar no Radarr. Ele também dispara um refresh do Plex.

```bash
# Sem Docker (Node no host)
node src/manual-import.js "Movie Name - 1999"
# ou sem ano:
node src/manual-import.js "Movie Name"

# Com Docker (sem Node no host)
docker compose run --rm crawler-cli node src/manual-import.js "Movie Name - 1999"
docker compose run --rm crawler-cli node src/manual-import.js "Movie Name"
```

## Variáveis de ambiente úteis

- `REWRITE_CACHE` (default `false`): se `true/1`, o `cli.js` reescreve a entrada de cache **do filme atual** mesmo se já existir.
- `MAX_NEW_MOVIES_PER_RUN` (default `5`): máximo de filmes *novos* que o `cli.js` adiciona ao cache por execução (`0` desabilita limite).
- `DEBRID_VERBOSE` (default `false`): logs detalhados do fluxo de debrid.
- `DEBRID_RETRY_DELAY_MS` (default `3000`): delay base para retry quando o provider retorna HTTP `429`.
  - 1º retry = 3s, 2º = 6s, 3º = 9s

Filtragem / saída:

- `MIN_GIB` / `MAX_GIB`: range de tamanho
- `MAX_TORRENTS`: limita quantos releases ficam por filme
- `HD_ONLY`: se ligado, mantém só 1080p/2160p quando houver HD
- `ENGLISH_TITLE_ONLY`: match por tokens do título do Letterboxd
- `EXCLUDE_TERMS`: termos separados por vírgula para excluir

## Formato do cache (flags de Debrid)

Por filme:

- `process_executed` (bool): default `false`. Se `true`, `debrid-cli` pula o filme.
- `year` (number|null): ano do filme no cache (usado no naming de pasta)
- `torrents`: mapa `{ torrentTitle -> torrentObject }`

Por torrent dentro de `torrents`:

- `sent_to_debrid` (bool)
- `downloaded` (bool)
- `downloading` (bool)
- `debrid_id` (string)
- `debrid_urls` (object): `{ video: string, subtitle: string }`
- `last_auto_download_error` (string)
- `magnet` (string)
- `torrent_url` (string)
- `torrent_path` (string)

## Auto download hook

Existe a flag `AUTO_DOWNLOAD` (default `false`) que liga o auto-download quando um torrent vira `downloaded`.

Related env:

- `AUTO_DOWNLOAD_DEST_DIR` (pasta final)
- `AUTO_DOWNLOAD_STAGING_DIR` (pasta temporária; fora da biblioteca do Plex)
- `DIR_NAME_MOVIE_ONLY` (default `true/1`): controla o naming das pastas de destino
- `AUTO_DOWNLOAD_REUSE_STAGING` (default `true/1`): reaproveita staging se uma execução anterior foi interrompida

Dica: **não renomeamos arquivos**.

Nome das pastas é controlado por `DIR_NAME_MOVIE_ONLY`:

- default (`true`): pasta fica só com o nome do filme
- se `false`: pasta vira `nome-ano-tmdb_<tmdbId>` (quando dá pra resolver tmdbId), senão `nome-ano`

Além disso:

- `PLEX_BASE_URL`
- `PLEX_TOKEN`
- `PLEX_SECTION_ID_FILMES`
- `PLEX_REFRESH_AFTER_DOWNLOAD` (default `false`): se `true/1`, chama `plexRefreshSection` após download/unzip.
- `RADARR_IMPORT_AFTER_DOWNLOAD` (default `false`): se `true/1`, adiciona o filme no Radarr após auto-download.
  - notas: resolve `tmdbId` via `GET /api/v3/parse` com fallback em `GET /api/v3/movie/lookup`.
- `RADARR_BASE_URL` (default `http://127.0.0.1:7878`)
- `RADARR_API_KEY`
- `RADARR_QUALITY_PROFILE_ID` (default `7`)
- `RADARR_ROOT_FOLDER_PATH` (exemplo Linux: `/path/to/Movies`, Windows: `C:\\Videos\\Movies`)

## Orquestração

Se você setar `EXECUTE_DEBRID=true`, depois que o `cli.js` termina ele spawna automaticamente o `debrid-cli.js` e passa o array de filmes pendentes via stdin.

```env
EXECUTE_DEBRID=true
```

## Pasta torrents/ (.torrent files)

Este projeto inclui uma pasta `torrents/` para armazenar arquivos `.torrent` locais.

- `torrents/.gitkeep` mantém a pasta no git
- `torrents/*.torrent` é ignorado no `.gitignore`
- no `cache.json`, quando não há magnet, `torrent_url` pode guardar um link HTTP (ex.: endpoint `/download` do Prowlarr)
- `torrent_path` guarda o caminho do `.torrent` baixado localmente

### Importante (Prowlarr)

Alguns indexers fazem o endpoint `.../download` do Prowlarr responder com `301/302` e `Location: magnet:...`.
Nesse caso **não existe** arquivo `.torrent` para baixar. A lógica do `cli.js` converte esse redirect em magnet e salva em `magnet`, deixando `torrent_path` vazio.

## Baixar um arquivo por URL (zip/mp4/mkv)

Comando: `kimberly-download`

```bash
# Baixar um vídeo
 kimberly-download --url "https://example.com/video.mkv" --dest "/path/to/Downloads"

# Baixar um .zip e extrair no destino
 kimberly-download --url "https://example.com/subs.zip" --dest "/path/to/Downloads" --unzip

# Extrair e deletar o .zip
 kimberly-download --url "https://example.com/subs.zip" --dest "/path/to/Downloads" --unzip --delete-zip-after
```

## Importar um .torrent e preencher torrent_path

Comando: `kimberly-torrent-import`

```bash
# Importar de um arquivo local
 kimberly-torrent-import --movie "phantom of the paradise" \
  --torrent "Phantom of the Paradise 1974 1080p BluRay x265-RARBG" \
  --file "/path/to/file.torrent"

# Importar de uma URL HTTP
 kimberly-torrent-import --movie "phantom of the paradise" \
  --torrent "Phantom of the Paradise 1974 1080p BluRay x265-RARBG" \
  --url "https://example.com/file.torrent"
```

## Provider base URL + API key (Real-Debrid)


- `REALDEBRID_URL`: se setada, tem prioridade e vira a base URL do provider
- `REALDEBRID_API_KEY`: enviada como `Authorization: Bearer ...`

