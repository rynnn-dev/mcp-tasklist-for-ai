# moex

**`moex`** — Autonomous Whole-Project Tasklist MCP Server & CLI berbasis **TypeScript + Bun + `bun:sqlite`**, dirancang khusus untuk local AI coding agents (**Claude Code**, **OpenCode**, **Antigravity**) melalui transport `stdio`.

---

## Instalasi Cepat (Docker Image + Bash Installer)

User cukup menjalankan satu perintah bash untuk menginstal command **`moex`** (secara default mengekstrak native binary dari Docker image `--image` / `moex:latest`, atau otomatis memakai wrapper Docker pada macOS):

```bash
# Jika mengembangkan / build image langsung dari repositori lokal:
./scripts/install.sh --local

# Atau ekstrak dari image Docker lokal tanpa pull registry:
./scripts/install.sh --no-pull

# Atau tarik dari image registry yang dipublikasikan (--image):
curl -fsSL https://raw.githubusercontent.com/rynnn-dev/mcp-tasklist-for-ai/main/scripts/install.sh | bash -s -- --image <registry/moex:tag>
```

> **Catatan:** Image default `moex:latest` adalah tag lokal. Tanpa image yang sudah tersedia di Docker lokal (`--local` / `docker build`) atau tag registry via `--image`, `docker pull moex:latest` akan gagal bila tidak ada image terpublikasi.

Opsi installer yang tersedia (`./scripts/install.sh --help`):
- `--image <name:tag>`: Mengambil dari image Docker tertentu (default: `moex:latest`).
- `--bin-dir <path>` / `--system`: Memilih lokasi binary (default: `~/.local/bin`, `--system` ke `/usr/local/bin`).
- `--local`: Build image `moex:latest` langsung dari `Dockerfile` lokal sebelum instalasi (atau otomatis compile native di macOS jika Bun & repo lokal tersedia).
- `--no-pull`: Melewati `docker pull` dan memakai image Docker yang sudah ada secara lokal.
- `--host-build`: Kompilasi binary native langsung di host menggunakan Bun lokal tanpa Docker (tidak bisa digabung dengan `--local`/`--no-pull`/`--image`).
- `--docker-wrapper`: Memasang skrip wrapper `docker run` alih-alih mengekstrak native binary.

Pastikan `~/.local/bin` terdaftar di `$PATH` kamu (misalnya `export PATH="$HOME/.local/bin:$PATH"`).

---

## Arsitektur Hybrid (Centralized DB + Per-Project `.moex.json`)

1. **Database Terpusat di PC Lokal:**
   - Disimpan di `$XDG_DATA_HOME/moex/tasklist.db` (default `~/.local/share/moex/tasklist.db`, bisa di-override via `MOEX_DB_PATH`).
   - Menggunakan SQLite `WAL` mode, `foreign_keys = ON`, `PRAGMA user_version` migrations (`v3`), dan transaksi `BEGIN IMMEDIATE` agar aman diakses paralel oleh banyak subagent.
2. **Konfigurasi Lokal Per-Proyek (`.moex.json`):**
   - Tidak ada auto-init global. Setiap proyek wajib diinisialisasi per direktori lewat terminal (`moex init`).
   - Setiap proyek dipartisi oleh `project_id` (UUID v4), sehingga dua clone atau `git worktree` dari repo yang sama tidak pernah bentrok.
   - Jika `.gitignore` **sudah ada** di root proyek saat `init`, nama file `.moex.json` otomatis ditambahkan secara idempotent (tidak membuat `.gitignore` baru bila belum ada).

---

## Fitur Otonomi Utama (Autonomous Guardrails)

- **Active Verification Gate (`complete_task`):** Menjalankan sendiri `verification_command` task dan `default_verification_command` proyek (two-tier baseline) dengan isolasi process group, timeout, auto-heartbeat lease, `lock_version` guard, serta `notifications/progress` MCP. Karena binary `moex` berjalan native di host, seluruh toolchain proyek (Bun, Node, Python, Go, Rust, PHP, dll.) dapat langsung dieksekusi oleh verifier.
- **Stale Lease Recovery:** Task `in_progress` yang melewati `lease_timeout_minutes` tanpa heartbeat otomatis direclaim pada pemanggilan `claim_next_task` berikutnya sambil mewarisi `handoff_notes`.
- **File Scope Conflict Detection:** Mencegah 2 subagent paralel menimpa file, direktori, maupun pola glob yang saling beririsan (`affected_files` / `modified_files`).
- **Project Shared Memory (`set_project_context`):** Menyimpan `architecture_summary`, `tech_stack`, `conventions`, dan `shared_contracts` agar tidak terjadi *context amnesia* setelah compaction.
- **Dynamic Graph Mutation (`blocks_task_ids`):** Menyisipkan sub-task prasyarat di tengah eksekusi dan otomatis men-suspend task `in_progress` terkait kembali ke `pending` (dilengkapi validasi DAG anti-cycle).
- **Strict Queue Outcomes:** `TASK_CLAIMED`, `WAITING_ON_ACTIVE_TASKS`, `BLOCKED_BY_FAILURES`, `PROJECT_COMPLETED`, atau `NO_TASKS_PLANNED`.

---

## Penggunaan CLI Terminal

### 1. Inisialisasi Proyek Target (Wajib Per Proyek)
Masuk ke root direktori proyek target (atau gunakan `--dir`):

```bash
moex init \
  --dir /path/to/your-project \
  --name "my-app" \
  --verify-cmd "bun test && bun run typecheck" \
  --max-attempts 3 \
  --lease-minutes 30
```

Opsi penting:
- `--new`: Membuat `project_id` UUID baru yang terpisah meskipun `.moex.json` sudah ada.
- `--force`: Memperbarui pengaturan di `.moex.json` sambil tetap mempertahankan `project_id` lama.
- `--config <filename>`: Menggunakan file config custom (misal `.moex.backend.json`) untuk memisahkan 2 inisiatif tasklist di direktori yang sama.

### 2. Cek Status, Detail Task, Audit Logs, Unlock, & Manajemen Proyek
```bash
moex --version
moex status --dir /path/to/your-project
moex status --dir /path/to/your-project --json
moex show TASK-1 --dir /path/to/your-project
moex logs --dir /path/to/your-project --limit 20
moex projects
moex projects --prune
moex unlock --dir /path/to/your-project --all-stale
moex unlock --dir /path/to/your-project --all --json
moex unlock --dir /path/to/your-project --task TASK-3
```

---

## Konfigurasi Client AI Agent

> Gunakan path penuh ke binary `moex` (misal `/home/user/.local/bin/moex` atau `/usr/local/bin/moex`) agar GUI/daemon launcher selalu menemukannya meskipun tidak memuat `.bashrc`.

### 1. Claude Code (`~/.claude.json` atau `.mcp.json`)
```json
{
  "mcpServers": {
    "moex": {
      "command": "/home/user/.local/bin/moex",
      "args": ["serve"]
    }
  }
}
```

### 2. OpenCode (`~/.config/opencode/opencode.json` atau `opencode.json`)
```json
{
  "mcp": {
    "moex": {
      "type": "local",
      "command": ["/home/user/.local/bin/moex", "serve"],
      "enabled": true
    }
  }
}
```

### 3. Antigravity (`mcp_config.json`)
```json
{
  "mcpServers": {
    "moex": {
      "command": "/home/user/.local/bin/moex",
      "args": ["serve"]
    }
  }
}
```

*(Opsional: tambahkan `"--project-dir", "/path/to/proyek"` di `args` jika ingin mengunci server pada satu proyek spesifik tanpa perlu mengirim `project_path` di setiap tool call.)*

---

## Daftar MCP Tools, Resources, & Prompts

- **10 MCP Tools:** `set_project_context`, `create_tasks`, `list_tasks`, `get_task_detail`, `claim_next_task`, `update_task`, `complete_task`, `block_or_fail_task`, `delete_task`, `get_project_summary`.
- **2 MCP Resources & 2 ResourceTemplates:** `moex://project/summary`, `moex://project/context`, `moex://projects/{project_id}/summary`, `moex://projects/{project_id}/context`.
- **1 MCP Prompt:** `autonomous-workflow` (SOP eksekusi otonom menyeluruh untuk AI Agent).

### Contoh Prompt Otonom untuk AI Agent
> *"Gunakan MCP prompt `autonomous-workflow` dari server `moex` pada `project_path` `/path/to/your-project` untuk membangun [deskripsi aplikasi] sampai `claim_next_task` mengembalikan `PROJECT_COMPLETED`."*

---

## Build Docker Image & Development (Maintainer)

```bash
bun install
bun run typecheck
bun test
docker build -t moex:latest .
```
