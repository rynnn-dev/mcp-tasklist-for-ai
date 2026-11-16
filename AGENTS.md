# AGENTS.md — AI Agent Development Guide (`moex` / `mcp-tasklist-for-ai`)

Dokumen ini adalah panduan operasional wajib bagi seluruh AI Coding Agents (**Claude Code**, **OpenCode**, **Antigravity**) serta agen spesialis di [`.agents/agents/`](file:///home/user/Desktop/mcp-tasklist-for-ai/.agents/agents) ([`Sepuh-Analyst.md`](file:///home/user/Desktop/mcp-tasklist-for-ai/.agents/agents/Sepuh-Analyst.md), [`Sepuh-Programmer.md`](file:///home/user/Desktop/mcp-tasklist-for-ai/.agents/agents/Sepuh-Programmer.md), [`Sepuh-QE.md`](file:///home/user/Desktop/mcp-tasklist-for-ai/.agents/agents/Sepuh-QE.md)) saat memodifikasi atau mengembangkan repositori **`moex`** ke depannya.

---

## 1. Tech Stack & Runtime Environment

- **Brand & Binary Utama:** **`moex`** (dikompilasi ke standalone binary melalui `bun build --compile` di dalam image Docker `moex:latest` dan diinstal via [`scripts/install.sh`](file:///home/user/Desktop/mcp-tasklist-for-ai/scripts/install.sh)).
- **Runtime & Package Manager Development:** **Bun** (`/home/user/.bun/bin/bun`, `v1.3.14+`). Jangan gunakan `npm`/`yarn` untuk menginstal dependensi baru agar `bun.lock` tetap konsisten.
- **Bahasa & Tipe:** **TypeScript 5.9+** (`strict: true`, `noUncheckedIndexedAccess: true`, `allowImportingTsExtensions: true`, `noEmit: true` di [`tsconfig.json`](file:///home/user/Desktop/mcp-tasklist-for-ai/tsconfig.json)).
- **Database Engine:** Built-in **`bun:sqlite`** (SQLite `3.53+`). **Dilarang** menambahkan library native C++ eksternal seperti `better-sqlite3` atau `sqlite3` karena akan merusak kompilasi single binary `bun build --compile`.
- **Protokol & Validasi:** `@modelcontextprotocol/sdk` (transport `stdio` & `InMemoryTransport`) + `zod`.
- **Docker Base Image:** Wajib menggunakan basis **Debian `glibc`** (`oven/bun:1.3.14-slim` $\rightarrow$ `debian:bookworm-slim`), **bukan** Alpine (`musl`), agar binary native hasil ekstraksi berjalan di seluruh distro Linux modern.
- **Uteke Memory Namespace:** `mcp-tasklist-for-ai` (Memory ID baseline: `01a1e291-9c0c-7066-8052-57b87467e112`).

---

## 2. Peta Direktori & Tanggung Jawab Modul

```text
/home/user/Desktop/mcp-tasklist-for-ai
├── CONTEX.md                     # Single Source of Truth spesifikasi kontrak & ADR
├── TASK.md                       # Spesifikasi teknis skema DB, state machine, & kontrak tool
├── AGENTS.md                     # Panduan kerja AI Agent untuk pengembangan repo ini
├── README.md                     # Dokumentasi pengguna, bash installer, & konfigurasi client MCP
├── Dockerfile                    # Multi-stage glibc build menghasilkan binary /usr/local/bin/moex
├── .dockerignore                 # Pengecualian context Docker build
├── scripts/
│   └── install.sh                # Bash installer (pull/build moex:latest & ekstrak binary native)
├── src/
│   ├── index.ts                  # Entrypoint utama (shebang Bun, routing CLI vs MCP stdio)
│   ├── types.ts                  # MOEX_VERSION, tipe domain, skema Zod, & TasklistError
│   ├── cli/
│   │   └── index.ts              # Parser & handler CLI (init, status, unlock, serve, --version)
│   ├── config/
│   │   └── project-config.ts     # Resolusi .moex.json, atomic write, .gitignore guard, path normalizer
│   ├── storage/
│   │   ├── database.ts           # Koneksi bun:sqlite (~/.local/share/moex/tasklist.db), WAL, transaksi
│   │   └── task-repository.ts    # Query SQL terpartisi per project_id, dependency edges, & task_events
│   ├── domain/
│   │   ├── dag.ts                # Validasi anti-cycle (3-color DFS) & topological execution waves
│   │   ├── verifier.ts           # Active Verification Gate runner (detached process group & timeout kill)
│   │   └── scheduler.ts          # Engine otonom (claiming, stale recovery, file lock, dynamic split)
│   └── mcp/
│       └── server.ts             # Registrasi server "moex": 10 Tools, 2 Resources (moex://), & 1 Prompt
└── tests/
    ├── cli-init.test.ts          # Pengujian CLI init (.moex.json), --version, .gitignore, & upward traversal
    ├── scheduler-dag.test.ts     # Pengujian isolasi multi-proyek, DAG, shared context, & task splitting
    ├── autonomous-guards.test.ts # Pengujian Active Verification Gate, timeout kill, stale, & file locks
    └── mcp-server.test.ts        # Pengujian E2E MCP protocol (InMemoryTransport & StdioClientTransport)
```

---

## 3. Aturan Emas Arsitektur (Non-Negotiable Invariants)

Setiap perubahan kode di masa depan **WAJIB** mematuhi 7 invarian berikut:

1. **Kemurnian Stream `stdout` pada Mode MCP (`stdio`):**
   - Di dalam [`src/mcp/`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/mcp/server.ts), [`src/domain/`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/domain/scheduler.ts), [`src/storage/`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/storage/database.ts), dan [`src/config/`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/config/project-config.ts), **DILARANG KERAS** memanggil `console.log(...)` karena `stdout` dipakai secara eksklusif oleh frame JSON-RPC MCP.
   - Gunakan `process.stderr.write(...)` dengan prefix `[moex]` untuk seluruh kebutuhan logging diagnostik server. (`console.log` hanya boleh ada di [`src/cli/index.ts`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/cli/index.ts) saat menjalankan subcommand terminal `init`, `status`, `unlock`, `--version`, atau `--help`).
2. **Isolasi Ketat `project_id` & Larangan Auto-Init Global:**
   - Setiap tabel dan query di [`src/storage/task-repository.ts`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/storage/task-repository.ts) wajib memfilter berdasarkan `project_id` (UUID v4 dari `.moex.json`).
   - Jangan pernah membuat fitur yang menginisialisasi `.moex.json` secara diam-diam di `$HOME` atau direktori acak. Inisialisasi proyek baru wajib melalui CLI `moex init`.
   - Upward directory traversal di [`resolveProjectConfig`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/config/project-config.ts) wajib berhenti ketika menemui batas `.git` root agar proyek yang belum di-`init` tidak bocor memakai `.moex.json` milik folder induk di luar repo.
3. **Aturan `.gitignore` Saat `init`:**
   - Fungsi [`ensureGitignoreEntry`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/config/project-config.ts) **hanya boleh** menambahkan entry konfigurasi (`.moex.json`) jika file `.gitignore` **memang sudah ada** di root proyek target. Dilarang membuat file `.gitignore` baru jika proyek target belum memilikinya.
4. **Transaksi Dua Fase pada *Active Verification Gate* (`completeTask`):**
   - **Dilarang** menjalankan subprocess verifikasi ([`runVerificationGate`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/domain/verifier.ts)) di dalam blok `withTransaction` (`BEGIN IMMEDIATE`), karena proses test yang berjalan puluhan detik akan memblokir akses tulis SQLite bagi subagent lain.
   - Pada Fase 3 [`completeTask`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/domain/scheduler.ts), ketika verifikasi gagal (`!verification.passed`), **commit terlebih dahulu** kenaikan `attempt_count`, `last_verification_output`, dan event `VERIFICATION_FAILED` hingga transaksi selesai, baru lempar `TasklistError("VERIFICATION_FAILED")` di luar `withTransaction`.
5. **Isolasi Process Group pada Subprocess Verifikasi:**
   - Di [`src/domain/verifier.ts`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/domain/verifier.ts), eksekusi shell command wajib menggunakan `detached: true` (pada sistem POSIX) dan mematikan seluruh process group (`process.kill(-child.pid, signal)`) saat timeout agar proses anak/cucu tidak menahan pipe `stdout`/`stderr` tetap terbuka.
6. **Keamanan Parameter SQL, Path, & Binary Compile:**
   - Seluruh query SQLite wajib menggunakan *parameterized binding* (`?`).
   - Seluruh input path file (`affected_files`, `modified_files`) wajib dinormalisasi melalui [`normalizeRepoPaths`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/config/project-config.ts) untuk menolak path traversal (`..`) di luar root proyek.
   - Kompilasi binary (`package.json` `build:bin` dan `Dockerfile`) **wajib** menyertakan `--no-compile-autoload-dotenv --no-compile-autoload-bunfig` agar binary `moex` tidak memuat `.env` milik proyek target secara tidak sengaja, serta dilarang mengimpor `package.json` secara langsung agar versi (`MOEX_VERSION`) tetap konsisten.
7. **Sinkronisasi Versi:**
   - Setiap rilis baru wajib menyamakan versi di [`package.json`](file:///home/user/Desktop/mcp-tasklist-for-ai/package.json) dan `MOEX_VERSION` di [`src/types.ts`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/types.ts).

---

## 4. Perintah Verifikasi & Pengujian (Mandatory Gate)

Sebelum menyatakan perubahan atau fitur baru selesai, selalu jalankan perintah verifikasi berikut:

```bash
# 1. Validasi tipe TypeScript secara menyeluruh
bun run typecheck

# 2. Jalankan seluruh unit, guardrail, CLI, dan E2E MCP test suite
bun test

# 3. (Jika mengubah Dockerfile, install.sh, atau build flags) Validasi build & ekstraksi binary
docker build -t moex:latest .
```

**Aturan Penulisan Test Baru di `tests/`:**
- Selalu arahkan `process.env.MOEX_DB_PATH` (atau parameter konstruktor `new DatabaseManager(dbPath)`) ke file database sementara di dalam `os.tmpdir()` pada `beforeEach`, dan bersihkan direktori sementara tersebut pada `afterEach` agar test tidak pernah menyentuh database produksi di `~/.local/share/moex/tasklist.db`.

---

## 5. Alur Kerja Agen (`Sepuh` Ecosystem)

Saat bekerja menggunakan agen di [`.agents/agents/`](file:///home/user/Desktop/mcp-tasklist-for-ai/.agents/agents):
1. **Perubahan Arsitektur / Fitur Baru Kompleks:**
   - Gunakan **`Sepuh-Analyst`** untuk memvalidasi kebutuhan dan memperbarui kontrak di [`CONTEX.md`](file:///home/user/Desktop/mcp-tasklist-for-ai/CONTEX.md).
2. **Implementasi Teknis & Bug Fix:**
   - Gunakan **`Sepuh-Programmer`** yang akan membaca [`CONTEX.md`](file:///home/user/Desktop/mcp-tasklist-for-ai/CONTEX.md) & [`TASK.md`](file:///home/user/Desktop/mcp-tasklist-for-ai/TASK.md), menyusun *Technical Execution Map* / *Execution Plan*, melakukan *Git Safety Checkpoint*, mengeksekusi perubahan, dan memverifikasi via `bun run typecheck && bun test`.
3. **Penyimpanan Pengetahuan (Uteke):**
   - Setiap kali ada keputusan arsitektur baru atau temuan bug non-trivial, simpan ke Uteke menggunakan namespace `mcp-tasklist-for-ai`.
