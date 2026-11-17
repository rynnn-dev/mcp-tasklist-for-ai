# TASK.md — `moex`: Autonomous Whole-Project Tasklist MCP Server & CLI

## 1. Tujuan & Ruang Lingkup
Membangun **`moex`** — **MCP (*Model Context Protocol*) Server + CLI** berbasis **TypeScript + Bun + `bun:sqlite`** yang dikemas menjadi Docker image (`moex:latest`) dengan distribusi bash installer ([`scripts/install.sh`](file:///home/user/Desktop/mcp-tasklist-for-ai/scripts/install.sh)) khusus untuk AI coding agents lokal (**Claude Code**, **OpenCode**, **Antigravity**) melalui transport `stdio`.
Aplikasi ini berfungsi sebagai *stateful autonomous orchestrator & guardrails* agar AI Agent mampu merencanakan, mengeksekusi, memverifikasi, dan menyelesaikan proyek pengembangan utuh lintas sesi maupun lintas subagent tanpa bentrok antar-proyek dan tanpa *false completion*.

---

## 2. Arsitektur Hybrid: Centralized SQLite DB + Per-Project `.moex.json` + Docker Native Installer
1. **Database Terpusat (`tasklist.db`):**
   - Lokasi default: `$XDG_DATA_HOME/moex/tasklist.db` (fallback `~/.local/share/moex/tasklist.db`).
   - Dapat di-override melalui environment variable `MOEX_DB_PATH` (dengan fallback `MCP_TASKLIST_DB_PATH`).
   - Engine: `bun:sqlite` dengan `PRAGMA busy_timeout = 5000`, `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, dan migrasi berurut via `PRAGMA user_version = 3`.
2. **Konfigurasi Lokal Per-Proyek (`.moex.json`):**
   - Wajib diinisialisasi per proyek di root direktori melalui CLI terminal `moex init` (dilarang auto-init global secara diam-diam).
   - Apabila file `.gitignore` sudah ada di root proyek saat `init`, entry nama file konfigurasi (`.moex.json`) ditambahkan secara idempotent. Jika `.gitignore` tidak ada, tidak dibuatkan file `.gitignore` baru.
   - Setiap proyek dipartisi secara ketat di DB terpusat menggunakan **`project_id` (UUID v4)** agar dua clone atau worktree dari repo yang sama (atau dua profil di direktori yang sama dengan `--config`) tidak pernah bentrok.
3. **Distribusi Docker Image (`moex:latest`) + Bash Installer (`scripts/install.sh`):**
   - Multi-stage `Dockerfile` (`oven/bun:1.3.14-slim` glibc builder $\rightarrow$ `debian:bookworm-slim` runtime) mengompilasi binary native `/usr/local/bin/moex` dengan `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`.
   - `scripts/install.sh` menarik `moex:latest`, mengekstrak `/usr/local/bin/moex` ke `~/.local/bin/moex` (atau `/usr/local/bin/moex` via `--system`), serta mendukung fallback `--docker-wrapper` pada OS non-Linux.

### Skema `.moex.json`
```json
{
  "version": 1,
  "project_id": "<uuid-v4>",
  "project_name": "my-project",
  "created_at": "2026-11-16T00:00:00.000Z",
  "default_verification_command": null,
  "auto_run_verification": true,
  "verification_timeout_ms": 60000,
  "max_attempts": 3,
  "lease_timeout_minutes": 30,
  "require_verification_note": true
}
```

---

## 3. Skema Database SQLite (`tasklist.db`)
1. **`projects`**
   - `project_id TEXT PRIMARY KEY`
   - `project_name TEXT NOT NULL`
   - `root_path TEXT NOT NULL`
   - `config_path TEXT NOT NULL`
   - `shared_context TEXT NOT NULL DEFAULT '{}'` (JSON: `architecture_summary`, `conventions`, `shared_contracts`, `tech_stack`, `notes`)
   - `last_seq_num INTEGER NOT NULL DEFAULT 0` (high-water mark monotonik `seq_num` per proyek)
   - `created_at TEXT NOT NULL`
   - `updated_at TEXT NOT NULL`
2. **`tasks`**
   - `project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE`
   - `id TEXT NOT NULL` (format deterministik per proyek: `TASK-1`, `TASK-2`, dst.)
   - `seq_num INTEGER NOT NULL`
   - `title TEXT NOT NULL`
   - `description TEXT NOT NULL DEFAULT ''`
   - `category TEXT NOT NULL DEFAULT 'general'`
   - `status TEXT NOT NULL` (`pending` | `in_progress` | `done` | `blocked` | `failed`)
   - `priority TEXT NOT NULL` (`critical` | `high` | `medium` | `low`)
   - `acceptance_criteria TEXT NOT NULL DEFAULT '[]'` (JSON string[])
   - `verification_command TEXT` (nullable)
   - `affected_files TEXT NOT NULL DEFAULT '[]'` (JSON string[] — relative POSIX path/dir/glob)
   - `modified_files TEXT NOT NULL DEFAULT '[]'` (JSON string[] — relative POSIX path)
   - `handoff_notes TEXT NOT NULL DEFAULT ''`
   - `verification_note TEXT NOT NULL DEFAULT ''`
   - `last_verification_output TEXT NOT NULL DEFAULT ''`
   - `claimed_by TEXT` (nullable)
   - `claimed_at TEXT` (nullable)
   - `heartbeat_at TEXT` (nullable)
   - `lock_version INTEGER NOT NULL DEFAULT 0` (token optimistik monotonik pada klaim/reclaim/unlock untuk guard TOCTOU & ownership)
   - `attempt_count INTEGER NOT NULL DEFAULT 0`
   - `blocker_reason TEXT NOT NULL DEFAULT ''`
   - `created_at TEXT NOT NULL`
   - `updated_at TEXT NOT NULL`
   - `completed_at TEXT` (nullable)
   - `PRIMARY KEY (project_id, id)`
   - `UNIQUE (project_id, seq_num)`
3. **`task_dependencies`**
   - `project_id TEXT NOT NULL`
   - `task_id TEXT NOT NULL`
   - `depends_on_task_id TEXT NOT NULL`
   - `PRIMARY KEY (project_id, task_id, depends_on_task_id)`
   - Foreign key ke `tasks(project_id, id)` dengan `ON DELETE CASCADE`.
4. **`task_events`**
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - `project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE`
   - `task_id TEXT`
   - `event_type TEXT NOT NULL`
   - `actor TEXT NOT NULL DEFAULT 'system'`
   - `details TEXT NOT NULL DEFAULT '{}'` (JSON)
   - `created_at TEXT NOT NULL`

---

## 4. Kontrak Autonomous Guardrails & State Machine
1. **Strict Project Initialization Guard:** Semua MCP tool wajib menyelesaikan konfigurasi proyek dari `project_path` (atau CLI fallback `--project-dir` / env `MOEX_PROJECT_DIR` / `cwd`) dengan *upward traversal* aman. Jika file `.moex.json` tidak ditemukan, tool mengembalikan error terstruktur (`PROJECT_NOT_INITIALIZED`) berisi instruksi `moex init`.
2. **DAG & Dynamic Task Splitting (`blocks_task_ids`):**
   - Penolakan *circular dependency* berbasis DFS 3-warna beserta jejak siklus yang jelas.
   - Mendukung penyisipan sub-task prasyarat di tengah eksekusi: jika task target di `blocks_task_ids` sedang berstatus `in_progress`, statusnya otomatis di-suspend kembali ke `pending`, lock dilepas, dan `handoff_notes` diperbarui dalam satu transaksi atomik.
3. **Smart Atomic Claiming (`claim_next_task`):**
   - Transaksi `BEGIN IMMEDIATE` untuk mencegah *double-claim* antar subagent paralel.
   - **Stale Lease Recovery:** Task `in_progress` yang melewati `lease_timeout_minutes` (berdasarkan `heartbeat_at` atau `claimed_at`) otomatis direclaim (`attempt_count + 1`). Jika `attempt_count >= max_attempts`, status berubah ke `failed`; jika belum, task kembali ke antrean kandidat dengan mewarisi `handoff_notes` lama.
   - **Strict Lock Ownership (`update_task`, `block_or_fail_task`, `complete_task`):** Saat task berstatus `in_progress` dengan `claimed_by` aktif, mutasi mewajibkan `agent_id` (atau `actor` untuk `update_task`) yang cocok tepat dengan `claimed_by` (ditolak dengan `TASK_LOCKED` jika kosong atau berbeda, kecuali `update_task(..., reset_to_pending=true)`).
   - **File Scope Conflict Detection:** Kandidat `pending` yang `affected_files`-nya beririsan (eksak, hirarki direktori, maupun wildcard glob) dengan `affected_files ∪ modified_files` milik task lain yang sedang `in_progress` aktif akan di-skip sementara (kecuali `ignore_file_locks: true`).
   - **Context Hydration:** Mengembalikan detail task + `project_shared_context` + `prerequisite_handoffs`.
   - **Strict Queue Outcomes:** `TASK_CLAIMED`, `WAITING_ON_ACTIVE_TASKS`, `BLOCKED_BY_FAILURES`, `PROJECT_COMPLETED`, atau `NO_TASKS_PLANNED`.
4. **Active Verification Gate (`complete_task`):**
   - Wajib berstatus `in_progress` (klaim via `claim_next_task`) dan memvalidasi ownership `claimed_by`, snapshot `lock_version` (`TASK_LOCKED`), serta integritas command/config (`INVALID_STATE_TRANSITION`) di Fase 3 pasca-verifikasi.
   - Menjalankan command verifikasi secara two-tier jika `auto_run_verification` aktif dan command tersedia: task-level `verification_command` (bila ada) dan `default_verification_command` proyek (wajib sebagai baseline, tidak dapat di-bypass oleh agent), sambil menyegarkan `heartbeat_at` dan memancarkan `notifications/progress`.
   - Output `stdout`/`stderr` dibatasi (*tail truncation*) maksimal `8192` karakter; timeout ditegakkan sesuai `verification_timeout_ms`.
   - Jika gagal (`exitCode !== 0` atau `timedOut`): `attempt_count` bertambah `+1`. Jika `attempt_count >= max_attempts`, status menjadi `failed` dan lock dilepas; jika masih di bawah batas, status tetap `in_progress` agar agent dapat memperbaiki lalu mencoba lagi.

---

## 5. Kontrak CLI, MCP Tools, Resources, & Prompts
- **CLI Subcommands (`moex`):**
  - `moex init [--dir <path>] [--name <name>] [--config <file>] [--verify-cmd <cmd>] [--no-auto-verify] [--verify-timeout <ms>] [--max-attempts <n>] [--lease-minutes <n>] [--no-require-note] [--new] [--force]`
  - `moex status [--dir <path>] [--config <file>] [--json]`
  - `moex show [<task-id> | --task <id>] [--dir <path>] [--config <file>] [--json]`
  - `moex logs [--dir <path>] [--config <file>] [--task <id>] [--limit <n>] [--json]`
  - `moex projects [--prune] [--json]`
  - `moex unlock [--dir <path>] [--config <file>] (--task <id> | --all-stale | --all) [--json]`
  - `moex serve [--project-dir <path>] [--config <file>]` (default jika tanpa subcommand)
  - `moex --version` / `-v`
- **10 MCP Tools:** `set_project_context`, `create_tasks`, `list_tasks`, `get_task_detail`, `claim_next_task`, `update_task`, `complete_task`, `block_or_fail_task`, `delete_task`, `get_project_summary`.
- **2 MCP Resources & 2 ResourceTemplates:** `moex://project/summary`, `moex://project/context`, `moex://projects/{project_id}/summary`, `moex://projects/{project_id}/context`.
- **1 MCP Prompt:** `autonomous-workflow`.
