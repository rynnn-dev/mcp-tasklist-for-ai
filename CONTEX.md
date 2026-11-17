# CONTEX.md — `moex`: Autonomous Whole-Project Tasklist MCP Server & CLI
# Author: Sepuh-Analyst & Sepuh-Programmer | Date: 2026-11-16
# Status: APPROVED & IMPLEMENTED
# Target Stack: TypeScript 5.9 + Bun 1.3 + `bun:sqlite` + `@modelcontextprotocol/sdk` + Docker (`moex:latest`) | Base Branch: main

---

## 1. Problem Statement & Scope Definition

### 1a. Latar Belakang & Masalah
- **Kondisi Eksisting:** Local AI coding agents (**Claude Code**, **OpenCode**, **Antigravity**) memiliki fitur todo internal yang bersifat *ephemeral* (hilang saat sesi berakhir atau terkena *context compaction*), tidak memiliki validasi graf dependensi (DAG), tidak memverifikasi hasil eksekusi secara aktif (*false completion*), dan rentan mengalami tabrakan file saat menggunakan subagent paralel. Selain itu, pengguna memerlukan cara instalasi satu perintah via bash link berbasis Docker image (`moex:latest`) dengan nama command utama `moex`.
- **Kondisi yang Diharapkan:** Sebuah MCP Server `stdio` + CLI lokal bernama **`moex`** yang dikemas ke dalam Docker image `moex:latest` dan diinstal melalui [`scripts/install.sh`](file:///home/user/Desktop/mcp-tasklist-for-ai/scripts/install.sh) (mengekstrak binary native Linux dari image Docker ke `~/.local/bin/moex`, dengan opsi `--docker-wrapper`). State disimpan di SQLite terpusat pada PC lokal namun dipartisi ketat per proyek melalui konfigurasi `.moex.json` (`project_id` UUID v4).
- **Dampak Bisnis & Risiko Keterlambatan:** Tanpa guardrails aktif (verifikasi command otomatis pada toolchain host, stale lease recovery, deteksi konflik file, dan shared architecture context), eksekusi proyek otonom akan berhenti prematur atau merusak kode antar-subagent; tanpa ekstraksi native binary dari image Docker, *Active Verification Gate* akan gagal menjalankan toolchain non-Bun di host user.

### 1b. Batasan Ruang Lingkup
- **In Scope:**
  - CLI terminal (`moex init`, `moex status`, `moex show`, `moex logs`, `moex projects`, `moex unlock`, `moex serve`, `moex --version`) dengan penanganan idempotent `.gitignore` (hanya meng-update `.gitignore` jika file tersebut sudah ada di root proyek).
  - Penyimpanan SQLite terpusat (`$XDG_DATA_HOME/moex/tasklist.db` atau `~/.local/share/moex/tasklist.db`, override via `MOEX_DB_PATH` / fallback `MCP_TASKLIST_DB_PATH`).
  - Engine DAG (3-color DFS cycle detection + topological execution waves) & *Dynamic Task Splitting* (`blocks_task_ids`).
  - *Smart Atomic Claiming* (`BEGIN IMMEDIATE`, stale lease recovery, file scope conflict detection, context hydration, strict lock ownership, dan 5 strict queue outcomes).
  - *Active Verification Gate* dua tingkat (task `verification_command` + project `default_verification_command`) dengan isolasi process group dan batas timeout.
  - 10 MCP Tools, 2 MCP Resources (`moex://project/*`) & 2 ResourceTemplates (`moex://projects/{project_id}/*`), dan 1 MCP Prompt (`autonomous-workflow`) melalui transport `stdio`.
  - Multi-stage `Dockerfile` (`moex:latest`) + `.dockerignore` + bash installer [`scripts/install.sh`](file:///home/user/Desktop/mcp-tasklist-for-ai/scripts/install.sh).
- **Out of Scope:**
  - Transport jaringan jarak jauh (HTTP/SSE multi-tenant cloud) dan autentikasi OAuth eksternal.
  - Antarmuka pengguna berbasis web (GUI dashboard).

---

## 2. Parameter Kompleksitas, Estimasi Waktu & Biaya Token

- **Kategori Kompleksitas:** Tinggi (Greenfield Autonomous Orchestrator + Concurrency, Subprocess Guardrails, & Docker Native Binary Distribution)
- **Total Skor Kompleksitas:** 85 / 100 (Pilar A + ADR)
- **Estimasi Waktu Pengerjaan:** 7 – 9 Jam Kerja Engineer Senior
- **Proyeksi Pemakaian Token & Biaya Referensi:**
  - Input Token Proyeksi: ~140.000 tokens
  - Output Token Proyeksi: ~42.000 tokens
  - Estimasi Biaya Model (`gemini-3-flash-preview`): ~$0.55 USD

---

## 3. Arsitektur & Skema Database Terverifikasi

### 3a. Tabel yang Terlibat
| Nama Tabel | Engine / Schema | Peran dalam Modul | Status |
| :--- | :--- | :--- | :--- |
| `projects` | SQLite (`bun:sqlite` WAL) | Menyimpan metadata proyek terdaftar dan `shared_context` (blueprint arsitektur & konvensi global) | Terimplementasi |
| `tasks` | SQLite (`bun:sqlite` WAL) | Menyimpan state lifecycle task, kriteria, command verifikasi, file scope, lock lease (`lock_version`), dan handoff notes | Terimplementasi |
| `task_dependencies` | SQLite (`bun:sqlite` WAL) | Menyimpan edge DAG (`task_id` bergantung pada `depends_on_task_id`) per `project_id` | Terimplementasi |
| `task_events` | SQLite (`bun:sqlite` WAL) | Menyimpan jejak audit (created, claimed, suspended, verification_failed, completed, unlocked) | Terimplementasi |

### 3b. Detail Kolom Kunci & Constraints
| Tabel.Kolom | Tipe Data | Nullable | Default | Keterangan / Foreign Key |
| :--- | :--- | :---: | :--- | :--- |
| `projects.project_id` | `TEXT` | NO | PK | UUID v4 dari `.moex.json` proyek |
| `projects.shared_context` | `TEXT` | NO | `'{}'` | JSON (`architecture_summary`, `tech_stack`, `conventions`, `shared_contracts`, `notes`) |
| `projects.last_seq_num` | `INTEGER` | NO | `0` | High-water mark monotonik `seq_num` proyek (anti-tabrakan ID pasca `delete_task`) |
| `tasks.(project_id, id)` | `TEXT, TEXT` | NO | PK | Composite PK (`project_id` + `TASK-<seq_num>`) |
| `tasks.seq_num` | `INTEGER` | NO | - | `UNIQUE(project_id, seq_num)` untuk urutan deterministik |
| `tasks.status` | `TEXT` | NO | `'pending'` | `CHECK (status IN ('pending','in_progress','done','blocked','failed'))` |
| `tasks.priority` | `TEXT` | NO | `'medium'` | `CHECK (priority IN ('critical','high','medium','low'))` |
| `tasks.affected_files` | `TEXT` | NO | `'[]'` | JSON array relative POSIX path (rencana file/dir/glob yang disentuh) |
| `tasks.modified_files` | `TEXT` | NO | `'[]'` | JSON array relative POSIX path (aktual file yang dimodifikasi) |
| `tasks.lock_version` | `INTEGER` | NO | `0` | Token optimistik monotonik pada klaim/reclaim/unlock untuk guard TOCTOU & ownership |
| `tasks.attempt_count` | `INTEGER` | NO | `0` | Bertambah saat verifikasi gagal, stale lease, atau fail/retry |
| `task_dependencies.(project_id, task_id, depends_on_task_id)` | `TEXT` | NO | PK | FK ke `tasks(project_id, id) ON DELETE CASCADE` |
| `task_events.id` | `INTEGER` | NO | `AUTOINCREMENT` | PK urutan audit event |

### 3c. Integritas Data & Query Flow
- Koneksi SQLite wajib mengaktifkan `PRAGMA busy_timeout = 5000;`, `PRAGMA journal_mode = WAL;`, `PRAGMA foreign_keys = ON;`, serta migrasi skema terurut via `PRAGMA user_version` (`CURRENT_SCHEMA_VERSION = 3`).
- Seluruh operasi baca/tulis pada [`TaskRepository`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/storage/task-repository.ts) wajib memfilter `WHERE project_id = ?`.
- Operasi multi-langkah (batch create, dynamic splitting, atomic claiming) dibungkus dalam `BEGIN IMMEDIATE ... COMMIT` melalui [`DatabaseManager.withImmediateTransaction`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/storage/database.ts).
- Eksekusi subprocess pada [`completeTask`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/domain/scheduler.ts) dijalankan dalam **3 fase** (Preflight DB + lock snapshot $\rightarrow$ Subprocess Verifier di luar DB lock dengan auto-heartbeat & `notifications/progress` $\rightarrow$ Re-validasi TOCTOU & Commit DB) agar proses test yang berjalan lama tidak memblokir koneksi SQLite subagent lain.

---

## 4. Alur Kerja Sistem (System & Business Flow)

### 4a. Alur Utama (Happy Path)
1. **Instalasi & Inisialisasi:** User menjalankan `curl -fsSL https://raw.githubusercontent.com/rynnn-dev/mcp-tasklist-for-ai/main/scripts/install.sh | bash` ([`scripts/install.sh`](file:///home/user/Desktop/mcp-tasklist-for-ai/scripts/install.sh)) yang menarik image `moex:latest` lalu mengekstrak `/usr/local/bin/moex` ke `~/.local/bin/moex` (atau `--host-build` via Bun lokal). Kemudian user atau AI menjalankan `moex init` di root proyek target untuk membuat `.moex.json`, meng-update `.gitignore` (bila ada), dan mendaftarkan proyek ke `tasklist.db`.
2. **Penetapan Konteks & Perencanaan DAG:** AI Agent memanggil `set_project_context` lalu `create_tasks` untuk menyusun graf task lengkap beserta `depends_on`, `affected_files`, `acceptance_criteria`, dan `verification_command`.
3. **Klaim Atomik & Hidrasi Konteks:** AI Agent memanggil `claim_next_task`. Scheduler memulihkan task stale, memfilter task `pending` unblocked, melewati kandidat dengan irisan `affected_files` (file, direktori, atau glob) terhadap task aktif, mengunci kandidat prioritas tertinggi, dan mengembalikan `project_shared_context` + `prerequisite_handoffs`.
4. **Eksekusi & Mutasi Dinamis:** Agent memperbarui progres (`update_task`), melepas lock untuk handoff (`release_claim`), atau menyisipkan sub-task prasyarat (`create_tasks` dengan `blocks_task_ids`) yang otomatis men-suspend task `in_progress` target ke `pending`.
5. **Active Verification Gate & Penyelesaian:** `complete_task` menjalankan `verification_command` task dan `default_verification_command` proyek di host (POSIX `sh` atau Windows `cmd.exe`). Jika lulus, task ditandai `done` dan task hilir terbuka hingga `PROJECT_COMPLETED`.

### 4b. Matriks Penanganan Kondisi Error & Edge Cases
| Skenario Kegagalan / Edge Case | Deteksi Sistem | Tindakan Sistem | Kode / Respon Error |
| :--- | :--- | :--- | :--- |
| Proyek belum di-`init` (`.moex.json` tidak ada) | `resolveProjectConfig` berhenti di batas `.git` / root | Menolak operasi dan menyertakan instruksi `moex init` | `PROJECT_NOT_INITIALIZED` |
| `init` dipanggil ulang tanpa `--new`/`--force` | File `.moex.json` sudah ada | Menolak penimpaan agar `project_id` lama tetap aman | `PROJECT_ALREADY_INITIALIZED` |
| Circular dependency saat mutasi graf | DFS 3-warna menemukan node `VISITING` | Rollback transaksi SQLite dan kembalikan jejak siklus | `CYCLE_DETECTED` |
| Subagent crash / hang melewati `lease_timeout_minutes` | `now - (heartbeat_at ?? claimed_at) >= lease_timeout` | Naikkan `attempt_count`; reclaim ke `pending` atau `failed` jika mencapai `max_attempts` | `TASK_STALE_RECLAIMED` / `TASK_STALE_FAILED` |
| Irisan `affected_files` antar subagent paralel | File/dir/glob overlap dengan task `in_progress` aktif | Skip kandidat tersebut atau kembalikan status tunggu | `WAITING_ON_ACTIVE_TASKS` |
| Command verifikasi gagal / timeout | `runVerificationGate` exit $\neq 0$ atau kill process group | Commit `attempt_count` + log error dulu sebelum melempar error | `VERIFICATION_FAILED` |

---

## 5. Kontrak Antarmuka & API

### 5a. CLI Subcommands (`moex`)
- `moex init [--dir <path>] [--name <name>] [--config <file>] [--verify-cmd <cmd>] [--no-auto-verify] [--verify-timeout <ms>] [--max-attempts <n>] [--lease-minutes <n>] [--no-require-note] [--new] [--force]`
- `moex status [--dir <path>] [--config <file>] [--json]`
- `moex show [<task-id> | --task <id>] [--dir <path>] [--config <file>] [--json]`
- `moex logs [--dir <path>] [--config <file>] [--task <id>] [--limit <n>] [--json]`
- `moex projects [--prune] [--json]`
- `moex unlock [--dir <path>] [--config <file>] (--task <id> | --all-stale | --all) [--json]`
- `moex [serve] [--project-dir <path>] [--config <file>]`
- `moex --version` / `-v`

### 5b. Kontrak 10 MCP Tools, Resources, & Prompt (`stdio`)
- **Tools:** `set_project_context`, `create_tasks`, `list_tasks`, `get_task_detail`, `claim_next_task`, `update_task` (termasuk `release_claim` & `agent_id`), `complete_task` (dengan `notifications/progress`), `block_or_fail_task`, `delete_task`, `get_project_summary` (termasuk `recent_events`).
- **Resources & ResourceTemplates:** `moex://project/summary`, `moex://project/context`, `moex://projects/{project_id}/summary`, `moex://projects/{project_id}/context`.
- **Prompt:** `autonomous-workflow`.

---

## 6. Peta Dampak Teknis (Dependency Map & Blast Radius)

| Berkas / Komponen Target | Tipe | Peran & Dampak | Risiko Regresi |
| :--- | :---: | :--- | :--- |
| [`src/types.ts`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/types.ts) | Core | `MOEX_VERSION`, domain types, Zod schemas, `TasklistError` | Rendah |
| [`src/config/project-config.ts`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/config/project-config.ts) | Core | Resolusi `.moex.json`, `.gitignore` guard, path normalizer | Sedang |
| [`src/storage/database.ts`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/storage/database.ts) | Core | DB terpusat `~/.local/share/moex/tasklist.db` (`MOEX_DB_PATH`) | Tinggi |
| [`src/storage/task-repository.ts`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/storage/task-repository.ts) | Core | Query SQL terpartisi `project_id` | Tinggi |
| [`src/domain/dag.ts`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/domain/dag.ts) | Core | Cycle detection & topological waves | Sedang |
| [`src/domain/verifier.ts`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/domain/verifier.ts) | Core | Active Verification Gate & process group kill | Tinggi |
| [`src/domain/scheduler.ts`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/domain/scheduler.ts) | Core | Autonomous scheduler engine | Tinggi |
| [`src/mcp/server.ts`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/mcp/server.ts) | Interface | Registrasi server `"moex"`, 10 tools, `moex://` resources, prompt | Sedang |
| [`src/cli/index.ts`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/cli/index.ts) & [`src/index.ts`](file:///home/user/Desktop/mcp-tasklist-for-ai/src/index.ts) | Interface | Entrypoint binary `moex` (`init`, `status`, `show`, `logs`, `projects`, `unlock`, `serve`, `--version`) | Rendah |
| [`Dockerfile`](file:///home/user/Desktop/mcp-tasklist-for-ai/Dockerfile), [`.dockerignore`](file:///home/user/Desktop/mcp-tasklist-for-ai/.dockerignore), [`scripts/install.sh`](file:///home/user/Desktop/mcp-tasklist-for-ai/scripts/install.sh) | Infra | Build image `moex:latest` (Debian glibc) & bash installer native | Sedang |

---

## 7. Analisis Risiko & Keputusan Desain (ADR)

### 7a. Mitigasi Risiko Teknis
| Risiko Teknis | Dampak | Strategi Pencegahan / Mitigasi |
| :--- | :---: | :--- |
| Ketidakcocokan ABI `musl` vs `glibc` pada native binary dari Docker | Tinggi | Stage builder wajib memakai `oven/bun:1.3.14-slim` (Debian glibc), bukan Alpine (`musl`) |
| Binary compiled membaca `.env` repo target secara tidak sengaja | Sedang | Kompilasi `bun build --compile` memakai `--no-compile-autoload-dotenv --no-compile-autoload-bunfig` |
| Rollback `attempt_count` saat verifikasi gagal | Tinggi | Commit kegagalan di Fase 3 sebelum melempar `TasklistError("VERIFICATION_FAILED")` |
| Grandchild process menahan pipe `stdout`/`stderr` saat timeout | Tinggi | `detached: true` + `process.kill(-child.pid, signal)` |
| Korupsi JSON-RPC `stdio` | Tinggi | Seluruh log diarahkan ke `process.stderr.write` (`[moex]`) |

### 7b. Keputusan Arsitektur Kunci
- **Masalah Desain:** Bagaimana menyederhanakan instalasi user lewat Docker image + satu command bash agar command `moex` langsung tersedia, namun *Active Verification Gate* tetap bisa menjalankan compiler/test runner proyek non-Bun milik host?
- **Pendekatan yang Dipilih:** **Docker Image (`moex:latest`) sebagai Distribusi Native Binary + Bash Installer ([`scripts/install.sh`](file:///home/user/Desktop/mcp-tasklist-for-ai/scripts/install.sh))**. `Dockerfile` mengompilasi single executable `/usr/local/bin/moex` pada basis glibc; `install.sh` menarik `moex:latest` dan mengekstraknya ke `~/.local/bin/moex` (dengan fallback `--docker-wrapper` untuk OS non-Linux).
- **Alternatif yang Ditolak:** Memaksa seluruh eksekusi `moex` selalu berjalan melalui `docker run` di Linux (gagal menjalankan `pytest`/`cargo`/`go` milik host saat verifikasi dan menambah kompleksitas bind-mount path).

---

## 8. Kriteria Penerimaan (Acceptance Criteria)

- [x] `moex init` membuat `.moex.json` dengan UUID v4 unik, menolak overwrite tanpa `--new`/`--force`, dan hanya menambahkan `.moex.json` ke `.gitignore` jika `.gitignore` sudah ada.
- [x] Semua MCP tools menolak proyek yang belum di-`init` dengan `PROJECT_NOT_INITIALIZED` dan instruksi `moex init`.
- [x] Multi-proyek (clone terpisah maupun `--config` di direktori sama) terisolasi penuh.
- [x] Cycle detection, dynamic task splitting (`blocks_task_ids`), stale lease recovery, file scope conflict detection, dan Active Verification Gate lolos pengujian otomatis.
- [x] Image Docker `moex:latest` berhasil di-build, dan binary native `/usr/local/bin/moex` yang diekstrak oleh `scripts/install.sh` berfungsi penuh (`moex --version`, `moex init`, `moex status`, `moex serve` via `stdio`).
- [x] `bun run typecheck` dan `bun test` lulus 100%.

---

## 9. Referensi & Grounding Bukti
- **Berkas Lokal Terverifikasi:** [`package.json`](file:///home/user/Desktop/mcp-tasklist-for-ai/package.json), [`Dockerfile`](file:///home/user/Desktop/mcp-tasklist-for-ai/Dockerfile), [`scripts/install.sh`](file:///home/user/Desktop/mcp-tasklist-for-ai/scripts/install.sh), [`src/`](file:///home/user/Desktop/mcp-tasklist-for-ai/src), [`tests/`](file:///home/user/Desktop/mcp-tasklist-for-ai/tests).
- **Memori Intranet (Uteke):** Namespace `mcp-tasklist-for-ai` (ID `01a1e291-9c0c-7066-8052-57b87467e112`).
