Save reusable combinations of model sources and execution engines, then use them in official DSH conversations.

Open **Settings → Execution**, or switch combinations in the conversation composer. Model sources retain credentials and model configuration. This plugin owns combinations, external-session bindings and execution records.

An independently configured native Provider receives a read-only DSH fallback when its model is available in the official catalog and has neither an official pairing nor an automatic external Harness recommendation. This fallback does not apply to OPL Gateway, OFM, or providers owned by external CLI accounts. It stores only the model reference and DSH binding: model connections, protocols, and credentials remain with their source owner. Existing defaults and explicit disable choices take precedence, and no external Harness is selected automatically.

External CLI programs must be available locally. Disabling this plugin stops external execution and its UI while retaining saved data. OPL Collaboration depends on this plugin. Official DSH retains native conversations, roles and permissions.

The dedicated MiniMax mcode integration is on by default and can be disabled on this page. Opting out removes its native provider, model and combination projections and the model-provider account card, and rejects new mcode turns without rerouting. Saved combinations, official credentials and conversation history are retained, including through unrelated catalog saves, and are restored when re-enabled. An owned in-flight browser sign-in is cooperatively cancelled.

Maintained by **One Person Lab**. [Project](https://github.com/gaofeng21cn/opl-dsh)
