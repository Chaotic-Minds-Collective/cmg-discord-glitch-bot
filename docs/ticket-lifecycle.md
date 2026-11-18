# Support ticket lifecycle

Open operations are serialized per guild/user in the single active bot process and recheck Discord channel ownership metadata before creating a channel. Deferred interactions avoid timing out while waiting. Run one active bot instance; this is not a distributed lock.

Closure archives the existing channel rather than deleting support history. It revokes the ticket owner's channel access, records actor/time/reason without mentions, and marks the channel closed by name while preserving ownership metadata and staff access. A failed archive never deletes a channel. Staff should repair partial permission/rename failures before retrying.

Closed channel metadata is read from Discord on retries/restarts. No database or paid storage was added, and no transcript was exported to a public location. Define an approved staff-only retention/deletion policy before any separate cleanup. This draft changed no live channel or permission.
