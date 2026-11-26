# Shared reservation architecture

PMS adds one integration-independent reservation_event_state table; CRM adds no permanent tables. The shared producer writes durable lifecycle/version/hash state and the existing domain_events outbox in one transaction. Parent and native read views provide atomic authoritative contexts. Existing inventory/revision RPCs and authentication remain intact.

CRM reuses pms_reservations and the current job/log/continuation infrastructure. Projection/version and scheduling/webhook completion each have a recoverable atomic RPC boundary. Historical aliases preserve reservation IDs, contacts and every job column. Existing gates prevent aliases and ambiguous guests from sending. Backup-only reconciliation storage and unused capability caches/helpers are removed.

See [canonical-reservation-completion.md](canonical-reservation-completion.md) for the final object inventory, full review findings, live-grant justification, static validation limits, ordered migrations, verified operator backups, rollback procedure and manual acceptance checklist. Migrations remain unapplied and runtime tests remain operator-owned.
