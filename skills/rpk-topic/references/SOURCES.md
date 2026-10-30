# rpk topic Skill Source Map

The skill is thin: it keeps only the "How to work" procedure below, backed by a behavioral
eval case in `evals/suites/rpk-topic.eval.json`, and sends the agent to the docs for
everything else. This file maps only the claims the skill still makes.

The `rpk topic` command group lives in the **private** repo
`redpanda-data/streaming-enterprise`. Read it with `gh api` or the Redpanda-Github-Read
connector; do not clone it. Verify against the current stable release tag, not `dev`.
Paths below are relative to that repo.

## How to work: line, source, eval case

| How to work line | Source | Eval case |
|---|---|---|
| A parsed `%p` needs a non-negative `-p/--partition` as well, and the parsed value wins; without `-p` the default partitioner places records and rpk reports no error | `src/go/rpk/pkg/cli/topic/produce.go` (`partition >= 0` selects `kgo.ManualPartitioner()`; help text on `%p`) | `produce-parsed-partition-file` |

## Other claims in SKILL.md

| Claim | Source | Eval case |
|---|---|---|
| Get the cluster's version from `rpk version` (the "Redpanda Cluster" lines) before looking up topic behavior | `src/go/rpk/pkg/cli/version/versioncmd/versioncmd.go` (see `skills/redpanda-docs/references/SOURCES.md`) | none; a behavior with no case of its own (TODO below) |
| `describe-storage` needs the Admin API, so it does not work on Redpanda Cloud | `src/go/rpk/pkg/cli/topic/describe_storage.go` (`config.CheckExitCloudAdmin`) | none |

## TODO / re-verify

- The version-first instruction is a behavior without a behavioral case in the suite. Add a
  case that the baseline fails, or drop the instruction (maintainer decision).
