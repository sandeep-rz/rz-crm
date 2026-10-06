# Retired property communication data

RGCRM no longer owns, edits, or persists PMS hospitality instructions. The
settings panel and `/api/properties/[id]/communication-settings` endpoint are
removed. Message property context retains only the canonical CRM mapping's ID
and name; contacts, reservations, PMS property mappings, timezones, initial sync,
and the automation/event infrastructure remain intact.

The forward migration `20261006135728_remove_property_communication.sql` drops
`property_communication_settings` and its table-owned policies, grants, trigger,
indexes and foreign keys. It preserves the shared timestamp function and deletes
only these catalog variables:

- `property.map_url`
- `property.checkin_method`
- `property.directions`
- `property.parking_instructions`
- `property.nearby_landmark`
- `property.caretaker_name`
- `property.caretaker_phone`
- `property.emergency_phone`
- `property.wifi_name`
- `property.wifi_password`
- `property.house_manual`
- `property.checkout_instructions`

Existing template/automation mappings are not rewritten or deleted. References
to these keys become unknown catalog variables and use the existing validation
failure path; affected mappings must be reviewed before sending. `property.name`
and the normal contact/reservation/workspace variables remain available.

Provisioning's normalized contract contains only identity, owner, and canonical
property mapping fields. For rolling upgrades, legacy `property.communication`,
`property.communicationSnapshot`, and top-level `communicationSnapshot` inputs
are ignored entirely, regardless of their contents. They are never normalized,
returned, logged or stored; unrelated unknown fields still fail validation.
The provider adapter also ignores extra hospitality response fields.

Deploy the CRM removal before applying the forward migration so old code cannot
query the dropped table. Historical migrations remain unchanged. The migration
uses RESTRICT and must fail if an unexpected dependent object exists rather
than deleting it with CASCADE.

Separately, RZ PMS should remove the one-time communication prefill from its
`provision-property-app` payload builder and stop sending the retired fields.
Its own Arrival Guide/property data stays in the PMS. Runtime hospitality
variable resolution will be designed later through a provider-neutral contract;
this change adds no PMS runtime calls or new variable-resolution architecture.
