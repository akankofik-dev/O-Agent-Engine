# MILESTONE 1 — ARCHITECTURE AUDIT

Read-only. Tidak ada file yang dihapus, dipindah, di-rewrite, atau di-commit.
Semua klaim di bawah ini berasal dari membaca source yang benar-benar dipakai, dan
diantaranyaresults yang gw ukur langsung ke server yang sedang hidup.

---

## 0. Dua koreksi atas klaim sendiri

Audit ini dimulai dengan dua klaim yang **ternyata salah**. Dicatat di depan
supaya tidak dipakai sebagai dasar:

| Klaim gw | Kenyataan | Bukti |
|---|---|---|
| "Loop agent belum pernah jalan di mesin ini" | **Salah.** Loop-nya jalan end-to-end, 10 test, 4.5 detik, lewat `/api/agent/run` SSE sungguhan. Yang belum pernah terjadi: jalan melawan model sungguhan. | `test/retry-live.test.js` — provider palsu di `http.createServer` (`:35-55`), lalu `runTurn()` menembak API asli (`:58-83`). 10 passed saat `npm test` dijalankan. |
| "`data/agent-config.json` nggak ada ⇒ belum pernah dikonfigurasi" | **Salah.** Filename itu dihapus **sengaja** di akhir test, supaya mesin dikembalikan seperti semula. | `retry-live.test.js:163-173` — `PUT /api/config/agents` dengan daftar kosong, lalu `fs.unlinkSync(CFG_PATH)`, lalu assert `data/ is left exactly as found`. |

Koreksi ketiga, lebih kecil: gw sebelumnya menyebut `shell_exec` "pintu terbuka"
secara bawaan. **Salah** — `terminal: false` dan `rules: false` di
`ai/store.js:21`.

---

## 1. Audit repository — apa yang benar-benar ada

Proyek: Node.js, **nol dependency** (`package.json:15` — `"dependencies": {}`).
Server WebSocket ditulis tangan (`server.js:1550-1713`, GUID RFC6455 dihitung inline
di `:3385`). Tidak ada framework, tidak ada bundler.

| Bagian | File | Baris | Kenyataan |
|---|---|---|---|
| Entry point | `server.js` | 3574 | `main()` di `:3484`, listen dulu baru nyalain Chrome |
| Otak agent | `ai/engine.js` | 424 | Loop tool-calling — rinci di §3 |
| Transport LLM | `ai/providers.js` | 521 | 3 adapter: openai-compatible, anthropic-messages, ollama |
| Prompt | `ai/context.js` | 163 | `buildContext()` merakit system message |
| Tools | `ai/tools.js` | 323 | **16 tool**, statis |
| Capability | `ai/skills.js` + `ai/rules.js` | 79 + 587 | 6 kunci capability |
| Registry engine | `ai/automation/index.js` | 615 | Router + health + cooldown |
| Kontrak engine | `ai/automation/engines/*.js` | 4 berkas | 7 method per engine |
| Klien MCP | `ai/automation/mcp.js` | 185 | JSON-RPC 2.0 di stdio anak |
| State engine | `ai/automation/state.js` | 87 | Preferensi + toggle |
| Sesi browser | `ai/browser/session.js` | 226 | `agentTabId` = satu slot |
| Registry run | `ai/runs.js` | 197 | Lock global, 1 run pada satu waktu |
| Dokumen agent | `ai/agentfiles.js` | 152 | SOUL.md + MEMORY.md |
| Lampiran | `ai/attachments.js` | 298 | Batas 8 MB, sapu 1 jam |
| Store | `ai/store.js` | 528 | 1 file: `data/agent-config.json` |
| Kompat model | `ai/compat.js` | 243 | Verdict katalog vs probe nyata |
| UI | `dashboard.html` | 9847 | Satu berkas, tanpa build |

### Entry point & boot — `server.js:3484-3529`

Urutannya disengaja: `pickPort` → `server.listen` **sebelum** Chrome dinyalakan
(`:3485-3494`, fail fast) → `seedFromEnv` (`:3499`) → `ensureChrome` → `connectCDP`.

### Routing

Rantai `if (pathname === ...)` datar, ~400 baris, di `handleApi()` (`:1769-2169`).
Tidak ada router table. Static: `serveStatic()` (`:2919`) — traversal dicek,
`data/` + `ai/` + file config dikasih 404.

### Persistence — semua file yang ditulis

| Path | Pemilik | Atomik? |
|---|---|---|
| `data/agent-config.json` | `ai/store.js:211` | tmp+rename+chmod 0600 |
| `data/rules.json` | `ai/rules.js:190` | tmp+rename+chmod 0600 |
| `data/rule-proposals.json` | `ai/rules.js` | tmp+rename+chmod 0600 |
| `data/automation.json` | `ai/automation/state.js:56` | tmp+rename+chmod 0600 |
| `data/runtimes.json` | `ai/runtimes/store.js` | tmp+rename+chmod 0600 |
| `data/agents/<id>/SOUL.md`, `MEMORY.md` | `ai/agentfiles.js:99` | tmp+rename, **tanpa chmod** |
| `data/inbox/<id>/<nama>` | `ai/attachments.js:228` | **tidak atomik**, tidak ada tmp |

`writeAtomic()` hanya ada di `ai/rules.js:190` dan **tidak di-export**. Tiga modul
menyalin pola itu sendiri-sendiri; satu (__`attachments.js`) tidak memakainya sama sekali.

---

## 2. Architecture Map — YANG SEBENARNYA, bukan yang diharapkan

Diagram asumsi di Milestone 1 adalah satu garis lurus. Yang ada di disk
**dua sistem yang hanya bertemu di browser**, dan keduanya berbagi satu titik:
Chrome lewat CDP.

```
┌─────────────────────────────────────────────────────────────┐
│SISTEM A — WORKBENCH   (selalu hidup, terbukti jalan)        │
│                                                             │
│  USER ──> dashboard.html ──> fetch / WebSocket              │
│                                        │                    │
│                                        v                    │
│                                 server.js                   │
│                              ┌─────┴─────┐                  │
│                              │           │                  │
│               /api/browser/action   /api/shell (WS)         │
│                              │           │                  │
│                              v           v                  │
│                       doAction()    ShellSession            │
│                              │        (pipe, bukan PTY)     │
└─────────────────────────────────────────────────────────────┘
                              │
                              │
┌─────────────────────────────────────────────────────────────┐
│   Chrome via CDP   ← satu-satunya titik pertemuan           │
└─────────────────────────────────────────────────────────────┘
                              │
                              │
┌─────────────────────────────────────────────────────────────┐
│SISTEM B — AGENT   (kode lengkap, jalan vs provider palsu)   │
│                                                             │
│  USER ──> dashboard ──> POST /api/agent/run  (SSE)          │
│                                          │                  │
│                           ai/runs.js  claim()  ← LOCK GLOBAL│
│                                          │                  │
│                             ai/engine.js  runAgent()        │
│                                          │                  │
│                        ┌─────────┤─────────────┐            │
│                        v                            v       │
│              ai/context.js              ai/providers.js     │
│              (system prompt)            (3 adapter)         │
│                                              │              │
│                                         <provider LLM>      │
│                                              │              │
│                                tool_calls ◄──┘              │
│                                     │                       │
│                             ai/tools.js  (16 tool)          │
│                                     │                       │
│                         ai/automation  route()  ← ROUTER    │
│                                     │                       │
│                    ┌─────────────┤───────────────────┐      │
│                    v                                  v     │
│             native-cdp  ──────┐          stagehand /        │
│             playwright-mcp    │          browser-use        │
│             browser-use        │                  │         │
│                           └───────┬──────────┘              │
│                                    v                        │
│                         doAction() ─────────> CDP           │
└─────────────────────────────────────────────────────────────┘
```

### Tiga hal yang beda dari asumsi awal

**1. Ada dua pintu masuk ke browser, dan hanya satu yang lewat router.**

| Pintu | Lokasi | Lewat router? |
|---|---|---|
| Human, klik di preview | `server.js:1816` → `doAction(body)` | **Tidak** |
| Agent, semua tool | `server.js:2543` → `automation.route(body)` | Ya |

Artinya: **preview manusia tidak pernah menyentuh engine**. Kalau nanti agent
membangun engine baru, preview lu tetap native CDP. Itu memang benar secara desain
(preview harus menampilkan tab asli), tapi mudah salah dibaca.

`doTabs()` juga di luar router di kedua jalur (`:1832` dan `:2553`).

**2. "Engine" di proyek ini = paket browser automation, bukan engine proyek.**

Empat engine terdaftar (`ai/automation/index.js:38-43`): `native-cdp` (built-in),
`playwright-mcp`, `stagehand`, `browser-use`. Kontrak per engine cuma 7 hal:

```
id, name, type, builtIn, capabilities[], available(), execute(), observe(), recover(), shutdown()
```

`native-cdp` = 2.943 byte. Router sudah punya: rank by capability, fallback
berantai, cooldown 45 detik setelah 2 kegagalan gagal lebih sering
(`COOLDOWN_AFTER=2`, `COOLDOWN_MS=45000`), health map, dan `describe()` untuk UI.

**3. Yang mengunci registry engine: satu daftar hardcoded — sudah dibongkar.**

```
ai/automation/index.js:38   DEFAULT_ENGINES = [ 4 require() statis ]
ai/automation/state.js:26   KNOWN = [ 'native-cdp', 'playwright-mcp', 'stagehand', 'browser-use' ]
```

`createRouter()` dipanggil di `server.js` **tanpa** argumen `engines`, jadi
selalu jatuh ke `DEFAULT_ENGINES` (`:125`). Dan `state.js` **diam-diam membuang**
id yang tidak ada di `KNOWN` — bukan error, hilang tanpa pesan.

Kondisi hidup saat ini (diukur via `/api/automation/engines`): `native-cdp`
available; `playwright-mcp` **dimatikan**; `stagehand` + `browser-use` "not checked
yet". Jadi router praktis cuma punya **satu** engine yang bisa dipakai.

**Kabar baiknya, danabar buruknya.** `DEFAULT_ENGINES` memang daftar, tapi itu
memang benar — itu definisi engine bawaan, bukan penolakan. Yang salah adalah
`KNOWN`, dan sekarang sudah dibongkar:

```
setEnabled('echo-engine', false)  ->  { ok:false, error:'unknown engine: echo-engine' }
```

Dashboard sudah menggambar switch untuk **semua** engine, jadi panelnya
menjan-db switch yang server tolak. Dan tidak ada satu pun test yang menyentuhnya
selama empat milestone.

Dua lapis yang salah, dan sekarang dipisah:

| Lapis | Menjawab | Sumber |
|---|---|---|
| `state.js` `ID_RE` | "ini **bisa** jadi id engine?" | bentuk, bukan daftar |
| `server.js` `BY_ID.has()` | "engine ini **ada**?" | registry yang hidup |
| `index.js` `userEnabled()` | "user **aktifkan**?" | satu pembaca, dipakai router + panel |

`normalise()` sekarang menyimpan setiap entri yang id-nya bisa jadi id, dan
`describe().orphans` melaporkan sisa yang tidak punya engine — supaya switch yang
disimpan untuk engine yang dihapus terlihat, bukan diam-diam hilang.

Dan yang lebih penting, ditemukan bareng: **`usable()` tidak pernah membaca
`enabled` sama sekali.** Komentarnya sudah tulis "enabled, available, not cooling
down" sejak dulu, tapi body-nya cuma cek `available`, cooldown, dan capability.
Jadi switch-nya bekerja ke arah yang salah — kalau succeeds, panel berubah;
behavior-nya tidak. `discover.test.js` dan `evolve.test.js` yang menguji
"engine yang dimatikan" menguji `health.available`, bukan preference, jadi keduanya
tetap hijau selama bug ini hidup.

---

## 3. AGENT CORE — dipisah dari yang lain

Batasnya jelas dan sudah diberi tanda di header `ai/engine.js:5-20`:

```
LLMProvider        ai/providers.js   transport + wire format
      ↓
ContextBuilder     ai/context.js     merakit setiap byte prompt
      ↓
AgentEngine        ai/engine.js      loop tool-calling   ← INI AGENT CORE
      ↓
Tool runner        ai/tools.js       satu tool = satu aksi
      ↓
controller         CDP / child_process, di-inject server
```

**Isi `runAgent()` (`ai/engine.js:255-422`) — semuanya:**

| Fungsi | Baris | Mekanisme |
|---|---|---|
| Menerima task | `:255` | `{provider, profile, text, history, attachments, shouldStop, controller, onEvent}` |
| Merakit konteks | `:259` → `prepareContext()` `:205` | skills → caps → SOUL.md → instructions → runtime → system |
| Mengambil keputusan | `:324` | `provider.chat({messages, tools})` — **LLM yang memilih tool**, bukan kode |
| Batas putaran | `:305` | `profile.maxRounds`, default 8, clamp 1–40 (`store.js:177`) |
| Retry | `:341-354` | **hanya di transport**: `RETRY_DELAYS_MS` default `[1000,3000,8000]`, pakai `e.retryable` |
| Overflow konteks | `:334-339` | budget diturunkan ke 60% dari `fitted.chars`, maks 4 kali |
| Memilih tool | `:396` | `tools.toolByName(call.name)` — `Map` statis dari 16 tool (`:282`) |
| Menjalankan tool | `:406` | `def.run(ctx, args)`; error jadi teks `error: …`, bukan exception |
| Cek capability | `:401-403` | `def.caps.some(c => caps[c])` — capability mati = tool ditolak |
| Menerima hasil | `:413-416` | `clip()` 12.000 karakter (`MAX_RESULT_CHARS`), masuk sebagai `{role:'tool'}` |
| Context overflow | `:128-154` | `fitContext()` buang putaran terlama, system prompt tak pernah dibuang |
| Berhenti | `:169-183` | `waitOrStop()` polled tiap 100 ms, jadi tombol stop responsif |

### Yang TIDAK ada di agent core

- **Retry tool.** Gagal → teks error dikembalikan ke LLM, keputusan ada di model.
- **Retry langkah.** Kalau satu tool gagal, tidak ada percobaan ulang otomatis.
- **Perbandingan hasil.** Nggak ada "cek ulang apakah benar-benar berhasil" selain
  what's in `CORE` (context.js:25-32): *"read again to confirm what actually
  changed"*. CumaInstruksi, bukan mekanisme.
- **Titik persetujuan di tengah run.** Nol. Satu-satunya manusia adalah antrean
  rule di Settings, dan itu **antar run**.
- **Titik ekstensi runtime.** `TOOLS` adalah `const` modul. Nggak ada cara menambah
  tool tanpa edit file.

### Batas context yang sudah diperbaiki bertele-tele

`fitContext()` (`:128-154`) membuang blok terlama, tidak pernah membuang system
prompt, dan tidak pernah mengembalikan hasil yang lebih besar dari asalnya. Tiga
komentar di `:45-59` dan `:119-127` mencatat alasannya: `MIN_BUDGET_CHARS` tadinya
8000 sehingga setiap pengurangan mendarat di lantai, request terkirim ulang
byte-identik, dan run membakar 4 percobaan untuk penolakan yang sama.

---

## 4. Yang tidak ada — dinyatakan, bukan disimpulkan

1. **Tidak ada autentikasi.** Tanpa token, cookie, kredensial apa pun, di endpoint
   mana pun maupun di socket.
2. **Tidak ada token CSRF.** Satu-satunya pertahanan adalah kesamaan `Origin`.
3. **Tidak ada build step** untuk `dashboard.html`. Nol dependency frontend.
4. **Tidak ada persetujuan di tengah run.**
5. **Tidak ada migrasi skema.** `version: 1` ditulis hardcoded (`store.js:194`)
   dan tidak pernah dibaca.
6. **Tidak ada test untuk:** `ai/attachments.js`, `ai/agentfiles.js`,
   `serveStatic`, gate origin, adapter `anthropic-messages` dan `ollama`, dan
   **0 baris dari 9847 baris UI**. (Diverifikasi: `grep` di `test/` tidak menemukan
   satu pun referensi ke `attachments`, `agentfiles`, `dashboard`, `serveStatic`,
   `anthropic`, `ollama`.)
7. **Tidak ada `package-lock.json`** di root, padahal `node_modules/` ada.
8. **Tidak ada sandbox filesystem.** `cwd` dikunci ke `ROOT`, tapi perintahnya
   tidak dibatasi sama sekali.

---

## 5. Temuan yang gw ukur langsung (bukan dibaca)

Server hidup di `http://127.0.0.1:8787`, uptime ~6104 detik, Chrome 154.0.8037.57
nyambung di port 9222.

### 5.1 `npm test` — masih hijau

```
140 passed across 8 suites in 12.2s
```

### 5.2 Paparan tanpa kredensial — TERBUKTI, bukan asumsi

`originAllowed()` (`server.js:1736-1740`) mengembalikan `true` kalau header
`Origin` **hilang**. `sendJson()` (`:1748`) meanwhile mengirim
`access-control-allow-origin: *` di setiap respons. Diuji:

| Permintaan | Hasil |
|---|---|
| `GET /api/config/agents` tanpa header Origin | **200**, `ACAO=*` |
| dengan `Origin: http://127.0.0.1:8787` | **200**, `ACAO=*` |
| dengan `Origin: https://situs.acak.example` | **403** |
| dengan `Origin: null` | **200** |
| `POST /api/agent/run` tanpa Origin, tanpa kredensial | **400** `no agent profile yet` |
| **WebSocket `/api/shell` tanpa Origin** | **101, perintah benar-benar dijalankan** |
| WebSocket `/api/shell` dengan Origin asing | ditolak (`socket hang up`) |

Yang terbukti: **halaman web luar tidak bisa menembak API ini** (403), tapi
**proses lokal mana pun bisa — dan lewat WebSocket shell, dia mendapat shell
interaktif tanpa kredensial apa pun.** Perintah `echo` benar-benar dieksekusi.

`POST /api/agent/run` yang 400 itu karena tidak ada profil, **bukan** karena auth.
Begitu lu menambah provider di Settings, proses lokal bisa menjalankan agent
dengan key lu.

### 5.3 Allowlist URL bisa dilewati — default `javascript` menyala

`DEFAULT_TOOLS` (`ai/store.js:21`):
```
browser: true, screenshot: true, dom: true, javascript: true, terminal: false, rules: false
```

`guardUrl()` (`server.js:2528`) dipanggil **hanya** di `navigate` (`:2542`) dan
`tabs new` (`:2552`). Aksi `javascript` (`:1277-1282`) dan `click` pada tautan
**tidak** dicek host-nya. Jadi profil yang memakai allowlist tetap bisa dikejar
lewat capability `javascript` yang default-nya nyala.

Allowlist kosong berarti tanpa pembatasan (`store.js:102-104`), jadi secara default
memang tidak ada yang dibatasi.

### 5.4 Loop agent: yang sudah terbukti dan yang belum

**Terbukti** (lewat `retry-live.test.js`, 10 test): HTTP route → lock → engine →
context → adapter openai-compatible → SSE → event. Termasuk pemulihan 429 dan
overflow konteks.

**Belum pernah terjadi:** satu pun run melawan model sungguhan di mesin ini. Dan
adapter `anthropic-messages` serta `ollama` tidak punya **satu pun** referensi di
`test/`.

### 5.5 Riwayat rules penuh residu test

`/api/rules` → `version: 14`, `pending: []`. Semua 14 entri history-nya
`by: "agent", reason: "proving the path works"` atau `by: "person", reason:
"reverted to N"`. Itu sisa `rule-create.test.js`, bukan penggunaan nyata.

---

## 6. Apa artinya ini buat Milestone 2

Tiga hal yang sudah jadi dan bisa langsung dipakai:

1. **Kontrak engine sudah ada, kecil, dan bersih** — 7 method. Butuh ~200 baris JS
   untuk bikin engine yang sah. Tidak perlu dari nol.
2. **Router sudah punya semua yang dibutuhkan** — rank by capability, fallback,
   cooldown, health, `describe()` untuk UI.
3. **Tata kelola untuk *aturan* sudah dibangun dan jalan** — usulan → antrean
   (max 50) → manusia terima/tolak → revert, dengan `reason` wajib dan jejak siapa.

Tiga hal yang jadi hambatan, dan ketiganya kecil:

1. **Daftar engine terkunci di dua tempat** (`index.js:38`, `state.js:26`).
   `createRouter()` sudah menerima argumen `engines` — jadi jalur plugin-nya
   secara arsitektur **sudah tersedia**, cuma belum dipakai. Dan `state.js:normalise()`
   harus diubah supaya id tak dikenal jadi error, bukan dibuang diam-diam.
2. **Tidak ada jalur tata kelola untuk *kode*.** Aturan punya antrean; kode tidak.
3. **Tidak ada verifikasi yang jadi bagian dari alur.** 140 test jalan, tapi
   tidak ada yang mengikat "usulan kode" → "jalankan test" → "tampilkan hasilnya".

Dan satu catatan yang harus jujur:dashboard 9847 baris dan `providers.js` punya
nyaris nol coverage. Kalau agent nanti boleh mengubah kode, harness yang memverifikasi
perubahan itu sendiri adalah bagian yang paling belum siap — lebih belum siap
daripada mekanisme engine-nya.

## 7. SELF-EVOLVE — Level 1 sampai 7

Dokumen ini audit Milestone 1 dan kesimpulan tentang Milestone 2. Yang di bawah
ini peta untuk level-level setelahnya: di mana modulnya, urutan yang boleh
dijalankan, dan file mana yang menyimpan versi. **Argumen keamanan tidak
diulang di sini** — itu milik modul yang=swap, dekat dengan aturannya, supaya
tidak ada satu aturan yang ditulis di dua tempat dan diperbarui di salah satunya.

### Tujuh level, satu urutan

```text
Level 1  USE         engine_execute                  forge.js
Level 2  SELF-BUILD  create_engine, gate, registry   forge.js
Level 3  SELF-REPAIR repair, versi, rollback         lifecycle.js
Level 4  SELF-IMPROVE improve, compare, promote      lifecycle.js
Level 5  SELF-DISCOVER survei kapabilitas, plan      discover.js
Level 6  SELF-COMPOSE workflow, retry, trace         compose.js
Level 7  SELF-EVOLVE orchestrator                    evolve.js
```

`evolve.js` tidak mengimplementasikan apa pun. Dia hanya menentukan modul mana
yang dipanggil dan dalam urutan apa — dan itu justru bagian yang paling bisa
salah tanpa ada gate di belakangnya, karena orchestrator yang membangun saat plan
bilang jangan adalah bug yang tidak bisa ditangkap modul mana pun.

### Enam modul

| Modul | Tugas | Ukuran |
|---|---|---|
| `forge.js` | gate, scaffold, registry, `create_engine` + `engine_execute` | 1106 baris |
| `lifecycle.js` | repair, improve, promote, rollback, versi | 390 baris |
| `discover.js` | survei kapabilitas, `plan`, `guardBuild` | 244 baris |
| `compose.js` | workflow, `$prev`/`$steps`, retry, trace | 358 baris |
| `evolve.js` | urutan lifecycle, trace capability | 309 baris |
| `evolve-tools.js` | enam tool agent | 388 baris |

Tiga di antaranya tidak boleh bisa melakukan pekerjaan yang bukan tugasnya, dan itu
diuji, bukan dijanjikan:

- `discover.js` **tidak require `forge` sama sekali.** Planner yang bisa build
  adalah builder yang bisa mengobral dirinya sendiri. Yang diuji: file itu tidak
  mengandung `require('./forge')`, `forge.create`, `forge.build`, atau
  `child_process`.
- `compose.js` **tidak menyentuh file.** Satu-satunya jalan ke engine adalah
  `router.route()` — yang sama dengan yang dipakai browser, sehingga policy URL
  Milestone 2A, pemeriksaan context, availability, dan cooldown tetap berlaku
  untuk langkah workflow seperti untuk panggilan biasa.
- `evolve.js` **tidak menulis file, tidak menjalankan proses anak, tidak
  menyentuh `require.cache`.** Dia memesan; modul yang dipesan yang
  menjalankan.

### Layout disk

```text
engines/
  <id>/
    manifest.json  index.js  test.js     <- versi aktif
    .versions/<stamp>/                    <- setiap versi aktif yang pernah ada
  .candidate-<id>-<stamp>/                <- kandidat, sedang diuji
```

Kandidat berawalan titik, jadi `engineDirectories()` melewatinya dan `ls` tidak
membuat orang melewatinya. Panjangnya sedalam folder engine, bukan di dalamnya,
dan itu yang membuat `require('../../ai/automation/context')` di engine yang
dihasilkan resolve ke tempat yang sama — sehingga kandidat **diuji dengan
menjalankannya**, bukan dengan meniru apa artinya menjalankan.

Perhatikan arahnya: `engines/<id>/` berisi versi aktif, dan `create_engine`
tetap menolak menimpanya. Snapshot hanya ditulis oleh `lifecycle.js`, hanya
setelah kandidat lulus gate.

### Sepuluh tool, satu izin

`create_engine`, `engine_execute` (Level 2) plus `repair_engine`,
`improve_engine`, `rollback_engine`, `engine_plan`, `engine_compose`,
`engine_evolve` (Level 3-7). Semuanya di balik satu kunci izin: `engines`.

Satu izin, bukan delapan, karena izin yang memisahkan "boleh menulis engine"
dari " boleh menjalankan engine" menghasilkan profil yang bisa memperbaiki engine
yang baru ia bangun tetapi tidak bisa menjalankannya — dan itu bukan perbedaan yang
diingin siapa pun. Yang diuji: setiap tool punya tepat satu cap, dan keenamnya
ditawarkan **hanya** ke profil yang punya kunci itu.

Semuanya dipasang saat runtime, bukan ditulis ke `ai/tools.js`. Alasannya
terukur: `BY_NAME` dibangun sekali saat modul dimuat, jadi entri yang
ditambahkan sesudahnya tidak akan pernah ditemukan. Yang dijaga sekarang
adalah properti aslinya — tidak ada entri engine yang di-hardcode — karena
entri hardcode tidak akan ketahuan oleh `git diff`, melainkan diam-diam
men.Override yang terpasang.

### Yang diukur, bukan yang dijanjikan

| | |
|---|---|
| `npm test` | 340 passed / 17 suite / 59.4s |
| `forge.test.js` | 70 — gate, registry, cache, guard |
| `lifecycle.test.js` | 22 — repair sukses/gagal, built-in ditolak, rollback, cache |
| `discover.test.js` | 14 — survei, plan, dan guard yang menolak build kedua |
| `compose.test.js` | 20 — rantai, kegagalan, retry, trace, cooldown |
| `evolve.test.js` | 20 — 7 kasus acceptance, capability discover sampai rollback |
| `evolve-tools.test.js` | 21 — keterlacakan tool, penolakan, satu izin |
| E2E lewat agent | 12 passed — `/api/agent/run` → `ai/engine.js` → tool → forge → disk → test → registry → router → engine |


Aturan ini: **proyek ini bukan "browser automation".**

Bukan candaan. Ini keputusan yang diukur, dan alasannya ada di bawah.

## Kenapa kata itu harus hilang

Dulu ada satu kalimat di `ai/agentfiles.js` yang berbunyi:

```
You are a careful browser automation agent.
```

Itu **SOUL.md default** — file identitas tiap agent, dan dikirim ke model **setiap giliran**. Bukan prompt, bukan dokumentasi: identitas.

Efeknya terlihat, dan semuanya tercatat:

1. Agent yang **tidak punya izin buka halaman** (`browser: false`, profil "My AI") tetap
   disuruh jadi agent browser.
2. Ditanya *"cek di obrolan kita knpa lambat banget"* — agent **tidak punya instrumen untuk
   mengukur dirinya sendiri**, jadi dia buka halaman, nemu Cloudflare di tab yang tidak
   terkait, dan melaporkan diagnosis jaringan. Empat kalimat soal halaman menghasilkan
   jawaban yang yakin untuk pertanyaan yang tidak punya aksesnya.
3. Sheet-nya tertinggal di 8 tool engine vs 2 tool browser. **Bukan kekurangan alat.**
   Alatnya cukup. Yang元宵guidance-nya yang salah.

Jadi kalimat itu bukan deskripsi — itu **instruksi untuk salah alat**.

## Nama yang tampil bukan cuma teks

Rename pertama bilang "selesai" dua kali, dan dua-duanya **salah**, karena
cekingnya membaca tempat yang salah. Yang terlewat bukan cuma `git clone
browser-automation` di README dan `aria-label="O Browser"` di panel chat — yang
terlewat adalah **hurufnya**.

Mark di panel chat bukan teks. Itu wordmark **piksel 5×7** yang dibangun dari
~100 `<rect>`:

```
.###.  ####.  ####.  .###.  #...#  .####  #####  ####.
#####  #####  #####  #####  #...#  #....  #....  #####
#...#  #...#  #...#  #...#  #...#  #....  #....  #...#
#...#  ####.  ####.  #...#  #...#  .###.  ####.  ####.
#...#  #####  #.#..  #...#  #...#  ....#  #....  #.#..
#...#  #...#  #..#.  #...#  #.#.#  ....#  #....  #..#.
.###.  ####.  #...#  .###.  .###.  ####.  #####  #...#
   O      B      R      O      W      S      E      R
```

`aria-label` gw ganti ke "O Agent". Screen reader ikut benar. **Orang yang
menatap layar tetap lihat O BROWSER** — karena yang dil efectivas adalah 121
piksel, bukan satu atribut.

Jadi aturannya, dan ini yang bikin dua rename lolos:

> **Kalau yang dilihat manusia adalah gambar, cek gambarnya. Bukan `alt`, bukan
> `aria-label`, bukan nama file.**

Aturan turunannya: sebuah check yang tidak pernah terlihat gagal **belum
merupakan check**. `test/wordmark.test.js` membaca bitmap-nya, mengenali
hurufnya lewat font 5×7, dan menampilkan tabelnya di output — supaya kalau
sekarang ia diam, itu karena memang tidak salah, bukan karena tidak melihat.

Generator yang menulis mark itu juga menolak menulis sebelum bisa **menyalin
ulang mark lama persis** (16/121/18 piksel, viewBox 49). Aturan recovered-nya
satu-satunya yang cocok ke delapan huruf yang ada: *tiga piksel tengah dari baris
yang terisi penuh, kecuali baris pertama dan terakhir*. Kalau tidak cocok, ia
menolak — daripada menebak desain.

## Aturannya

**Chrome itu salah satu alat yang mungkin dipakai. Bukan identitas, bukan default, bukan tempat awal.**

Tiga bentuk具体 yang禁止:

| Bentuk | Contoh | Status |
|---|---|---|
| Identitas | "You are a browser automation agent" | **Dihapus** — `ai/agentfiles.js` |
| Instruksi default | "Read the page before you act on it" | **Dihapus** untuk profil tanpa browser — `ai/context.js` |
| Petunjuk alat yang tidak ada | "open one with `browser_tabs`" | **Dihapus** — `ai/context.js` |

## Yang TIDAK boleh diubah

Browser itu **nyata ada** di produk ini. Ada `native-cdp`, ada 10 tool `browser_*`, ada
policy URL Milestone 2A. Menamai ulang itu jadi kebohongan.

Yang boleh dan tidak:

| Boleh diubah | Tidak boleh |
|---|---|
| Kalimat yangandemicdentitas agent | Nama hal yang memang web (`native-cdp`, `browser_navigate`) |
| Label produk di README/title | Fakta teknis: ini memang menjalankan Chrome |
| Alur yang mengasumsikan browser sebagai titik awal | Gate keamanan yang menguji URL |

Kuncinya: **ubah identitas, jangan ubah fakta.** Kalau produk ini besok tidak menjalankan
Chrome sama sekali, identitasnya tetap sama. Itu tandanyaidentity-nya sudah benar.

## Cara menguji

Bukan dengan bertanya "apakah ini deedstinya browser?". Tanya:

> Kalau agent diberi tugas yang **tidak ada hubungannya dengan web**, apakah ada dorongan
> untuk membuka browser?

Kalau jawabannya "ada", kalimat masih bocor di suatu tempat.