# RZ PMS capability integration review

The current implementation and review supersede the earlier proposed capability cache/config/router architecture. Migration 94 only updates the existing variable catalog. There are no new capability tables, cache columns, binding configuration or feature flags. Existing authenticated scoped provider routes resolve v1 variables and opt-in v2 native/master check-in and safe review destinations. Direct-review entry remains unsupported.

See [the final completion report](canonical-reservation-completion.md) and [the v2 wire contract](../integrations/rz-pms/API_CONTRACT_V2.md) for implemented production paths, security, migration ordering, rollback and manual validation.
