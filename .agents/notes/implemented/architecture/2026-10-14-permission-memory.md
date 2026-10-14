# Remember the native-chat permission choice

The OPL enhancement stores the last explicit built-in permission preset selected in a volatile `opl-suite` setting and applies it only when a genuinely new native Session is created. Initial permission pinning and seeded Sessions are excluded so imported external Harness records cannot inherit a later native-chat choice. The setting is updated through the public settings mutation API and the official `permission/preset` event; unsupported `custom` and `auto` values are never persisted as a future default.
