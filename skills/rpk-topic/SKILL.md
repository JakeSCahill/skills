---
name: rpk-topic
description: >-
  Manage Redpanda topics and produce or consume records from the CLI with the
  `rpk topic` command group, including Tiered Storage, Cloud Topic, and Remote
  Read Replica topic settings and Schema Registry encoding and decoding. Use
  when creating, altering, trimming, or deleting topics, inspecting storage with
  describe-storage, or producing and consuming records with rpk. For Cloud login
  and profile setup, see /redpanda:rpk-cloud, and for Schema Registry subjects
  and schemas, see /redpanda:rpk-registry.
---

# rpk topic

`rpk topic` creates, inspects, alters, and deletes topics and produces and
consumes records over the Kafka API, using the active rpk profile or `-X` flags.
This skill keeps only the product-specific procedure below. Look up everything
else in the docs (last section).

## How to work

1. **Target many topics by pattern with `-r`, and preview the match first.**
   `rpk topic alter-config` and `rpk topic delete` take `-r/--regex`, which
   wraps each expression in `^` and `$` (so `events-` alone matches only a
   topic named exactly `events-`; write `'events-.*'`). Run
   `rpk topic list -r '<expr>'` with the same expression first, check the
   matched set with the user if it is not what they described, then run the
   change once with `-r` instead of looping over topic names.
2. **To send each record to a partition parsed from the input, pass `-p` too.**
   `rpk topic produce -f '%p %v\n'` uses the parsed `%p` only when a
   non-negative `-p/--partition` is also given (any value, for example `-p 0`);
   the parsed value then wins. Without `-p`, records go wherever the default
   partitioner puts them and rpk reports no error.
3. **When Schema Registry decoding or encoding fails with `unable to determine
   schema context for topic`, pass `--schema-context` instead of changing
   ACLs.** Without that flag, `consume --use-schema-registry` and `produce
   --schema-id`/`--schema-key-id` first read the topic's
   `redpanda.schema.registry.context` config with DescribeConfigs, and exit if
   that request fails (for example `TOPIC_AUTHORIZATION_FAILED` for an account
   that can read the topic but not describe its configs). Setting
   `--schema-context` skips the lookup: `--schema-context ''` or
   `--schema-context .` selects the default context, or name the context the
   topic uses. Ask the user which context only if they have not said.

## Use the docs for everything else

Look up flags, defaults, format tokens, offset syntax, topic properties, and
procedures in the Redpanda docs instead of from memory:

- Follow `/redpanda:redpanda-docs`. Self-managed topic behavior changes between
  releases, so first get the cluster's version from `rpk version` (the "Redpanda
  Cluster" lines, not the rpk version), then pass `platform` and `version` to
  `ask_redpanda_question`, or read the `/streaming/<version>/` pages.
- Most useful pages: the rpk topic reference at
  https://docs.redpanda.com/streaming/current/reference/rpk/rpk-topic/rpk-topic/ (one
  page per subcommand) and the topic properties reference at
  https://docs.redpanda.com/streaming/current/reference/properties/topic-properties/.
  Swap `current` for the user's version.

`rpk topic <subcommand> --help` on the installed rpk is the live check for
flags in that version. `describe-storage` needs the Admin API, so it does not
work on Redpanda Cloud; every other `rpk topic` subcommand does.
