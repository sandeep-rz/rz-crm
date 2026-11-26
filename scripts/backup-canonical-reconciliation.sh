#!/usr/bin/env bash
# Operator-run, read-only database backup. Credentials use normal libpq env/.pgpass.
# Run with workers/writers paused; choose an encrypted/private backup destination.
set -euo pipefail
umask 077
if [[ $# -ne 1 || -e "$1" ]]; then
  echo 'Usage: backup-canonical-reconciliation.sh NEW_PRIVATE_DIRECTORY' >&2
  exit 2
fi
for executable in pg_dump pg_restore python3; do
  command -v "$executable" >/dev/null || { echo "Missing executable: $executable" >&2; exit 2; }
done
backup_dir=$1
mkdir -m 700 -- "$backup_dir"
pg_dump --format=custom --no-owner --no-privileges --file="$backup_dir/database.dump.partial"
pg_restore --list "$backup_dir/database.dump.partial" > "$backup_dir/archive-toc.txt"
python3 - "$backup_dir" <<'PY'
from pathlib import Path
import hashlib,json,sys
from datetime import datetime,timezone
root=Path(sys.argv[1]);archive=root/'database.dump.partial'
required=['pms_reservations','automation_trigger_jobs','automation_logs','automation_pending_executions',
          'contacts','pms_contact_external_identities','pms_integrations','pms_properties','pms_webhook_events']
toc=(root/'archive-toc.txt').read_text()
missing=[name for name in required if f'TABLE DATA public {name} ' not in toc]
if missing: raise SystemExit('Backup missing required table data: '+', '.join(missing))
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''): h.update(block)
 return h.hexdigest()
first=digest(archive);archive.rename(root/'database.dump')
if digest(root/'database.dump')!=first: raise SystemExit('Backup checksum verification failed')
manifest={'created_at':datetime.now(timezone.utc).isoformat(),'archive':'database.dump','sha256':first,
          'bytes':(root/'database.dump').stat().st_size,'verified_table_data':required,
          'restore_rehearsal_required':True}
(root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
for p in root.iterdir(): p.chmod(0o600)
print('Private archive, table-data inventory and SHA-256 verified. Restore rehearsal still required.')
PY
