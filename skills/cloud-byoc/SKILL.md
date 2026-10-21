---
name: cloud-byoc
description: >-
  Provisions, changes, and tears down Redpanda Cloud BYOC (Bring Your Own Cloud) clusters
  through the Control Plane API and the `rpk cloud byoc` plugin, where the VPC, IAM roles,
  and storage stay in your own AWS, GCP, or Azure account. Use when creating or deleting a
  BYOC cluster or its Network, running `rpk cloud byoc` apply, destroy, or validate,
  scaling a BYOC cluster, editing its cloud provider tags or cluster properties, or
  configuring its private connectivity and listeners. For Serverless clusters, see
  `/redpanda:cloud-serverless`; for fully Redpanda-managed Dedicated clusters, see
  `/redpanda:cloud-dedicated`.
---

# Redpanda Cloud BYOC

A BYOC cluster is a Control Plane API resource (`TYPE_BYOC`, on a Network resource) plus an
agent that `rpk cloud byoc <aws|gcp|azure>` installs in your cloud account with Terraform.
Every create, update, and delete returns a long-running operation; poll
`GET /v1/operations/{id}` until `state` is `STATE_COMPLETED` or `STATE_FAILED`.

## How to work

**Check the zone count before a broker-count PATCH.** Before you send
`redpanda_node_count`, `GET` the cluster and count its `zones`. On a multi-zone cluster the
new count must be a multiple of the zone count, so "add one broker" to 3 brokers in 3 zones
is not a valid request. Do not send a count that is not a multiple. Tell the user the
nearest valid counts (here 6) and ask which one they want.

**Quote numbers in `custom_properties`.** When you build a create or PATCH body with
`cluster_configuration.custom_properties`, write every integer or number value as a JSON
string before you send it.

**Check prerequisites without a cluster.** To check a cloud account before anything exists
in Redpanda Cloud, run `rpk cloud byoc aws validate`. Do not create a cluster or
Network just to get an ID.

## Use the docs for everything else

Look up request bodies, field names, flags, network and connectivity setup, tier names,
error codes, and per-provider steps in the Redpanda docs, following `/redpanda:redpanda-docs`.
Pass `platform: "cloud"` to `ask_redpanda_question` so self-managed answers are left out, and
use `search_api_reference` and `get_api_reference_content` for Control Plane API endpoints and
schemas.

Start with:

- https://docs.redpanda.com/cloud-data-platform/manage/api/cloud-byoc-controlplane-api/
  (create, update, and delete a BYOC cluster through the API)
- https://docs.redpanda.com/cloud-data-platform/manage/cluster-maintenance/scale-cluster/
  (scaling rules and errors)
