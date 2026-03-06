# Roadmap

## Deferred Runtime Features

### Round-Level Parallel Orchestration

The top-level orchestrator still runs rounds sequentially. When this is implemented, the intended design is:

- keep phase-level `fanout` as the existing concurrency primitive inside a round
- add a separate round-level execution mode only for adapters that declare no cross-round dependencies
- preserve deterministic transcript ordering by merging parallel round outputs into the canonical round order before judge and synthesis stages run
- keep `failFast`, quality-gate, and judge behavior explicit so parallel scheduling does not hide or reorder failures

### Asymmetric Visibility Policies

`visibilityPolicy.participants` is currently a symmetric allowlist. The deferred design is:

- keep `participants` as the simple symmetric shorthand
- add explicit asymmetric `receiveFrom` and `publishTo` fields for phases that need one-way visibility
- validate all referenced agent ids during adapter schema validation
- render per-recipient transcript context without leaking unpublished turns to agents outside the permitted audience
